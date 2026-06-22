/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 *
 * Moteur d'extraction des aéroports MSFS 2024 REPRIS À L'IDENTIQUE de
 * NavXpressVFR (même processus SimConnect / Facility API). Seuls l'en-tête, le
 * dossier de sortie par défaut et le nom d'app SimConnect diffèrent.
 */

/* ============================================================
 * Moteur d'extraction : base COMPLÈTE des aéroports MSFS 2024
 * ------------------------------------------------------------
 * Produit un fichier unique `airports-msfs.jsonl` (un aéroport
 * par ligne) dans  Documents/Backcountry Pathfinders/data/.
 * Ce fichier REMPLACE les données d'aéroports d'OurAirports
 * (les navaids restent sur OurAirports).
 *
 * Déroulé :
 *   Phase 1 — énumération : requestFacilitiesList(AIRPORT) →
 *             la liste MONDIALE (~85 694) avec icao/region/pos.
 *   Phase 2 — détail : pour chaque ICAO, requestFacilityData
 *             (fenêtré/throttlé) → pistes (QFU, cap vrai, long.,
 *             larg., surface, ILS, position du centre + seuils
 *             calculés), fréquences COM, hélipads.
 *
 * Chaque enregistrement utilise des noms de champs compatibles
 * OurAirports (ident/icao_code/type/name/latitude_deg/…) + des
 * tableaux imbriqués runways/frequencies/helipads. Le `type`
 * est DÉRIVÉ des pistes (pas fourni par le sim).
 *
 * Ce module est RÉUTILISABLE :
 *   - en CLI :  node extract-airports-msfs.js [--limit N] [--window N] [--out DIR]
 *   - dans l'app Electron : require('./extract-airports-msfs').runExtraction({...})
 *
 * Pré-requis : MSFS 2024 lancé, un vol en cours.
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  open: scOpen,
  Protocol: SCProtocol,
  FacilityListType,
  FacilityDataType,
} = require('node-simconnect');

// --------------------------------------------------------------
// Constantes
// --------------------------------------------------------------
const DEF_AIRPORT = 1000;
const REQ_LIST = 7000;

const LIST_INACTIVITY_MS = 12000;   // phase 1 close si plus rien depuis 12 s
const REQUEST_TIMEOUT_MS = 20000;   // une requête détail abandonnée après 20 s
const STALL_MS = 120000;            // aucune progression détail depuis 2 min → stop
const GLOBAL_TIMEOUT_MS = 60 * 60 * 1000; // garde-fou ultime : 60 min

const DEFAULT_OUT_DIR = path.join(os.homedir(), 'Documents', 'Backcountry Pathfinders', 'data');
const OUT_FILENAME = 'airports-msfs.jsonl';

const M_TO_FT = 1 / 0.3048;

// --------------------------------------------------------------
// Tables de décodage
// --------------------------------------------------------------
const DESIGNATOR = ['', 'L', 'R', 'C', 'W', 'A', 'B', '']; // 0..7

// Enum surface MSFS (best-effort ; surface_code brut conservé pour affinage).
const SURFACE_LABEL = {
  0: 'Concrete', 1: 'Grass', 2: 'Water', 3: 'Grass (bumpy)', 4: 'Asphalt',
  5: 'Short grass', 6: 'Long grass', 7: 'Hard turf', 8: 'Snow', 9: 'Ice',
  10: 'Urban', 11: 'Forest', 12: 'Dirt', 13: 'Coral', 14: 'Gravel',
  15: 'Oil treated', 16: 'Steel mats', 17: 'Bituminous', 18: 'Brick',
  19: 'Macadam', 20: 'Planks', 21: 'Sand', 22: 'Shale', 23: 'Tarmac',
  24: 'Wright Flyer track',
  // Codes inconnus rencontrés (254/255 = sentinelles 0xFE/0xFF ; 32/34 =
  // probables nouveaux types MSFS 2024). Étiquetés "Unknown", code brut conservé.
  32: 'Unknown', 34: 'Unknown', 254: 'Unknown', 255: 'Unknown',
};
// Surfaces "dures" reconnues.
const HARD_SURFACES = new Set([0, 4, 16, 17, 18, 19, 23]);
// Surfaces reconnues comme NON dures (molles + naturelles). Tout code absent
// de cet ensemble ET de l'eau est traité comme "dur-éligible" pour le typage :
// un code inconnu sur une piste de 3962 m (ex. KROW) n'est pas de l'herbe.
const KNOWN_NONHARD = new Set([1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 20, 21, 22, 24]);
const WATER_SURFACE = 2;
// Une surface compte-t-elle pour le seuil large/medium ?
function isHardEligible(code) {
  return HARD_SURFACES.has(code) || !KNOWN_NONHARD.has(code);
}

const FREQ_TYPE = {
  0: 'None', 1: 'ATIS', 2: 'MULTICOM', 3: 'UNICOM', 4: 'CTAF', 5: 'GROUND',
  6: 'TOWER', 7: 'CLEARANCE', 8: 'APPROACH', 9: 'DEPARTURE', 10: 'CENTER',
  11: 'FSS', 12: 'AWOS', 13: 'ASOS', 14: 'CPT', 15: 'GCO',
};

// --------------------------------------------------------------
// Helpers
// --------------------------------------------------------------
function round(v, n) { const f = 10 ** n; return Math.round(v * f) / f; }
// Projette un point (lat/lon en °) sur une distance (m) selon un cap VRAI (°).
// Formule du grand cercle (rayon terrestre moyen) — suffisant à l'échelle piste.
function projectLatLon(latDeg, lonDeg, bearingDeg, distM) {
  const R = 6371000;
  const d = distM / R;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (latDeg * Math.PI) / 180;
  const lon1 = (lonDeg * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: (lat2 * 180) / Math.PI, lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180 };
}
function pad2(n) { return String(n).padStart(2, '0'); }
function desig(d) { return DESIGNATOR[d] || ''; }
function surfaceLabel(code) { return SURFACE_LABEL[code] || `code ${code}`; }
function freqTypeLabel(code) { return FREQ_TYPE[code] || `type ${code}`; }
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

// node-simconnect `readString*` décode les octets en Latin-1 (1 octet = 1
// caractère). MSFS envoie en réalité les libellés en UTF-8 → tous les
// caractères accentués finissent en mojibake (`é` UTF-8 = C3 A9 lu comme
// `Ã©`, puis ré-encodé en UTF-8 → C3 83 C2 A9 dans le JSONL).
//
// On reconstruit les octets d'origine en passant par Buffer 'latin1', puis
// on décode en UTF-8 strict. Certaines entrées MSFS sont DÉJÀ pré-corrompues
// en amont (triple-encoding : « EstÃÂ¢ncia » au lieu de « Estância ») —
// on itère jusqu'à idempotence (≤ 4 passes). À chaque passe, si la séquence
// n'est plus valide UTF-8, on s'arrête sur le dernier état décodable ;
// pour une chaîne ASCII / déjà propre, dès la 1ère passe la séquence est
// invalide et on retourne la chaîne d'entrée inchangée.
const _utf8Decoder = new TextDecoder('utf-8', { fatal: true });
function fixUtf8(s) {
  if (!s) return s;
  let cur = s;
  for (let i = 0; i < 4; i++) {
    let next;
    try { next = _utf8Decoder.decode(Buffer.from(cur, 'latin1')); }
    catch (_) { return cur; }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

// Lit la chaîne occupant tout le reste du buffer (champ NAME en
// dernière position : pas de troncature, pas de devinette de taille).
function readTrailingString(buf) {
  const rem = buf.remaining();
  if (rem <= 0) return '';
  try { return fixUtf8(buf.readString(rem).replace(/ +$/, '').trim()); }
  catch (_) { return ''; }
}
function readStr8(buf) {
  const saved = buf.getOffset();
  try { return fixUtf8(buf.readString8().trim()); }
  catch (_) { buf.setOffset(saved); return ''; }
}

// --------------------------------------------------------------
// Définition de l'arbre facility (identique au PoC validé)
// --------------------------------------------------------------
function defineAirport(h) {
  const add = (field) => h.addToFacilityDefinition(DEF_AIRPORT, field);

  add('OPEN AIRPORT');
  add('LATITUDE');        // f64
  add('LONGITUDE');       // f64
  add('ALTITUDE');        // f64 (m)
  add('MAGVAR');          // f32
  add('N_RUNWAYS');       // i32
  add('N_FREQUENCIES');   // i32
  add('N_HELIPADS');      // i32
  add('NAME');            // string (dernier champ du nœud)

  add('OPEN RUNWAY');
  add('LATITUDE');              // f64 — centre de la piste (sépare les parallèles)
  add('LONGITUDE');             // f64
  add('ALTITUDE');              // f64 (m)
  add('PRIMARY_NUMBER');        // i32
  add('PRIMARY_DESIGNATOR');    // i32
  add('SECONDARY_NUMBER');      // i32
  add('SECONDARY_DESIGNATOR');  // i32
  add('LENGTH');                // f32 (m)
  add('WIDTH');                 // f32 (m)
  add('HEADING');               // f32 (cap VRAI de l'extrémité primaire)
  add('SURFACE');               // i32
  add('PRIMARY_ILS_ICAO');      // string8
  add('PRIMARY_ILS_REGION');    // string8
  add('SECONDARY_ILS_ICAO');    // string8
  add('SECONDARY_ILS_REGION');  // string8
  add('CLOSE RUNWAY');

  add('OPEN FREQUENCY');
  add('TYPE');        // i32
  add('FREQUENCY');   // i32 (Hz)
  add('NAME');        // string (dernier champ du nœud)
  add('CLOSE FREQUENCY');

  add('OPEN HELIPAD');
  add('LATITUDE');    // f64
  add('LONGITUDE');   // f64
  add('ALTITUDE');    // f64
  add('HEADING');     // f32
  add('LENGTH');      // f32
  add('WIDTH');       // f32
  add('SURFACE');     // i32
  add('CLOSE HELIPAD');

  add('CLOSE AIRPORT');
}

// --------------------------------------------------------------
// Parsing des nœuds
// --------------------------------------------------------------
function parseAirportNode(d) {
  const latitude = d.readFloat64();
  const longitude = d.readFloat64();
  const altitude = d.readFloat64();      // mètres
  const magvar = d.readFloat32();        // 0..360
  const nRwy = d.readInt32();
  const nFreq = d.readInt32();
  const nHeli = d.readInt32();
  const name = readTrailingString(d);
  const magNorm = magvar > 180 ? magvar - 360 : magvar;
  return {
    latitude_deg: round(latitude, 6),
    longitude_deg: round(longitude, 6),
    elevation_ft: Math.round(altitude * M_TO_FT),
    magnetic_variation_deg: round(magNorm, 2),
    _nRwy: nRwy, _nFreq: nFreq, _nHeli: nHeli,
    name,
  };
}

function parseRunwayNode(d, surfaceCodes) {
  const rwyLat = d.readFloat64();        // centre géométrique de la piste
  const rwyLon = d.readFloat64();
  const rwyAlt = d.readFloat64();        // mètres
  const n1 = d.readInt32();
  const d1 = d.readInt32();
  const n2 = d.readInt32();
  const d2 = d.readInt32();
  const length_m = d.readFloat32();
  const width_m = d.readFloat32();
  const heading = d.readFloat32();       // cap VRAI de l'extrémité primaire
  const surface = d.readInt32();
  const ilsIcao1 = readStr8(d);
  const ilsReg1 = readStr8(d);
  const ilsIcao2 = readStr8(d);
  const ilsReg2 = readStr8(d);

  surfaceCodes.set(surface, (surfaceCodes.get(surface) || 0) + 1);

  const primaryIdent = pad2(n1) + desig(d1);
  const secondaryIdent = pad2(n2) + desig(d2);
  const primaryHeadingT = round(heading, 1);
  const secondaryHeadingT = round((heading + 180) % 360, 1);

  // Seuils calculés depuis le centre + cap + longueur (seuils géométriques,
  // sans tenir compte d'un éventuel seuil décalé). Le seuil "primaire" (où le
  // numéro primaire est peint) est à l'arrière du sens de décollage → cap+180.
  const half = (Number.isFinite(length_m) ? length_m : 0) / 2;
  const haveCenter = Number.isFinite(rwyLat) && Number.isFinite(rwyLon);
  const primaryThr = haveCenter ? projectLatLon(rwyLat, rwyLon, (heading + 180) % 360, half) : null;
  const secondaryThr = haveCenter ? projectLatLon(rwyLat, rwyLon, heading, half) : null;

  // OurAirports : le_ = extrémité au numéro le plus bas.
  let le_ident, he_ident, le_heading_degT, he_heading_degT, le_ils, he_ils, le_thr, he_thr;
  if (n1 <= n2) {
    le_ident = primaryIdent; he_ident = secondaryIdent;
    le_heading_degT = primaryHeadingT; he_heading_degT = secondaryHeadingT;
    le_ils = ilsIcao1 ? { icao: ilsIcao1, region: ilsReg1 } : null;
    he_ils = ilsIcao2 ? { icao: ilsIcao2, region: ilsReg2 } : null;
    le_thr = primaryThr; he_thr = secondaryThr;
  } else {
    le_ident = secondaryIdent; he_ident = primaryIdent;
    le_heading_degT = secondaryHeadingT; he_heading_degT = primaryHeadingT;
    le_ils = ilsIcao2 ? { icao: ilsIcao2, region: ilsReg2 } : null;
    he_ils = ilsIcao1 ? { icao: ilsIcao1, region: ilsReg1 } : null;
    le_thr = secondaryThr; he_thr = primaryThr;
  }

  return {
    le_ident,
    he_ident,
    headingDegT: le_heading_degT,   // raccourci compat
    le_heading_degT,
    he_heading_degT,
    length_ft: Math.round(length_m * M_TO_FT),
    width_ft: Math.round(width_m * M_TO_FT),
    length_m: round(length_m, 1),
    surface: surfaceLabel(surface),
    surface_code: surface,
    lighted: null,   // non fourni par cette définition facility
    closed: 0,
    le_ils,
    he_ils,
    // Position de la piste (MSFS) + seuils calculés → tracé sans superposition.
    latitude_deg: haveCenter ? round(rwyLat, 6) : null,
    longitude_deg: haveCenter ? round(rwyLon, 6) : null,
    elevation_ft: Number.isFinite(rwyAlt) ? Math.round(rwyAlt * M_TO_FT) : null,
    le_latitude_deg: le_thr ? round(le_thr.lat, 6) : null,
    le_longitude_deg: le_thr ? round(le_thr.lon, 6) : null,
    he_latitude_deg: he_thr ? round(he_thr.lat, 6) : null,
    he_longitude_deg: he_thr ? round(he_thr.lon, 6) : null,
  };
}

function parseFrequencyNode(d) {
  const type = d.readInt32();
  const hz = d.readInt32();
  const name = readTrailingString(d);
  return {
    type: freqTypeLabel(type),
    type_code: type,
    description: name,
    frequency_mhz: round(hz / 1e6, 3),
  };
}

function parseHelipadNode(d, surfaceCodes) {
  const latitude = d.readFloat64();
  const longitude = d.readFloat64();
  const altitude = d.readFloat64();
  const heading = d.readFloat32();
  const length_m = d.readFloat32();
  const width_m = d.readFloat32();
  const surface = d.readInt32();
  surfaceCodes.set(surface, (surfaceCodes.get(surface) || 0) + 1);
  return {
    latitude_deg: round(latitude, 6),
    longitude_deg: round(longitude, 6),
    elevation_ft: Math.round(altitude * M_TO_FT),
    headingDegT: round(heading, 1),
    length_ft: Math.round(length_m * M_TO_FT),
    width_ft: Math.round(width_m * M_TO_FT),
    surface: surfaceLabel(surface),
    surface_code: surface,
  };
}

// --------------------------------------------------------------
// Dérivation du type d'aéroport à partir des pistes
// --------------------------------------------------------------
function deriveType(runways, helipads) {
  const rwys = runways.filter((r) => !r.closed);
  if (rwys.length === 0) {
    // Aucune piste : héliport s'il y a des hélipads, sinon décor/POI MSFS
    // (stade, pont, monument, fort…) exposé comme « airport » sans piste.
    // Type 'poi' afin qu'il soit exclu de la carte (TYPES_OK) plutôt que
    // classé small_airport par défaut.
    return helipads.length > 0 ? 'heliport' : 'poi';
  }
  const nonWater = rwys.filter((r) => r.surface_code !== WATER_SURFACE);
  if (nonWater.length === 0) return 'seaplane_base';

  const hard = rwys.filter((r) => isHardEligible(r.surface_code));
  const longestHardM = hard.length ? Math.max(...hard.map((r) => r.length_m)) : 0;
  if (longestHardM >= 2400) return 'large_airport';
  if (longestHardM >= 1200) return 'medium_airport';
  return 'small_airport';
}

// --------------------------------------------------------------
// Construction de l'enregistrement final
// --------------------------------------------------------------
function buildRecord(entry, acc) {
  const a = acc.airport || {};
  const type = deriveType(acc.runways, acc.helipads);
  return {
    ident: entry.icao,
    icao_code: entry.icao,
    iata_code: '',
    gps_code: '',
    local_code: '',
    type,
    name: a.name || entry.icao,
    latitude_deg: a.latitude_deg != null ? a.latitude_deg : round(entry.latitude, 6),
    longitude_deg: a.longitude_deg != null ? a.longitude_deg : round(entry.longitude, 6),
    elevation_ft: a.elevation_ft != null ? a.elevation_ft : Math.round((entry.altitude || 0) * M_TO_FT),
    iso_country: '',
    iso_region: entry.region || '',
    municipality: '',
    scheduled_service: '',
    home_link: '',
    wikipedia_link: '',
    keywords: '',
    magnetic_variation_deg: a.magnetic_variation_deg != null ? a.magnetic_variation_deg : null,
    runways: acc.runways,
    frequencies: acc.frequencies,
    helipads: acc.helipads,
    source: 'msfs2024-simconnect',
  };
}

// ==============================================================
// Moteur réutilisable
// ==============================================================
// Options :
//   window     : nb de requêtes détail simultanées (déf. 100)
//   limit      : n'extraire que N aéroports (0 = tout)
//   outDir     : dossier de sortie (déf. Documents/NavXpressVFR/data)
//   appName    : nom de l'app SimConnect (déf. 'NavXpressVFR-Extract')
//   onProgress : callback(progressEvent) — voir formes ci-dessous
//
// Événements de progression (objets) :
//   { phase:'connect' }
//   { phase:'connected', sim }
//   { phase:'enumerate', enumerated, packet, totalPackets }
//   { phase:'detail', treated, target, ok, failed, inFlight, ratePerSec, etaMs, retry }
//   { phase:'done', ...summary }
//
// Résout avec un objet summary ; rejette si la connexion échoue.
function runExtraction(opts = {}) {
  const WINDOW = opts.window > 0 ? opts.window : 100;
  const LIMIT = opts.limit > 0 ? opts.limit : 0;
  const OUT_DIR = opts.outDir || DEFAULT_OUT_DIR;
  const APP_NAME = opts.appName || 'BackcountryPathfinders-Extract';
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  const OUT_FILE = path.join(OUT_DIR, OUT_FILENAME);
  const TMP_FILE = OUT_FILE + '.tmp';

  return new Promise((resolve, reject) => {
    // ---- état local (isolé : runExtraction est ré-appelable) ----
    let handle = null;
    let finished = false;
    let writeStream = null;
    let simName = '';

    const airportList = [];           // {icao, region, latitude, longitude, altitude}
    let listTotalPackets = null;
    let listLastEntry = -1;
    let listDone = false;
    let lastListChunkAt = Date.now();

    const inFlight = new Map();        // reqId -> {entry, startedAt, acc}
    const sendIdToReq = new Map();     // sendId -> reqId
    let reqSeq = 100000;
    let queue = [];
    let qpos = 0;
    let useRegion = true;              // passe 1 : avec région ; reprise : sans
    let retried = false;
    let detailStarted = false;
    let writeIndex = 0;                // nb d'enregistrements écrits (ok)
    let failedEntries = [];            // échecs de la passe courante
    let lastProgressAt = Date.now();
    const surfaceCodes = new Map();    // code -> count
    let detailStartTime = 0;

    let watchdog = null;
    let globalTimer = null;

    const emit = (p) => { try { onProgress(p); } catch (_) {} };

    // ---- fin / nettoyage ----
    function finish(reason) {
      if (finished) return;
      finished = true;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      if (globalTimer) { clearTimeout(globalTimer); globalTimer = null; }

      const done = writeIndex;
      const elapsed = detailStartTime ? Date.now() - detailStartTime : 0;

      const closeAndReport = () => {
        // Renomme le .tmp en fichier final seulement si on a écrit qqch.
        let renamed = false;
        try {
          if (writeIndex > 0 && fs.existsSync(TMP_FILE)) {
            fs.renameSync(TMP_FILE, OUT_FILE);
            renamed = true;
          }
        } catch (_) { /* renommage échoué : summary.file restera null */ }
        let fileSize = 0;
        if (renamed) { try { fileSize = fs.statSync(OUT_FILE).size; } catch (_) {} }
        try { handle && handle.close(); } catch (_) {}

        const summary = {
          ok: true,
          reason,
          enumerated: airportList.length,
          written: done,
          failed: failedEntries.length,
          inFlightAtStop: inFlight.size,
          durationMs: elapsed,
          retried,
          surfaceCodes: [...surfaceCodes.entries()].sort((a, b) => a[0] - b[0]),
          failedIcaos: failedEntries.map((e) => e.icao),
          file: renamed ? OUT_FILE : null,
          fileSize,
          sim: simName,
        };
        emit({ phase: 'done', ...summary });
        resolve(summary);
      };

      if (writeStream) writeStream.end(closeAndReport);
      else closeAndReport();
    }

    function writeRecord(rec) {
      writeStream.write(JSON.stringify(rec) + '\n');
      writeIndex++;
      lastProgressAt = Date.now();
    }

    function openOutput() {
      try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (_) {}
      writeStream = fs.createWriteStream(TMP_FILE, { encoding: 'utf8' });
      const header = {
        __meta: true,
        format: 1,
        source: 'msfs2024-simconnect',
        sim: simName || '',
        generatedAt: new Date().toISOString(),
      };
      writeStream.write(JSON.stringify(header) + '\n');
    }

    // ---- phase 2 : fenêtre de requêtes détail ----
    function pump() {
      if (finished) return;
      while (inFlight.size < WINDOW && qpos < queue.length) {
        const entry = queue[qpos++];
        const reqId = reqSeq++;
        const acc = { airport: null, runways: [], frequencies: [], helipads: [] };
        inFlight.set(reqId, { entry, startedAt: Date.now(), acc });
        let sendId;
        try {
          sendId = handle.requestFacilityData(
            DEF_AIRPORT, reqId, entry.icao, useRegion ? (entry.region || undefined) : undefined
          );
        } catch (e) {
          inFlight.delete(reqId);
          failedEntries.push(entry);
          continue;
        }
        if (typeof sendId === 'number') sendIdToReq.set(sendId, reqId);
      }
      maybeFinish();
    }

    function maybeFinish() {
      if (finished) return;
      if (qpos >= queue.length && inFlight.size === 0) {
        if (!retried && failedEntries.length > 0) startRetry();
        else finish('tous les aéroports traités');
      }
    }

    // Passe de reprise unique : on rejoue les échecs SANS région.
    function startRetry() {
      retried = true;
      useRegion = false;
      queue = failedEntries;
      failedEntries = [];
      qpos = 0;
      lastProgressAt = Date.now();
      pump();
    }

    function startDetailPhase() {
      if (detailStarted) return;
      detailStarted = true;
      detailStartTime = Date.now();
      lastProgressAt = Date.now();
      queue = LIMIT > 0 ? airportList.slice(0, LIMIT) : airportList;
      qpos = 0;
      pump();
    }

    // ---- phase 1 : énumération ----
    function onListDone(why) {
      if (listDone) return;
      listDone = true;
      if (airportList.length === 0) { finish('aucun aéroport énuméré'); return; }
      startDetailPhase();
    }

    // ---- connexion ----
    emit({ phase: 'connect' });
    scOpen(APP_NAME, SCProtocol.SunRise).then((res) => {
      handle = res.handle;
      simName = (res.recvOpen && res.recvOpen.applicationName) || '';
      emit({ phase: 'connected', sim: simName });

      try {
        defineAirport(handle);
      } catch (err) {
        try { handle.close(); } catch (_) {}
        reject(new Error('addToFacilityDefinition: ' + ((err && err.message) || err)));
        return;
      }

      openOutput();

      handle.on('airportList', (recv) => {
        if (recv.requestID !== REQ_LIST || listDone) return;
        lastListChunkAt = Date.now();
        if (typeof recv.outOf === 'number') listTotalPackets = recv.outOf;
        if (typeof recv.entryNumber === 'number') listLastEntry = recv.entryNumber;
        for (const a of recv.airports) {
          airportList.push({
            icao: a.icao,
            region: a.region,
            latitude: a.latitude,
            longitude: a.longitude,
            altitude: a.altitude,
          });
        }
        emit({
          phase: 'enumerate',
          enumerated: airportList.length,
          packet: listLastEntry + 1,
          totalPackets: listTotalPackets,
        });
        if (listTotalPackets !== null && listTotalPackets > 0 && listLastEntry >= listTotalPackets - 1) {
          onListDone('dernier paquet');
        }
      });

      handle.on('facilityData', (recv) => {
        const slot = inFlight.get(recv.userRequestId);
        if (!slot) return;
        const dd = recv.data;
        try {
          switch (recv.type) {
            case FacilityDataType.AIRPORT:   slot.acc.airport = parseAirportNode(dd); break;
            case FacilityDataType.RUNWAY:    slot.acc.runways.push(parseRunwayNode(dd, surfaceCodes)); break;
            case FacilityDataType.FREQUENCY: slot.acc.frequencies.push(parseFrequencyNode(dd)); break;
            case FacilityDataType.HELIPAD:   slot.acc.helipads.push(parseHelipadNode(dd, surfaceCodes)); break;
            default: break;
          }
        } catch (_) { /* parsing partiel : on garde ce qu'on a */ }
      });

      handle.on('facilityDataEnd', (recv) => {
        const slot = inFlight.get(recv.userRequestId);
        if (!slot) return;
        inFlight.delete(recv.userRequestId);
        try { writeRecord(buildRecord(slot.entry, slot.acc)); }
        catch (_) { failedEntries.push(slot.entry); }
        pump();
      });

      handle.on('exception', (ex) => {
        const reqId = sendIdToReq.get(ex.sendId);
        if (reqId !== undefined) {
          sendIdToReq.delete(ex.sendId);
          const slot = inFlight.get(reqId);
          if (slot) {
            inFlight.delete(reqId);
            failedEntries.push(slot.entry);
            pump();
          }
        }
        // Sinon : exception de setup/liste → ignorée (le watchdog gère).
      });

      handle.on('error', () => { /* erreurs transport : le watchdog/stall gère */ });
      handle.on('quit', () => finish('sim fermé'));

      // Lance la phase 1.
      handle.requestFacilitiesList(FacilityListType.AIRPORT, REQ_LIST);

      // Watchdog (1 Hz) : inactivité liste, timeouts détail, progression, stall.
      watchdog = setInterval(() => {
        if (finished) return;

        // Phase 1 : inactivité.
        if (!listDone && airportList.length > 0 && Date.now() - lastListChunkAt > LIST_INACTIVITY_MS) {
          onListDone('inactivité');
          return;
        }

        if (!detailStarted) return;

        // Phase 2 : timeouts par requête.
        const now = Date.now();
        let timedOut = 0;
        for (const [reqId, slot] of inFlight) {
          if (now - slot.startedAt > REQUEST_TIMEOUT_MS) {
            inFlight.delete(reqId);
            failedEntries.push(slot.entry);
            timedOut++;
          }
        }
        if (timedOut > 0) pump();

        // Progression (dénominateur = total énuméré, ou LIMIT).
        const target = LIMIT > 0 ? Math.min(LIMIT, airportList.length) : airportList.length;
        const treated = writeIndex + failedEntries.length;
        const elapsed = (now - detailStartTime) / 1000;
        const rate = elapsed > 0 ? treated / elapsed : 0;
        const remain = rate > 0 ? Math.max(0, target - treated) / rate : 0;
        emit({
          phase: 'detail',
          treated,
          target,
          ok: writeIndex,
          failed: failedEntries.length,
          inFlight: inFlight.size,
          ratePerSec: rate,
          etaMs: remain * 1000,
          retry: retried,
        });

        // Stall : aucune écriture/échec depuis STALL_MS.
        if (now - lastProgressAt > STALL_MS) {
          finish(`aucune progression depuis ${STALL_MS / 1000}s`);
        }
      }, 1000);

      // Garde-fou global.
      globalTimer = setTimeout(() => finish('timeout global'), GLOBAL_TIMEOUT_MS);
    }).catch((err) => {
      reject(new Error((err && err.message) || 'connexion impossible'));
    });
  });
}

module.exports = {
  runExtraction,
  OUT_FILENAME,
  DEFAULT_OUT_DIR,
  // exports utiles aux tests / réutilisation éventuelle
  deriveType,
  buildRecord,
  surfaceLabel,
};

// ==============================================================
// CLI :  node extract-airports-msfs.js [--limit N] [--window N] [--out DIR]
// ==============================================================
if (require.main === module) {
  function argVal(name, def) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
  }
  const LIMIT = parseInt(argVal('--limit', '0'), 10) || 0;
  const WINDOW = parseInt(argVal('--window', '100'), 10) || 100;
  const OUT_DIR = argVal('--out', DEFAULT_OUT_DIR);

  const onProgress = (p) => {
    switch (p.phase) {
      case 'connect':
        console.log('Connexion à MSFS via SimConnect (protocole SunRise / MSFS 2024)…');
        break;
      case 'connected':
        console.log('Connecté à : ' + p.sim);
        console.log('\nPhase 1 — énumération : requestFacilitiesList(AIRPORT)…');
        break;
      case 'enumerate':
        process.stdout.write(
          `\r[énumération] aéroports : ${p.enumerated}  |  paquet ${p.packet}/${p.totalPackets ?? '?'}   `
        );
        break;
      case 'detail':
        process.stdout.write(
          `\r[détail${p.retry ? '/reprise' : ''}] ${p.treated}/${p.target}  ok:${p.ok} ` +
          `échecs:${p.failed} envol:${p.inFlight}  ${p.ratePerSec.toFixed(0)}/s  ETA ${fmtDuration(p.etaMs)}      `
        );
        break;
      default:
        break;
    }
  };

  runExtraction({ window: WINDOW, limit: LIMIT, outDir: OUT_DIR, onProgress })
    .then((s) => {
      console.log('\n\n──────────────────────────────────────────────');
      console.log(`Fin de l'extraction (${s.reason}).`);
      console.log(`  Aéroports énumérés      : ${s.enumerated}`);
      console.log(`  Détails écrits (OK)     : ${s.written}`);
      console.log(`  Échecs / timeouts       : ${s.failed}` + (s.retried ? '  (après reprise sans région)' : ''));
      console.log(`  En vol au moment du stop: ${s.inFlightAtStop}`);
      console.log(`  Durée phase détail      : ${fmtDuration(s.durationMs)}` +
          (s.durationMs > 0 ? `  (${(s.written / (s.durationMs / 1000)).toFixed(1)} aéroports/s)` : ''));
      console.log('  Codes de surface vus    :');
      for (const [code, n] of s.surfaceCodes) {
        console.log(`     ${String(code).padStart(3)}  ${surfaceLabel(code).padEnd(18)} ×${n}`);
      }
      if (s.failedIcaos.length) {
        console.log(`  ICAO échoués (${s.failedIcaos.length}) : ${s.failedIcaos.slice(0, 60).join(', ')}` +
            (s.failedIcaos.length > 60 ? ' …' : ''));
      }
      if (s.file) {
        console.log(`\nFichier écrit : ${s.file}`);
        console.log(`   Taille : ${(s.fileSize / 1e6).toFixed(1)} Mo`);
      } else {
        console.log(`\nAucun fichier final écrit (rien à sauvegarder).`);
      }
      console.log('──────────────────────────────────────────────');
      process.exit(0);
    })
    .catch((err) => {
      console.log('\nConnexion impossible :', err.message);
      console.log('   → MSFS 2024 est-il lancé avec un vol en cours ?');
      process.exit(1);
    });
}
