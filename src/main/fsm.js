/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// fsm.js — machine à états du poser de brousse.
//
// Spec (décidée 20/06/2026) : TOUT est relevé une fois au sol.
//   - Déclencheur = LE POSER (on était en l'air, SIM ON GROUND repasse à 1).
//   - Dès le poser, on échantillonne TOUTES LES 0,5 s jusqu'à immobilisation
//     totale de l'avion :
//       · latitude/longitude (point de poser = représentant du lieu)
//       · relief du terrain (GROUND ALTITUDE) sur toute la longueur du roulage
//       · altitude moyenne du terrain
//       · type de sol / état de sol (mode sur le roulage)
//       · cap moyen (moyenne circulaire) depuis le poser jusqu'à ce que la
//         vitesse sol descende sous 20 kt
//   - Une fois le FREIN DE PARKING tiré → on émet 'awaiting-decision' avec le
//     relevé assemblé. Le renderer ouvre la modale Enregistrer / Ne pas
//     enregistrer (la confirmation et l'envoi/effacement sont pilotés côté UI).
//
// Module découplé de l'IPC (comme logbook.js de NavXpress) : il reçoit les
// trames via feed() et émet via le callback emit fourni à la création.
// emit(event, payload), event ∈ 'touchdown' | 'progress' | 'stopped' | 'awaiting-decision'.
// ============================================================

const { randomUUID } = require('crypto');
const { distanceM, analyserPente } = require('./math-engine');

const FT_PER_M = 3.280839895;
const SAMPLE_MS = 500;          // cadence d'échantillonnage du roulage
const AIRBORNE_AGL_FT = 15;     // considéré « en vol » au-dessus de cette hauteur-sol
const HEADING_CUTOFF_KT = 20;   // on cesse de moyenner le cap sous cette vitesse
const STOP_KT = 0.5;            // seuil d'immobilisation
const STOP_HOLD_MS = 1500;      // maintien pour confirmer l'arrêt total

const degToRad = (d) => (d * Math.PI) / 180;
const radToDeg = (r) => (r * 180) / Math.PI;

// Clé la plus fréquente d'un dictionnaire de comptes ({ libellé: n }).
function mode(counts) {
  let best = null; let bestN = -1;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

function createFsm({ emit = () => {} } = {}) {
  let state = 'IDLE';   // IDLE | ROLLING | STOPPED | PENDING
  let airborne = false;
  let session = null;
  let lastSampleT = 0;
  let stopSince = 0;

  function newSession(f) {
    return {
      uid: randomUUID(),
      touchdownLat: f.lat,
      touchdownLon: f.lon,
      simLocal: f.simLocal || null,    // heure sim LOCALE du poser
      lastLat: f.lat,
      lastLon: f.lon,
      distCumM: 0,
      lastPushedD: -1,
      profil: [],                       // [{ d (m), alt (m) }]
      altSumM: 0, altCount: 0,
      hdgSin: 0, hdgCos: 0, hdgCount: 0, hdgLocked: false,
      surfType: {}, surfCond: {},
    };
  }

  // Enregistre un échantillon (toutes les 0,5 s pendant le roulage).
  function sample(f) {
    const s = session;
    s.distCumM += distanceM(s.lastLat, s.lastLon, f.lat, f.lon);
    s.lastLat = f.lat;
    s.lastLon = f.lon;

    const altM = f.groundAltFt / FT_PER_M;
    const d = Math.round(s.distCumM);
    // Évite les points dupliqués (avion quasi immobile en fin de roulage).
    if (d !== s.lastPushedD) {
      s.profil.push({ d, alt: Math.round(altM) });
      s.lastPushedD = d;
    }
    s.altSumM += altM; s.altCount++;

    // Cap moyen (moyenne circulaire) tant que vitesse ≥ 20 kt.
    if (!s.hdgLocked) {
      if (f.groundSpeedKt >= HEADING_CUTOFF_KT) {
        const r = degToRad(f.headingTrue);
        s.hdgSin += Math.sin(r); s.hdgCos += Math.cos(r); s.hdgCount++;
      } else if (s.hdgCount > 0) {
        s.hdgLocked = true;   // on est passé sous 20 kt après avoir accumulé
      }
    }

    // Type / état de sol : on retient le plus fréquent du roulage.
    s.surfType[f.surfaceTypeLabel] = (s.surfType[f.surfaceTypeLabel] || 0) + 1;
    s.surfCond[f.surfaceCondLabel] = (s.surfCond[f.surfaceCondLabel] || 0) + 1;
  }

  // Assemble le relevé prêt à envoyer (payload API, sans uid).
  function buildReleve() {
    const s = session;
    const avgAltM = s.altCount ? s.altSumM / s.altCount : null;

    let cap = null;
    if (s.hdgCount > 0) {
      let a = radToDeg(Math.atan2(s.hdgSin, s.hdgCos));
      if (a < 0) a += 360;
      cap = Math.round(a * 10) / 10;
    }

    // Dénivelé + pente max dérivés du même profil de relief.
    const pente = analyserPente(s.profil.map((p) => ({ distM: p.d, altFt: p.alt * FT_PER_M })));

    return {
      latitude: Math.round(s.touchdownLat * 1e6) / 1e6,
      longitude: Math.round(s.touchdownLon * 1e6) / 1e6,
      date_releve: s.simLocal,                       // null → le serveur met l'heure de réception
      altitude_m: avgAltM != null ? Math.round(avgAltM) : null,
      type_surface: mode(s.surfType),
      etat_surface: mode(s.surfCond),
      cap_moyen_deg: cap,
      denivele_m: Math.round(pente.deniveleM),
      pente_max_pct: Math.round(pente.penteMaxPct * 10) / 10,
      profil_relief: s.profil,
    };
  }

  function progress() {
    emit('progress', {
      uid: session.uid,
      state,
      samples: session.profil.length,
      distM: Math.round(session.distCumM),
    });
  }

  function finalize(f) {
    sample(f);                       // dernier échantillon au moment du frein
    state = 'PENDING';
    emit('awaiting-decision', { uid: session.uid, releve: buildReleve() });
  }

  return {
    get state() { return state; },

    feed(f) {
      if (!f) return;

      // Suivi « en vol » : nécessaire pour qualifier le prochain contact de poser.
      if (!f.onGround && f.aglFt > AIRBORNE_AGL_FT) airborne = true;

      if (state === 'IDLE') {
        if (airborne && f.onGround) {           // POSER détecté
          session = newSession(f);
          state = 'ROLLING';
          airborne = false;
          stopSince = 0;
          sample(f);
          lastSampleT = f.t;
          emit('touchdown', { uid: session.uid });
          progress();
        }
        return;
      }

      // Frein de parking tiré à l'arrêt → décision (depuis ROLLING ou STOPPED).
      if ((state === 'ROLLING' || state === 'STOPPED')
          && f.parkingBrake && f.onGround && f.groundSpeedKt < 1) {
        finalize(f);
        return;
      }

      if (state === 'ROLLING') {
        // Échantillonnage 0,5 s (on continue même en cas de rebond bref).
        if (f.t - lastSampleT >= SAMPLE_MS) {
          sample(f);
          lastSampleT = f.t;
          progress();
        }
        // Immobilisation totale : au sol + vitesse ~0 maintenue.
        if (f.onGround && f.groundSpeedKt < STOP_KT) {
          if (stopSince === 0) stopSince = f.t;
          else if (f.t - stopSince >= STOP_HOLD_MS) {
            state = 'STOPPED';
            emit('stopped', { uid: session.uid });
          }
        } else {
          stopSince = 0;
        }
        return;
      }

      // STOPPED : on attend le frein de parking (géré par le bloc ci-dessus).
      // PENDING : on attend la décision du renderer (finalize/discard), rien à faire.
    },

    // Réinitialise après décision (envoi réussi ou effacement confirmé).
    reset() {
      state = 'IDLE';
      airborne = false;
      session = null;
      stopSince = 0;
      lastSampleT = 0;
    },
  };
}

module.exports = { createFsm };
