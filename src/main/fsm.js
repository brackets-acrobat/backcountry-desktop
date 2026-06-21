/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// fsm.js — machine à états du poser de brousse (modèle « envoi groupé »).
//
// Flux (décidé 21/06/2026) :
//   - À chaque POSER (on était en l'air, SIM ON GROUND repasse à 1), on
//     échantillonne le roulage toutes les 0,5 s jusqu'à l'arrêt, puis on
//     FINALISE un relevé (lat/lon, profil de relief, altitude moyenne,
//     type/état de sol, cap moyen jusqu'à < 20 kt) qu'on AJOUTE à la liste
//     des posers du vol (rien n'est envoyé tout de suite).
//   - Le poser « courant » (le dernier finalisé) porte un uid : c'est lui que
//     le bouton « Capture d'écran » utilisera. Le bouton n'est ACTIF que si
//     posé + vitesse nulle + frein de parking → événement 'capture-state'.
//   - FIN DE VOL = au sol + vitesse nulle + frein + MOTEUR ÉTEINT → on émet
//     'flight-ended' avec tous les posers du vol → le renderer ouvre la modale
//     d'envoi groupé.
//
// Découplé de l'IPC : feed(frame) en entrée, emit(event, payload) en sortie.
// Événements : 'landing-recorded' | 'capture-state' | 'flight-ended'.
// ============================================================

const { randomUUID } = require('crypto');
const { distanceM, analyserPente } = require('./math-engine');

const FT_PER_M = 3.280839895;
const SAMPLE_MS = 500;
const AIRBORNE_AGL_FT = 15;
const HEADING_CUTOFF_KT = 20;
const STOP_KT = 0.5;
const STOP_HOLD_MS = 1500;

const degToRad = (d) => (d * Math.PI) / 180;
const radToDeg = (r) => (r * 180) / Math.PI;

function mode(counts) {
  let best = null; let bestN = -1;
  for (const [k, n] of Object.entries(counts)) { if (n > bestN) { best = k; bestN = n; } }
  return best;
}

function createFsm({ emit = () => {} } = {}) {
  let airborne = false;
  let session = null;          // session de roulage en cours
  let lastSampleT = 0;
  let stopSince = 0;
  let pending = [];            // posers finalisés du vol : { uid, releve, hasCapture }
  let currentUid = null;       // poser courant (cible du bouton capture)
  let lastCanCapture = null;
  let flightEnded = false;

  function newSession(f) {
    return {
      uid: randomUUID(),
      touchdownLat: f.lat, touchdownLon: f.lon,
      simLocal: f.simLocal || null,
      aeronef: (f.aircraftTitle || '').trim() || null,
      lastLat: f.lat, lastLon: f.lon, distCumM: 0, lastPushedD: -1,
      profil: [], altSumM: 0, altCount: 0,
      hdgSin: 0, hdgCos: 0, hdgCount: 0, hdgLocked: false,
      surfType: {}, surfCond: {},
    };
  }

  function sample(f) {
    const s = session;
    s.distCumM += distanceM(s.lastLat, s.lastLon, f.lat, f.lon);
    s.lastLat = f.lat; s.lastLon = f.lon;
    const altM = f.groundAltFt / FT_PER_M;
    const d = Math.round(s.distCumM);
    if (d !== s.lastPushedD) { s.profil.push({ d, alt: Math.round(altM) }); s.lastPushedD = d; }
    s.altSumM += altM; s.altCount++;
    if (!s.hdgLocked) {
      if (f.groundSpeedKt >= HEADING_CUTOFF_KT) {
        const r = degToRad(f.headingTrue);
        s.hdgSin += Math.sin(r); s.hdgCos += Math.cos(r); s.hdgCount++;
      } else if (s.hdgCount > 0) { s.hdgLocked = true; }
    }
    s.surfType[f.surfaceTypeLabel] = (s.surfType[f.surfaceTypeLabel] || 0) + 1;
    s.surfCond[f.surfaceCondLabel] = (s.surfCond[f.surfaceCondLabel] || 0) + 1;
  }

  function buildReleve() {
    const s = session;
    const avgAltM = s.altCount ? s.altSumM / s.altCount : null;
    let cap = null;
    if (s.hdgCount > 0) {
      let a = radToDeg(Math.atan2(s.hdgSin, s.hdgCos));
      if (a < 0) a += 360;
      cap = Math.round(a * 10) / 10;
    }
    const pente = analyserPente(s.profil.map((p) => ({ distM: p.d, altFt: p.alt * FT_PER_M })));
    return {
      latitude: Math.round(s.touchdownLat * 1e6) / 1e6,
      longitude: Math.round(s.touchdownLon * 1e6) / 1e6,
      date_releve: s.simLocal,
      altitude_m: avgAltM != null ? Math.round(avgAltM) : null,
      type_surface: mode(s.surfType),
      etat_surface: mode(s.surfCond),
      cap_moyen_deg: cap,
      denivele_m: Math.round(pente.deniveleM),
      pente_max_pct: Math.round(pente.penteMaxPct * 10) / 10,
      aeronef: s.aeronef,
      profil_relief: s.profil,
    };
  }

  function finalize() {
    const uid = session.uid;
    pending.push({ uid, releve: buildReleve(), hasCapture: false });
    currentUid = uid;
    session = null;
    stopSince = 0;
    emit('landing-recorded', { uid, count: pending.length });
  }

  function updateCaptureState(f) {
    const can = !!currentUid && f.onGround && f.groundSpeedKt < STOP_KT && f.parkingBrake;
    if (can !== lastCanCapture) {
      lastCanCapture = can;
      emit('capture-state', { canCapture: can, uid: currentUid });
    }
  }

  return {
    get state() { return session ? 'ROLLING' : (pending.length ? 'LANDED' : 'IDLE'); },
    get pending() { return pending; },
    currentUid() { return currentUid; },

    feed(f) {
      if (!f) return;

      if (!f.onGround && f.aglFt > AIRBORNE_AGL_FT) {
        airborne = true;
        flightEnded = false;          // un nouveau vol est en cours
      }

      // POSER : on touche le sol après avoir été en l'air → nouvelle session.
      if (airborne && f.onGround && !session) {
        session = newSession(f);
        airborne = false;
        currentUid = null;            // bouton capture désactivé pendant le roulage
        stopSince = 0;
        sample(f);
        lastSampleT = f.t;
      } else if (session) {
        // Roulage : échantillonnage 0,5 s.
        if (f.t - lastSampleT >= SAMPLE_MS) { sample(f); lastSampleT = f.t; }
        // Arrêt : vitesse ~0 maintenue, OU frein tiré à l'arrêt → finalisation.
        if (f.onGround && f.groundSpeedKt < STOP_KT) {
          if (stopSince === 0) stopSince = f.t;
          if (f.parkingBrake || f.t - stopSince >= STOP_HOLD_MS) { sample(f); finalize(); }
        } else {
          stopSince = 0;
        }
      }

      updateCaptureState(f);

      // FIN DE VOL : au sol + arrêté + frein + moteur éteint, avec des posers.
      if (!flightEnded && pending.length > 0
          && f.onGround && f.groundSpeedKt < STOP_KT && f.parkingBrake && !f.engineOn) {
        flightEnded = true;
        emit('flight-ended', {
          landings: pending.map((p) => ({ uid: p.uid, releve: p.releve, hasCapture: p.hasCapture })),
        });
      }
    },

    // Marque un poser comme ayant une capture (appelé après screenshot).
    markCaptured(uid) {
      const p = pending.find((x) => x.uid === uid);
      if (p) { p.hasCapture = true; return true; }
      return false;
    },

    reset() {
      airborne = false; session = null; lastSampleT = 0; stopSince = 0;
      pending = []; currentUid = null; lastCanCapture = null; flightEnded = false;
    },
  };
}

module.exports = { createFsm };
