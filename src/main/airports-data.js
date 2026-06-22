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

// Invalide les caches (après un import) → rechargés à la prochaine requête.
function reload() { _airports = null; _navaids = null; }

module.exports = { aeroportsDansBbox, navaidsDansBbox, reload };
