/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// airports-data.js — lecture des bases MSFS extraites (airports-msfs.jsonl /
// navaids.jsonl) et requêtes par bounding box pour la carte.
//
// Logique reprise de NavXpressVFR (même filtrage de types, même choix de la
// piste principale, même test d'appartenance à la bbox avec antiméridien).
// Chargement paresseux + cache, invalidé par reload() après un import.
// ============================================================

const fs = require('fs');
const path = require('path');
const { dossierBase } = require('./config');

const TYPES_OK = new Set(['large_airport', 'medium_airport', 'small_airport', 'heliport', 'seaplane_base']);
const NAVAID_TYPES = new Set(['VOR', 'VOR-DME', 'VORTAC', 'TACAN', 'NDB', 'NDB-DME', 'DME']);

let _airports = null;   // [{ident, code, name, lat, lon, type, runway}]
let _navaids = null;    // [{id, ident, name, type, lat, lon, freqKhz, rangeNm}]

function dataDir() { return path.join(dossierBase(), 'data'); }

// Lit un fichier .jsonl ligne par ligne (ignore l'en-tête __meta et le vide).
function* lireJsonl(p) {
  let brut;
  try { brut = fs.readFileSync(p, 'utf-8'); } catch (_) { return; }
  for (const ligne of brut.split('\n')) {
    const s = ligne.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch (_) { continue; }
    if (obj && obj.__meta) continue;
    yield obj;
  }
}

// Piste principale = la plus longue dotée d'un cap (comme NavXpress).
function pistePrincipale(runways) {
  if (!Array.isArray(runways) || runways.length === 0) return null;
  let best = null;
  for (const r of runways) {
    if (r.closed) continue;
    if (r.headingDegT === null || r.headingDegT === undefined) continue;
    if (!best || (r.length_ft || 0) > (best.length_ft || 0)) best = r;
  }
  return best;
}

function chargerAeroports() {
  if (_airports) return _airports;
  const list = [];
  for (const a of lireJsonl(path.join(dataDir(), 'airports-msfs.jsonl'))) {
    if (!TYPES_OK.has(a.type)) continue;
    const lat = parseFloat(a.latitude_deg);
    const lon = parseFloat(a.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // POI MSFS (stades, ponts…) exposés en « airport » sans piste ni hélipad → exclus.
    const rws = Array.isArray(a.runways) ? a.runways : [];
    const nbHelipads = Array.isArray(a.helipads) ? a.helipads.length : 0;
    if (rws.length === 0 && nbHelipads === 0) continue;

    const runway = pistePrincipale(rws);
    const code = (a.icao_code && String(a.icao_code).trim())
      || (a.gps_code && String(a.gps_code).trim())
      || (a.local_code && String(a.local_code).trim())
      || a.ident || '';

    const elev = parseFloat(a.elevation_ft);
    list.push({
      ident: a.ident,
      code,
      name: a.name || a.ident,
      lat, lon,
      type: a.type,
      elevation_ft: Number.isFinite(elev) ? Math.round(elev) : null,
      runway: runway ? {
        name: runway.le_ident + (runway.he_ident ? '/' + runway.he_ident : ''),
        headingDegT: runway.headingDegT,
        length_ft: runway.length_ft,
        surface: runway.surface || '',
      } : null,
    });
  }
  _airports = list;
  return _airports;
}

function chargerNavaids() {
  if (_navaids) return _navaids;
  const list = [];
  for (const n of lireJsonl(path.join(dataDir(), 'navaids.jsonl'))) {
    if (!NAVAID_TYPES.has(n.type)) continue;
    const lat = parseFloat(n.latitude_deg);
    const lon = parseFloat(n.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const rng = parseFloat(n.range_nm);
    list.push({
      id: n.id,
      ident: n.ident,
      name: n.name || n.ident,
      type: n.type,
      lat, lon,
      freqKhz: parseFloat(n.frequency_khz) || 0,
      rangeNm: Number.isFinite(rng) ? rng : null,
    });
  }
  _navaids = list;
  return _navaids;
}

// Appartenance d'une longitude à la plage [west, east] (gère l'antiméridien et
// le défilement infini de Leaflet : west peut être > east).
function lonDansPlage(lon, west, east) {
  let width = east - west;
  if (width < 0) width += 360;
  if (width >= 360) return true;
  const delta = (((lon - west) % 360) + 360) % 360;
  return delta <= width;
}

function dansBbox(item, bbox) {
  if (item.lat < bbox.south || item.lat > bbox.north) return false;
  return lonDansPlage(item.lon, bbox.west, bbox.east);
}

function aeroportsDansBbox(bbox) {
  if (!bbox) return { ok: false, reason: 'no-bbox' };
  const all = chargerAeroports();
  if (!all.length) return { ok: false, reason: 'no-data' };
  return { ok: true, airports: all.filter((a) => dansBbox(a, bbox)) };
}

function navaidsDansBbox(bbox) {
  if (!bbox) return { ok: false, reason: 'no-bbox' };
  const all = chargerNavaids();
  if (!all.length) return { ok: false, reason: 'no-data' };
  return { ok: true, navaids: all.filter((n) => dansBbox(n, bbox)) };
}

// Recherche un aéroport par code (ICAO/GPS/local) ou ident, insensible à la casse.
// Utilisé pour tracer la route départ → arrivée à partir des champs ICAO.
function aeroportParCode(code) {
  const c = String(code == null ? '' : code).trim().toUpperCase();
  if (!c) return { ok: false, reason: 'no-code' };
  const all = chargerAeroports();
  if (!all.length) return { ok: false, reason: 'no-data' };
  const a = all.find((x) => String(x.code || '').toUpperCase() === c)
         || all.find((x) => String(x.ident || '').toUpperCase() === c);
  if (!a) return { ok: false, reason: 'not-found' };
  return { ok: true, airport: { code: a.code, ident: a.ident, name: a.name, lat: a.lat, lon: a.lon, type: a.type } };
}

// Distance grand cercle (NM) entre deux points.
function distNmEntre(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Cherche le feature (aéroport OU navaid) le plus proche d'un point, dans un
// rayon donné (NM). Sert à proposer d'aimanter un point tournant. Pré-filtre par
// latitude (gate large) pour éviter le haversine sur toute la base.
function featureProche(lat, lon, rayonNm) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false };
  const r = Number.isFinite(rayonNm) ? rayonNm : 0.2;
  let best = null;
  const examiner = (item, kind, code, type) => {
    if (Math.abs(item.lat - lat) > 0.05) return;   // ~3 NM : gate grossier
    const d = distNmEntre(lat, lon, item.lat, item.lon);
    if (d <= r && (!best || d < best.distNm)) {
      best = { kind, code: code || '', name: item.name, lat: item.lat, lon: item.lon, type: type || '', distNm: d };
    }
  };
  for (const a of chargerAeroports()) examiner(a, 'airport', a.code || a.ident, a.type);
  for (const n of chargerNavaids()) examiner(n, 'navaid', n.ident, n.type);
  return best ? { ok: true, found: true, feature: best } : { ok: true, found: false };
}

// Invalide les caches (après un import) → rechargés à la prochaine requête.
function reload() { _airports = null; _navaids = null; }

module.exports = { aeroportsDansBbox, navaidsDansBbox, aeroportParCode, featureProche, reload };
