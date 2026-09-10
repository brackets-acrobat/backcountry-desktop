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

// Un TERRAIN ne se réduit pas à son point de référence : ses pistes et ses
// places s'en éloignent, parfois de plusieurs kilomètres. Le tester comme un
// point revient à faire disparaître toute une plate-forme dès que sa référence
// sort du cadre — ce qui arrive au premier panoramique dès le zoom 14.
//
// On élargit donc l'emprise du rayon propre au terrain avant de l'y chercher.
// Mesuré dans Cap CAVVA, la distance d'une référence à l'extrémité de piste la
// plus lointaine vaut 521 m en médiane, 4 km au 99,9e centile et 10 km au
// 99,99e — d'où un rayon calculé par terrain plutôt qu'une marge forfaitaire,
// qui trahirait aux deux bouts : trop courte pour les grandes plates-formes,
// trop large partout ailleurs.
function dansBboxElargi(item, bbox, margeM) {
  if (!(margeM > 0)) return dansBbox(item, bbox);
  const dLat = margeM / 111320;
  const cosL = Math.cos(item.lat * Math.PI / 180);
  const dLon = margeM / (111320 * (Math.abs(cosL) > 1e-6 ? Math.abs(cosL) : 1e-6));
  if (item.lat < bbox.south - dLat || item.lat > bbox.north + dLat) return false;
  return lonDansPlage(item.lon, bbox.west - dLon, bbox.east + dLon);
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

// ------------------------------------------------------------
// Détails d'un terrain : toutes ses pistes, avec leurs DEUX seuils
// ------------------------------------------------------------
//
// Repris de Cap CAVVA. Le cache d'aéroports ne retient d'une piste que le cap,
// la longueur et la surface — tout ce que le marqueur en montre. Le tour de
// piste, lui, se construit sur les COORDONNÉES DES DEUX SEUILS : le sens
// d'atterrissage et l'axe de piste en découlent. La donnée est dans le fichier,
// mais la garder en mémoire pour tous les terrains qui en ont doublerait le
// cache — payer le monde entier à chaque lancement pour un circuit tracé sur un
// terrain à la fois.
//
// On relit donc le fichier à la demande, EN BINAIRE : recherche d'octets de
// `"ident":"LFMD"`, puis décodage et analyse de CETTE ligne seule. Mesuré dans
// Cap CAVVA sur une base de 118 Mo : ~55 ms par appel, presque entièrement de
// la lecture. C'est l'ouverture d'une modale, pas une boucle de
// rafraîchissement : la relecture ne coûte rien de perceptible.
const OCTET_LF = 10;

// Ligne JSONL dont le champ `ident` vaut exactement `id`, ou null.
function ligneTerrain(buf, id) {
  // JSON.stringify fournit la forme ÉCHAPPÉE, guillemets compris : une aiguille
  // exacte quel que soit le contenu de l'ident. Le guillemet ouvrant écarte
  // `le_ident` et `he_ident`, dont l'octet précédent est un souligné.
  const aiguille = Buffer.from('"ident":' + JSON.stringify(id), 'utf-8');
  let i = buf.indexOf(aiguille);
  while (i >= 0) {
    let debut = buf.lastIndexOf(OCTET_LF, i);
    debut = debut < 0 ? 0 : debut + 1;
    let fin = buf.indexOf(OCTET_LF, i);
    if (fin < 0) fin = buf.length;
    let obj = null;
    try { obj = JSON.parse(buf.toString('utf-8', debut, fin)); } catch (_) { obj = null; }
    // L'aiguille peut tomber dans un autre champ de la ligne (le nom d'un
    // terrain, par exemple) : on ne retient que l'ident du terrain lui-même.
    if (obj && obj.ident === id) return obj;
    i = buf.indexOf(aiguille, fin);
  }
  return null;
}

// Pistes exploitables pour un tour de piste : ouvertes, et géolocalisées aux
// DEUX seuils. Une piste à un seul seuil connu ne donne pas d'axe.
function pistesGeolocalisees(runways) {
  const out = [];
  for (const r of (Array.isArray(runways) ? runways : [])) {
    if (r.closed) continue;
    if (!Number.isFinite(r.le_latitude_deg) || !Number.isFinite(r.le_longitude_deg)) continue;
    if (!Number.isFinite(r.he_latitude_deg) || !Number.isFinite(r.he_longitude_deg)) continue;
    out.push({
      le: r.le_ident || '?',
      he: r.he_ident || '?',
      leLat: r.le_latitude_deg, leLon: r.le_longitude_deg,
      heLat: r.he_latitude_deg, heLon: r.he_longitude_deg,
      longueurFt: Number.isFinite(r.length_ft) ? r.length_ft : null,
      // Largeur : le tracé à l'échelle en a besoin pour poser les deux bords
      // du rectangle. Le tour de piste, lui, l'ignore.
      largeurFt: Number.isFinite(r.width_ft) ? r.width_ft : null,
      surface: r.surface || '',
    });
  }
  return out;
}

function detailsAeroport(ident) {
  const id = String(ident == null ? '' : ident).trim();
  if (!id) return { ok: false, reason: 'no-ident' };
  let buf;
  try { buf = fs.readFileSync(path.join(dataDir(), 'airports-msfs.jsonl')); }
  catch (_) { return { ok: false, reason: 'no-data' }; }

  const a = ligneTerrain(buf, id);
  if (!a) return { ok: false, reason: 'not-found' };

  const code = (a.icao_code && String(a.icao_code).trim())
    || (a.gps_code && String(a.gps_code).trim())
    || (a.local_code && String(a.local_code).trim())
    || a.ident || '';
  const elev = parseFloat(a.elevation_ft);
  return {
    ok: true,
    airport: {
      ident: a.ident,
      code,
      name: a.name || a.ident,
      lat: parseFloat(a.latitude_deg),
      lon: parseFloat(a.longitude_deg),
      type: a.type,
      elevation_ft: Number.isFinite(elev) ? Math.round(elev) : null,
    },
    pistes: pistesGeolocalisees(a.runways),
    parkings: Array.isArray(a.parkings) ? a.parkings : [],
  };
}

// ------------------------------------------------------------
// Pistes d'une emprise : le tracé des pistes sur la carte
// ------------------------------------------------------------
//
// Deux accès à la même donnée, parce que ce ne sont pas les mêmes usages :
//
//   • detailsAeroport (tour de piste) interroge UN terrain, à l'ouverture d'une
//     modale. Relecture ciblée du fichier, rien en mémoire.
//
//   • pistesDansBbox (couche « pistes ») balaie une emprise à CHAQUE
//     déplacement de carte. Vingt relectures du fichier par panoramique
//     seraient absurdes : il faut un index.
//
// Mesuré dans Cap CAVVA : l'index pèse ~24 Mo et se bâtit en ~770 ms. Il n'est
// donc monté QUE si l'une des deux couches est allumée — qui ne trace ni pistes
// ni places ne paie rien. Ensuite, une emprise coûte ~7 ms.
let _pistes = null;   // Map ident -> { pistes, rayonPistesM, rayonParkingsM, aDesPlaces }

// Distance de la référence du terrain au point le plus lointain d'une liste.
// C'est de ce rayon qu'il faut élargir l'emprise pour ne pas perdre le terrain
// de vue quand on en regarde le bout.
function rayonDepuisReference(refLat, refLon, points) {
  const mLat = 111320;
  const mLon = 111320 * Math.max(1e-6, Math.abs(Math.cos(refLat * Math.PI / 180)));
  let r = 0;
  for (const [la, lo] of points) {
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const d = Math.hypot((lo - refLon) * mLon, (la - refLat) * mLat);
    if (d > r) r = d;
  }
  return r;
}

// Un seul balayage du fichier sert les deux couches. Mesurer l'étendue des
// places pendant qu'on y est ne coûte rien — la ligne est déjà lue et analysée
// — et évite d'avoir à DEVINER une marge forfaitaire.
function chargerIndexPistes() {
  if (_pistes) return _pistes;
  const m = new Map();
  for (const a of lireJsonl(path.join(dataDir(), 'airports-msfs.jsonl'))) {
    if (!a || !a.ident) continue;
    const ps = pistesGeolocalisees(a.runways);
    const parkings = Array.isArray(a.parkings) ? a.parkings : [];
    // Un terrain sans piste géolocalisée NI place n'a rien à faire dans l'index.
    if (!ps.length && !parkings.length) continue;
    const lat = parseFloat(a.latitude_deg), lon = parseFloat(a.longitude_deg);
    const bon = Number.isFinite(lat) && Number.isFinite(lon);
    const seuils = [];
    for (const p of ps) { seuils.push([p.leLat, p.leLon]); seuils.push([p.heLat, p.heLon]); }
    m.set(a.ident, {
      pistes: ps,
      rayonPistesM: bon ? rayonDepuisReference(lat, lon, seuils) : 0,
      rayonParkingsM: bon
        ? rayonDepuisReference(lat, lon, parkings.map((q) => [q.latitude_deg, q.longitude_deg]))
        : 0,
      aDesPlaces: parkings.length > 0,
    });
  }
  _pistes = m;
  return _pistes;
}

// Terrains de l'emprise qui ont au moins une piste exploitable, avec leurs
// pistes. Le renderer n'a besoin de rien d'autre pour dessiner : les seuils
// portent à la fois la position, la longueur et l'orientation.
function pistesDansBbox(bbox) {
  if (!bbox) return { ok: false, reason: 'no-bbox' };
  const all = chargerAeroports();
  if (!all.length) return { ok: false, reason: 'no-data' };
  const idx = chargerIndexPistes();
  const terrains = [];
  for (const a of all) {
    const e = idx.get(a.ident);
    if (!e || !e.pistes.length) continue;
    if (!dansBboxElargi(a, bbox, e.rayonPistesM)) continue;
    terrains.push({ ident: a.ident, code: a.code, name: a.name, type: a.type, pistes: e.pistes });
  }
  return { ok: true, terrains };
}

// ------------------------------------------------------------
// Places de stationnement d'une emprise
// ------------------------------------------------------------
//
// Troisième accès à la base, et troisième structure — pour une troisième façon
// d'y entrer. Les places ne s'affichent qu'au zoom 15, où la fenêtre couvre
// trois kilomètres : un ou deux terrains, jamais davantage. Les garder toutes
// en mémoire serait payer des centaines de milliers de places pour en montrer
// trente. On relit donc le fichier, une fois pour toute l'emprise, et on n'y
// cherche que les terrains visibles — puis on garde ce qu'on a lu, car au
// zoom 15 le panoramique suivant regarde le même terrain.
//
// Plafond de terrains lus en une fois. Il ne vide pas la couche quand il est
// atteint : on garde les PLUS PROCHES du centre de l'écran. Autour de Los
// Angeles, trente-trois terrains se pressent dans huit kilomètres — presque
// tous des hélistations. Les écarter d'un bloc éteindrait les places de LAX,
// c'est-à-dire précisément celles qu'on regarde.
const PARKINGS_MAX_TERRAINS = 24;

// Places déjà lues, par terrain. Au zoom 15 on tourne autour d'UN terrain : sans
// ce cache, chaque panoramique relirait le fichier entier. Plafonné, car un
// grand terrain pèse quelques centaines de places.
const PARKINGS_CACHE_MAX = 32;
const _parkingsCache = new Map();   // ident -> tableau de places (null = terrain sans champ)

function parkingsDeTerrain(buf, ident) {
  if (_parkingsCache.has(ident)) return _parkingsCache.get(ident);
  if (!buf) return undefined;   // garde-fou : rien à lire sans tampon
  const o = ligneTerrain(buf, ident);
  // null = terrain introuvable : on ne met rien en cache, la base peut changer.
  if (!o) return null;
  const ps = Array.isArray(o.parkings) ? o.parkings : null;
  if (_parkingsCache.size >= PARKINGS_CACHE_MAX) {
    _parkingsCache.delete(_parkingsCache.keys().next().value);   // la plus ancienne
  }
  _parkingsCache.set(ident, ps);
  return ps;
}

function parkingsDansBbox(bbox) {
  if (!bbox) return { ok: false, reason: 'no-bbox' };
  const all = chargerAeroports();
  if (!all.length) return { ok: false, reason: 'no-data' };

  // Même correction que pour les pistes : on cherche les terrains dans une
  // emprise élargie de leur propre rayon, sans quoi les places s'éteignent dès
  // que la référence du terrain sort du cadre.
  //
  // L'index des pistes est bâti au besoin : qui regarde les places d'une
  // plate-forme regarde ses pistes juste avant.
  const idx = chargerIndexPistes();
  let vises = [];
  for (const a of all) {
    const e = idx.get(a.ident);
    if (!e || !e.aDesPlaces) continue;   // inutile d'aller lire un terrain sans place
    if (!dansBboxElargi(a, bbox, e.rayonParkingsM)) continue;
    vises.push(a);
  }
  if (!vises.length) return { ok: true, terrains: [], baseSansParkings: idx.size > 0 && !_baseADesPlaces(idx) };

  // Au-delà du plafond, on garde les plus proches du centre de la vue plutôt
  // que de tout éteindre.
  let tropDeTerrains = false;
  if (vises.length > PARKINGS_MAX_TERRAINS) {
    tropDeTerrains = true;
    const cLat = (bbox.south + bbox.north) / 2;
    const cLon = (bbox.west + bbox.east) / 2;
    const cosL = Math.max(1e-6, Math.abs(Math.cos(cLat * Math.PI / 180)));
    vises.sort((x, y) => {
      const dx = Math.hypot((x.lon - cLon) * cosL, x.lat - cLat);
      const dy = Math.hypot((y.lon - cLon) * cosL, y.lat - cLat);
      return dx - dy;
    });
    vises = vises.slice(0, PARKINGS_MAX_TERRAINS);
  }

  // Le fichier n'est relu que s'il reste un terrain hors cache.
  let buf = null;
  const aLire = vises.some((a) => !_parkingsCache.has(a.ident));
  if (aLire) {
    try { buf = fs.readFileSync(path.join(dataDir(), 'airports-msfs.jsonl')); }
    catch (_) { return { ok: false, reason: 'no-data' }; }
  }

  const terrains = [];
  for (const a of vises) {
    const ps = parkingsDeTerrain(buf, a.ident);
    if (!ps || !ps.length) continue;
    // lat/lon : le point de référence du terrain. Il sert d'ancre au décalage de
    // monde côté carte — toute l'aire doit tenir dans la même copie.
    terrains.push({ ident: a.ident, code: a.code, name: a.name, lat: a.lat, lon: a.lon, parkings: ps });
  }
  return { ok: true, terrains, tropDeTerrains, baseSansParkings: false };
}

// Aucune place NULLE PART dans l'index = base antérieure à leur extraction. Ce
// n'est pas « aucune place ici », c'est « cette base n'en contient pas » : les
// deux se disent autrement à l'écran, d'où le drapeau. La réponse est mémorisée,
// l'index ne changeant qu'à un import.
let _sansPlaces = null;
function _baseADesPlaces(idx) {
  if (_sansPlaces !== null) return !_sansPlaces;
  for (const [, e] of idx) if (e.aDesPlaces) { _sansPlaces = false; return true; }
  _sansPlaces = true;
  return false;
}

// Invalide les caches (après un import) → rechargés à la prochaine requête.
// _index en fait partie : il est bâti SUR ces caches, le laisser survivre à un
// import ferait chercher dans l'ancienne base.
function reload() {
  _airports = null; _navaids = null; _index = null; _addons = null;
  _pistes = null; _parkingsCache.clear(); _sansPlaces = null;
}

// Après un scan d'add-ons : seul addons.json a changé, inutile de relire les
// dizaines de Mo de la base.
function rechargerAddons() { _addons = null; }

module.exports = {
  aeroportsDansBbox, navaidsDansBbox, aeroportParCode, rechercherLieux, featureProche,
  detailsAeroport, pistesDansBbox, parkingsDansBbox,
  chargerAeroports, rechargerAddons, reload,
};
