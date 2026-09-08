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
let _addons = null;     // Set des codes fournis par un paquet add-on (addons.json)

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

// Codes des terrains fournis par un paquet add-on, écrits par addons-scan.js.
// Absence de fichier = personne n'a lancé l'analyse : ensemble vide, aucun
// marquage, et surtout aucune erreur — la carte doit marcher sans.
function chargerAddons() {
  if (_addons) return _addons;
  const set = new Set();
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(dataDir(), 'addons.json'), 'utf-8'));
    for (const code of Object.keys((obj && obj.aeroports) || {})) set.add(code.toUpperCase());
  } catch (_) {}
  _addons = set;
  return _addons;
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
  const vus = all.filter((a) => dansBbox(a, bbox));
  const addons = chargerAddons();
  if (!addons.size) return { ok: true, airports: vus };
  // Copie seulement les terrains marqués : la liste du cache doit rester intacte.
  return { ok: true, airports: vus.map((a) => (addons.has(String(a.code || a.ident).toUpperCase()) ? { ...a, addon: true } : a)) };
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
  return { ok: true, airport: { code: a.code, ident: a.ident, name: a.name, lat: a.lat, lon: a.lon, type: a.type, elevation_ft: a.elevation_ft } };
}

// ------------------------------------------------------------
// Recherche par code OACI ou par nom (bouton « Rechercher »)
// ------------------------------------------------------------
//
// Périmètre : le monde entier. L'index couvre l'intégralité des bases MSFS
// extraites, aérodromes comme navaids, sans restriction de pays ni d'emprise.
//
// Repli des diacritiques et de la casse : « Aérodrome » se trouve en tapant
// « aerodrome ». Personne ne saisit les accents dans un champ de recherche.
function plier(s) {
  // La classe \p{M} couvre les marques combinantes que NFD vient de détacher.
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
}

const RECHERCHE_MAX = 8;       // correspondances retenues au plus
const RECHERCHE_MIN_CAR = 2;   // en deçà, tout correspond : on ne cherche pas

// Index de recherche : codes et noms repliés UNE FOIS. Replier à chaque frappe
// coûterait deux normalize() par enregistrement — six chiffres d'appels pour un
// caractère tapé. Construit paresseusement, invalidé par reload() comme les
// caches de base.
let _index = null;

function chargerIndex() {
  if (_index) return _index;
  const idx = [];
  for (const a of chargerAeroports()) {
    idx.push({
      codes: [plier(a.code), plier(a.ident)],
      nom: plier(a.name),
      lieu: {
        genre: 'airport', code: a.code || a.ident, ident: a.ident, name: a.name,
        lat: a.lat, lon: a.lon, type: a.type, elevation_ft: a.elevation_ft, runway: a.runway,
      },
    });
  }
  for (const n of chargerNavaids()) {
    idx.push({
      codes: [plier(n.ident)],
      nom: plier(n.name),
      lieu: {
        genre: 'navaid', code: n.ident, ident: n.ident, name: n.name,
        lat: n.lat, lon: n.lon, type: n.type, freqKhz: n.freqKhz, rangeNm: n.rangeNm,
      },
    });
  }
  _index = idx;
  return _index;
}

// Rang d'une correspondance, du plus au moins pertinent. Le code exact passe
// devant tout : qui tape « LFMD » veut Cannes, pas les terrains dont le nom
// contient ces quatre lettres par accident.
//   0 code exact · 1 code commençant par · 2 nom commençant par · 3 nom contenant
function rangCorrespondance(q, codes, nom) {
  for (const c of codes) if (c === q) return 0;
  for (const c of codes) if (c.startsWith(q)) return 1;
  if (nom.startsWith(q)) return 2;
  if (nom.includes(q)) return 3;
  return -1;
}

// Ordre d'affichage : le rang d'abord, puis l'alphabet — l'ordre du fichier
// d'import n'a aucun sens pour qui lit la liste.
function meilleurQue(a, b) {
  if (a.rang !== b.rang) return a.rang < b.rang;
  return a.lieu.name.localeCompare(b.lieu.name, 'fr') < 0;
}

// L'index couvrant le monde, une saisie courte (« LA », « SA ») correspond à des
// dizaines de milliers d'entrées. On ne les collecte donc pas : on tient un
// palmarès borné à `max`, maintenu trié par insertion. Une correspondance moins
// bonne que la dernière retenue est écartée sans autre calcul — et ce test se
// tranche sur le rang seul dans l'immense majorité des cas, donc sans payer le
// localeCompare. Le balayage, lui, reste complet : c'est ce qui donne `total`,
// et il ne coûte qu'un startsWith/includes par entrée.
function rechercherLieux(requete, limite) {
  const q = plier(requete).trim();
  if (q.length < RECHERCHE_MIN_CAR) return { ok: false, reason: 'too-short' };
  const idx = chargerIndex();
  if (!idx.length) return { ok: false, reason: 'no-data' };
  const max = Number.isFinite(limite) && limite > 0 ? limite : RECHERCHE_MAX;

  const trouves = [];
  let total = 0;
  for (const e of idx) {
    const rang = rangCorrespondance(q, e.codes, e.nom);
    if (rang < 0) continue;
    total++;
    const cand = { rang, lieu: e.lieu };
    if (trouves.length >= max && !meilleurQue(cand, trouves[trouves.length - 1])) continue;
    let i = trouves.length;
    while (i > 0 && meilleurQue(cand, trouves[i - 1])) i--;
    trouves.splice(i, 0, cand);
    if (trouves.length > max) trouves.pop();
  }

  return { ok: true, total, tronque: total > trouves.length, lieux: trouves.map((x) => x.lieu) };
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
// _index en fait partie : il est bâti SUR ces caches, le laisser survivre à un
// import ferait chercher dans l'ancienne base.
function reload() { _airports = null; _navaids = null; _index = null; _addons = null; }

// Après un scan d'add-ons : seul addons.json a changé, inutile de relire les
// dizaines de Mo de la base.
function rechargerAddons() { _addons = null; }

module.exports = {
  aeroportsDansBbox, navaidsDansBbox, aeroportParCode, rechercherLieux, featureProche,
  chargerAeroports, rechargerAddons, reload,
};
