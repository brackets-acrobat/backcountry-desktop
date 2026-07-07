/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// main.js — process principal Electron.
//
// Rôle : fenêtre, client SimConnect, FSM du poser, capture d'écran, envoi.
// Flux « envoi groupé » : la FSM accumule les posers du vol ; le renderer
// déclenche les captures manuelles (bouton gated) ; à la fin du vol, une
// modale envoie tout (relevés + photos en multipart) — avec file hors-ligne.
// ============================================================

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const extract = require('extract-zip');   // extraction ZIP (données d'élévation GLOBE)
const { open: scOpen, Protocol: SCProtocol } = require('node-simconnect');
const geomagnetism = require('geomagnetism');   // modèle magnétique mondial (WMM)

const { chargerConfig, enregistrerCle, dossierBase } = require('./config');
const { runExtraction: runMsfsExtraction } = require('./extract-airports-msfs');
const { runExtraction: runNavaidsExtraction } = require('./extract-navaids-msfs');
const airportsData = require('./airports-data');
const { SimConnectClient } = require('./simconnect');
const { createFsm } = require('./fsm');
const { envoyerVol, recupererLieux } = require('./api-client');
const { capturerVersFichier } = require('./capture');
const { enfiler, compter, flush } = require('./queue');
const { setupAutoUpdater, quitAndInstall } = require('./updater');

// Centralise les données d'Electron (cache, localStorage, session…) dans un
// sous-dossier du dossier de travail au lieu d'AppData → tout au même endroit
// que screenshots/queue/settings.json. À faire AVANT que l'app soit « ready ».
try {
  const userData = path.join(dossierBase(), 'app-data');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
} catch (_) { /* repli silencieux sur l'emplacement par défaut */ }

let mainWindow = null;
let config = chargerConfig();
const sim = new SimConnectClient();

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((w) => {
    try { w.webContents.send(channel, payload); } catch (_) {}
  });
}

// Dossiers de travail (sous Documents/Backcountry Pathfinders par défaut).
// Base partagée avec config.js (settings.json y est aussi écrit).
function dossiers() {
  const base = dossierBase();
  return {
    screenshots: path.join(base, 'screenshots'),
    queue: path.join(base, 'queue'),
  };
}

const cheminCapture = (uid) => path.join(dossiers().screenshots, `${uid}.jpg`);

function broadcastQueue() {
  broadcast('queue-status', { restants: compter(dossiers().queue) });
}

// Rejoue la file hors-ligne (démarrage, périodique, après reconnexion).
// On rediffuse TOUJOURS le compte réel à la fin (même sans clé API) pour qu'un
// badge figé se recale sur l'état du disque.
async function flushQueue() {
  if (config._cleConfiguree) {
    await flush(dossiers().queue, (vol) => envoyerVol(config, vol));
  }
  broadcastQueue();
}

// FSM du poser : relaie ses événements au renderer (préfixe fsm-).
const fsm = createFsm({ emit: (event, payload) => broadcast('fsm-' + event, payload) });

// Relais SimConnect.
sim.on('status', (s) => {
  broadcast('sc-status', s);
  if (s.state === 'connected') flushQueue();
});
sim.on('scan', (frame) => broadcast('sc-scan', frame));   // UI (throttlé ~1 Hz)
sim.on('frame', (frame) => fsm.feed(frame));               // FSM (chaque image)

// Splash screen : fenêtre sans cadre, à la taille de l'image (640×435),
// affichée au lancement pendant ~4 s pendant que la fenêtre principale se
// charge en arrière-plan. La version de l'appli est injectée en blanc, en bas
// à gauche de l'image (executeJavaScript → pas de script inline, CSP stricte).
function createSplash() {
  const splash = new BrowserWindow({
    width: 640,
    height: 435,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#161310',
    title: 'Backcountry Pathfinders',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.removeMenu();
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  splash.webContents.on('did-finish-load', () => {
    const v = JSON.stringify('v' + app.getVersion());
    splash.webContents.executeJavaScript(
      `document.getElementById('splash-version').textContent = ${v};`
    ).catch(() => {});
  });
  return splash;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#161310',
    title: 'Backcountry Pathfinders',
    show: false,   // affichée seulement à la fin du splash screen (voir whenReady)
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Liens externes (ex. « Voir le détail » d'un lieu dans les popups carte) :
  // ouverts dans le navigateur par défaut, jamais dans une fenêtre Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // removeMenu() supprime Ctrl+R / F12 → on les rebranche manuellement.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if ((input.control && key === 'r') || key === 'f5') {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
    if ((input.control && input.shift && key === 'i') || key === 'f12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

// --- IPC ---
function configPublique() {
  return {
    apiBaseUrl: config.apiBaseUrl,
    cleConfiguree: config._cleConfiguree,
    source: config._source,
    version: app.getVersion(),
  };
}

ipcMain.handle('app-config', async () => configPublique());

// Enregistre la clé API saisie dans l'UI (settings.json), recharge la config,
// notifie le renderer, et rejoue la file hors-ligne si la clé devient valide.
ipcMain.handle('config-set-key', async (_e, { apiKey, apiBaseUrl } = {}) => {
  try {
    config = enregistrerCle(apiKey, apiBaseUrl);
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
  const pub = configPublique();
  broadcast('app-config', pub);
  if (config._cleConfiguree) flushQueue();
  return { ok: true, ...pub };
});

ipcMain.handle('sc-connect', async () => sim.connecter());
ipcMain.handle('sc-disconnect', async () => { await sim.deconnecter(); return { ok: true }; });

// Capture manuelle du spot (clic sur « Capture » dans la modale).
ipcMain.handle('capture-now', async (_e, uid) => {
  if (!uid) return { ok: false, error: 'uid manquant' };
  try {
    const cap = await capturerVersFichier(uid, dossiers().screenshots, config.captureMonitor || 0);
    fsm.markCaptured(uid);
    return { ok: true, thumbDataUrl: cap.thumbDataUrl, via: cap.via, filename: cap.filename };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
});

// Envoi groupé du vol (fin de vol) : un seul POST /api/vol crée le vol + tous
// ses posers. payload = { landings, flight, depIcao, arrIcao }.
ipcMain.handle('envoyer-tout', async (_e, payload = {}) => {
  if (!config._cleConfiguree) {
    return { ok: false, erreur: 'Clé API non configurée (config.json).' };
  }
  const { landings, flight, depIcao, arrIcao } = payload;
  // Règle : un poser SANS photo n'est pas valide → le vol n'envoie que les
  // posers photographiés. Sans aucune photo, rien n'est envoyé.
  const valides = (landings || []).filter((l) => l.hasCapture);
  if (valides.length === 0) {
    fsm.reset();
    return { ok: true, envoyes: 0, enfiles: 0, echecs: 0 };
  }

  // Construit le payload du vol (méta + posers + chemins des photos).
  const vol = {
    _uid: 'vol_' + valides[0].uid,
    date_debut: (flight && flight.startSimLocal) || null,
    date_fin: (flight && flight.endSimLocal) || null,
    duree_sec: flight ? (flight.durationSec ?? null) : null,
    aeronef: (flight && flight.aircraft) || null,
    depart_icao: (depIcao || '').trim() || null,
    arrivee_icao: (arrIcao || '').trim() || null,
    landings: valides.map((l) => ({ uid: l.uid, ...l.releve })),
    _captures: valides.map((l) => ({ uid: l.uid, path: cheminCapture(l.uid) })),
  };

  let envoyes = 0; let enfiles = 0; let echecs = 0;
  const res = await envoyerVol(config, vol);
  if (res.ok) {
    envoyes = vol.landings.length;
  } else if (!res.status || res.status === 0) {
    enfiler(dossiers().queue, vol);   // hors-ligne → file (le vol entier)
    enfiles = vol.landings.length;
  } else {
    echecs = vol.landings.length;     // refus serveur (4xx/5xx)
  }

  fsm.reset();
  broadcastQueue();
  return { ok: echecs === 0, envoyes, enfiles, echecs };
});

// « Ne pas envoyer » confirmé → on oublie les posers du vol (les photos locales restent).
ipcMain.handle('flight-discard', async () => { fsm.reset(); return { ok: true }; });

ipcMain.handle('queue-status', async () => ({ restants: compter(dossiers().queue) }));

// Relance manuelle de la file hors-ligne (clic sur le badge « en attente »).
ipcMain.handle('queue-flush', async () => {
  await flushQueue();   // émet déjà queue-status au renderer (broadcastQueue)
  return { restants: compter(dossiers().queue), cleConfiguree: config._cleConfiguree };
});

// --- Import des aéroports MSFS 2024 (repris de NavXpressVFR) ---
// Vérifie que MSFS 2024 répond : ouvre une connexion SunRise éphémère (≠ la
// connexion de scan en FSX_SP2) et la referme aussitôt.
ipcMain.handle('msfs-verifier-lancement', async () => {
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve(result);
    };
    timer = setTimeout(() => done({ running: false, error: 'timeout (aucune réponse du simulateur en 8 s)' }), 8000);

    let openP;
    try {
      openP = scOpen('BackcountryPathfinders-Check', SCProtocol.SunRise);
    } catch (err) {
      done({ running: false, error: 'scOpen a échoué : ' + (err && err.message) });
      return;
    }
    openP.then((res) => {
      try { res.handle.close(); } catch (_) {}
      done({ running: true, app: (res.recvOpen && res.recvOpen.applicationName) || 'MSFS' });
    }).catch((err) => {
      done({ running: false, error: (err && err.message) || 'connexion refusée' });
    });
  });
});

// Extraction in-app : ouvre sa propre connexion SunRise dédiée, énumère puis lit
// en détail tous les aéroports, écrit Documents/Backcountry Pathfinders/data/
// airports-msfs.jsonl, et relaie la progression au renderer via 'msfs-extract-progress'.
let _msfsExtractRunning = false;
ipcMain.handle('extraire-aeroports-msfs', async (event, options) => {
  if (_msfsExtractRunning) return { ok: false, error: 'Une extraction est déjà en cours.' };
  _msfsExtractRunning = true;
  const wc = event.sender;
  const outDir = path.join(dossierBase(), 'data');
  const limit = options && Number.isFinite(options.limit) ? options.limit : 0;

  const sendProgress = (p) => { if (wc && !wc.isDestroyed()) wc.send('msfs-extract-progress', p); };

  try {
    const summary = await runMsfsExtraction({
      outDir,
      window: 100,
      limit,
      appName: 'BackcountryPathfinders-Extract',
      onProgress: sendProgress,
    });
    if (summary && summary.file) airportsData.reload();   // recharge la base fraîche
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'extraction échouée' };
  } finally {
    _msfsExtractRunning = false;
  }
});

// Extraction des NAVAIDS MSFS 2024 (VOR/NDB) — méthode traversance airways (repris
// de NavXpressVFR). Produit navaids.jsonl, progression via 'msfs-navaids-progress'.
let _navaidsExtractRunning = false;
ipcMain.handle('extraire-navaids-msfs', async (event) => {
  if (_navaidsExtractRunning) return { ok: false, error: 'Une extraction est déjà en cours.' };
  _navaidsExtractRunning = true;
  const wc = event.sender;
  const outDir = path.join(dossierBase(), 'data');

  const sendProgress = (p) => { if (wc && !wc.isDestroyed()) wc.send('msfs-navaids-progress', p); };

  try {
    const summary = await runNavaidsExtraction({ outDir, window: 80, onProgress: sendProgress });
    if (summary && summary.file) airportsData.reload();
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'extraction échouée' };
  } finally {
    _navaidsExtractRunning = false;
  }
});

// ============================================================
// Import des données d'élévation (dataset GLOBE ~1 km, all10g.zip). Repris de
// NavXpressVFR : télécharge l'archive NOAA, l'extrait, aplatit le sous-dossier
// all10/ dans Documents/Backcountry Pathfinders/elevation, supprime l'archive.
// Progression relayée au renderer via 'elevation-progress'.
// ============================================================

// Téléchargement HTTPS vers un fichier, avec suivi des redirections et progression.
function downloadToFile(url, destPath, onProgress, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const doGet = (currentUrl, redirectsLeft) => {
      const req = https.get(currentUrl, { headers: { 'User-Agent': 'BackcountryPathfinders-Desktop' } }, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          if (redirectsLeft <= 0) { res.resume(); reject(new Error('Trop de redirections pour ' + url)); return; }
          res.resume();
          doGet(new URL(headers.location, currentUrl).toString(), redirectsLeft - 1);
          return;
        }
        if (statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + statusCode + ' pour ' + currentUrl)); return; }

        const total = parseInt(headers['content-length'] || '0', 10);
        let received = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => { received += chunk.length; if (onProgress) onProgress(received, total); });
        res.on('error', (e) => { out.destroy(); reject(e); });
        out.on('error', (e) => reject(e));
        out.on('finish', () => out.close(() => resolve({ received, total })));
        res.pipe(out);
      });
      req.on('error', reject);
      req.setTimeout(90000, () => req.destroy(new Error('Timeout (90 s sans données) pour ' + currentUrl)));
    };
    doGet(url, maxRedirects);
  });
}

function elevationDir() { return path.join(dossierBase(), 'elevation'); }

// Les tuiles GLOBE (bandes N/moyennes/S) sont-elles installées ?
function elevationTilesPresent() {
  const dir = elevationDir();
  return ['a10g', 'g10g', 'p10g'].every((t) => fs.existsSync(path.join(dir, t)));
}

ipcMain.handle('elevation-existe', async () => {
  try { return elevationTilesPresent(); } catch (_) { return false; }
});

const ELEVATION_ZIP_URL = 'https://www.ngdc.noaa.gov/mgg/topo/DATATILES/elev/all10g.zip';
let _elevationImportRunning = false;
ipcMain.handle('importer-elevation', async (event) => {
  if (_elevationImportRunning) return { ok: false, error: 'Un import est déjà en cours.' };
  _elevationImportRunning = true;
  const wc = event.sender;
  const dir = elevationDir();
  const zipPath = path.join(dir, 'all10g.zip');
  const send = (p) => { if (wc && !wc.isDestroyed()) wc.send('elevation-progress', p); };

  try {
    fs.mkdirSync(dir, { recursive: true });
    resetGlobeFds();   // libère d'éventuels descripteurs GLOBE ouverts (cas du réimport)
    send({ type: 'start' });

    // 1) Téléchargement (progression limitée à ~4 msg/s)
    let lastSent = 0;
    await downloadToFile(ELEVATION_ZIP_URL, zipPath, (received, total) => {
      const now = Date.now();
      if (now - lastSent >= 250 || (total && received >= total)) {
        lastSent = now;
        send({ type: 'download', received, total });
      }
    });

    // 2) Extraction de l'archive
    send({ type: 'extract' });
    await extract(zipPath, { dir });

    // 3) Aplatissement : déplace elevation/all10/* vers elevation/
    send({ type: 'flatten' });
    const all10Dir = path.join(dir, 'all10');
    if (fs.existsSync(all10Dir)) {
      for (const name of fs.readdirSync(all10Dir)) {
        const src = path.join(all10Dir, name);
        const dst = path.join(dir, name);
        try { if (fs.existsSync(dst)) fs.rmSync(dst, { force: true }); } catch (_) {}
        fs.renameSync(src, dst);
      }
      try { fs.rmSync(all10Dir, { recursive: true, force: true }); } catch (_) {}
    }

    // 4) Nettoyage de l'archive
    try { fs.rmSync(zipPath, { force: true }); } catch (_) {}

    const ok = elevationTilesPresent();
    send({ type: 'done', dir, ok });
    return { ok, dir };
  } catch (err) {
    console.error('[Elevation] Import échec :', err);
    try { if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true }); } catch (_) {}
    send({ type: 'error', error: (err && err.message) || String(err) });
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    _elevationImportRunning = false;
  }
});

// ============================================================
// Lecture du relief (dataset GLOBE 30 arc-sec, ~1 km) + profil vertical.
// 16 tuiles a10g..p10g pavant le globe ; entiers 16-bit signés little-endian, en
// mètres, depuis le coin NO de chaque tuile. Océan / no-data = -500. Repris de
// NavXpressVFR.
// ============================================================
const GLOBE_COLS = 10800;          // colonnes par tuile (90° à 30")
const GLOBE_CELL = 1 / 120;        // degrés par cellule (30 arc-sec)
const GLOBE_BANDS = [
  { latMax: 90,  rows: 4800, tiles: ['a10g', 'b10g', 'c10g', 'd10g'] }, // 50°N..90°N
  { latMax: 50,  rows: 6000, tiles: ['e10g', 'f10g', 'g10g', 'h10g'] }, // 0°..50°N
  { latMax: 0,   rows: 6000, tiles: ['i10g', 'j10g', 'k10g', 'l10g'] }, // 50°S..0°
  { latMax: -50, rows: 4800, tiles: ['m10g', 'n10g', 'o10g', 'p10g'] }, // 90°S..50°S
];
const _globeFds = new Map();   // nom tuile -> descripteur (null si fichier absent)

function _globeFd(tile) {
  if (_globeFds.has(tile)) return _globeFds.get(tile);
  let fd = null;
  try { fd = fs.openSync(path.join(elevationDir(), tile), 'r'); } catch (_) { fd = null; }
  _globeFds.set(tile, fd);
  return fd;
}

// Élévation en mètres à (lat, lon). null si tuile absente, 0 pour océan/no-data.
const _globeBuf = Buffer.alloc(2);
function lireElevation(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return 0;
  const la = Math.max(-90, Math.min(90, lat));
  const lo = ((lon + 180) % 360 + 360) % 360 - 180;
  let b;
  if (la >= 50) b = 0; else if (la >= 0) b = 1; else if (la >= -50) b = 2; else b = 3;
  const band = GLOBE_BANDS[b];
  let g = Math.floor((lo + 180) / 90);
  if (g < 0) g = 0; else if (g > 3) g = 3;
  const fd = _globeFd(band.tiles[g]);
  if (fd == null) return null;
  let row = Math.floor((band.latMax - la) / GLOBE_CELL);
  if (row < 0) row = 0; else if (row >= band.rows) row = band.rows - 1;
  let col = Math.floor((lo - (-180 + g * 90)) / GLOBE_CELL);
  if (col < 0) col = 0; else if (col >= GLOBE_COLS) col = GLOBE_COLS - 1;
  try { fs.readSync(fd, _globeBuf, 0, 2, (row * GLOBE_COLS + col) * 2); } catch (_) { return null; }
  const v = _globeBuf.readInt16LE(0);
  return v <= -500 ? 0 : v;
}

// Distance grand-cercle en milles nautiques.
function _distNM(aLat, aLon, bLat, bLon) {
  const R = 3440.065, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLon = (bLon - aLon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Ferme et oublie les descripteurs GLOBE ouverts (avant un (ré)import).
function resetGlobeFds() {
  for (const fd of _globeFds.values()) {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  _globeFds.clear();
}

// Profil vertical : échantillonne le relief GLOBE le long du plan de vol.
// payload = { waypoints: [{lat,lon,name}], legAltitudes: [null, alt1, alt2, ...] }
ipcMain.handle('profil-vertical', async (_e, payload) => {
  const wps = Array.isArray(payload && payload.waypoints) ? payload.waypoints : [];
  const legAlt = Array.isArray(payload && payload.legAltitudes) ? payload.legAltitudes : [];
  if (wps.length < 2) return { ok: false, dist: [], terrain: [], planned: [], waypoints: [] };

  const M2FT = 3.28084;
  const ALT_FALLBACK = 2500;

  const legDist = [];
  let totalNM = 0;
  for (let i = 1; i < wps.length; i++) {
    const d = _distNM(wps[i - 1].lat, wps[i - 1].lon, wps[i].lat, wps[i].lon);
    legDist[i] = d;
    totalNM += d;
  }

  const MAX_SAMPLES = 1500;
  const totalKm = totalNM * 1.852;
  let stepKm = 1.0;
  if (totalKm / stepKm > MAX_SAMPLES) stepKm = totalKm / MAX_SAMPLES;

  // Altitude minimale de sécurité (par leg) : relief max sous l'axe + marge selon
  // la rugosité (plaine +1000 ft, montagne +1500 ft si amplitude > 1500 ft).
  const MARGIN_PLAIN_FT = 1000, MARGIN_MOUNTAIN_FT = 1500, MOUNTAIN_AMPL_FT = 1500;

  const dist = [], terrain = [], planned = [], waypoints = [], legs = [];
  let cumNM = 0, gotData = false, summitFt = -Infinity, summitD = 0;
  waypoints.push({ d: 0, name: (wps[0].name || '') });

  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1], b = wps[i];
    const legNM = legDist[i];
    const altFt = (legAlt[i] != null ? legAlt[i] : ALT_FALLBACK);
    const nSeg = Math.max(1, Math.round((legNM * 1.852) / stepKm));
    let legMax = -Infinity, legMin = Infinity;
    for (let s = (i === 1 ? 0 : 1); s <= nSeg; s++) {
      const f = s / nSeg;
      const lat = a.lat + (b.lat - a.lat) * f;
      const lon = a.lon + (b.lon - a.lon) * f;
      const eRaw = lireElevation(lat, lon);
      if (eRaw != null) gotData = true;
      const terrFt = (eRaw == null ? 0 : eRaw) * M2FT;
      const d = cumNM + legNM * f;
      dist.push(d); terrain.push(terrFt); planned.push(altFt);
      if (terrFt > legMax) legMax = terrFt;
      if (terrFt < legMin) legMin = terrFt;
      if (terrFt > summitFt) { summitFt = terrFt; summitD = d; }
    }
    const terrMaxFt = (legMax === -Infinity ? 0 : legMax);
    const amplitudeFt = (legMax === -Infinity ? 0 : legMax - legMin);
    const mountain = amplitudeFt > MOUNTAIN_AMPL_FT;
    const marginFt = mountain ? MARGIN_MOUNTAIN_FT : MARGIN_PLAIN_FT;
    const safeAltFt = Math.ceil((terrMaxFt + marginFt) / 100) * 100;
    legs.push({
      i, dStart: cumNM, dEnd: cumNM + legNM,
      name0: (a.name || ''), name1: (b.name || ''),
      terrMaxFt: Math.round(terrMaxFt), amplitudeFt: Math.round(amplitudeFt),
      mountain, marginFt, safeAltFt, plannedFt: Math.round(altFt),
      breach: altFt < safeAltFt, clearanceFt: Math.round(altFt - terrMaxFt),
    });
    cumNM += legNM;
    waypoints.push({ d: cumNM, name: (b.name || '') });
  }

  if (!gotData) return { ok: false, reason: 'no-data', dist: [], terrain: [], planned: [], waypoints: [] };

  let minMargin = null;
  for (const lg of legs) {
    if (minMargin == null || lg.clearanceFt < minMargin.clearanceFt) {
      minMargin = { clearanceFt: lg.clearanceFt, name0: lg.name0, name1: lg.name1, breach: lg.breach };
    }
  }
  const summary = {
    summitFt: Math.round(summitFt === -Infinity ? 0 : summitFt),
    summitD, minMargin, anyBreach: legs.some((lg) => lg.breach),
  };
  return { ok: true, totalNM, dist, terrain, planned, waypoints, legs, summary };
});

// --- Données carte : aéroports / navaids par bounding box ---
ipcMain.handle('aeroports-bbox', async (_e, bbox) => airportsData.aeroportsDansBbox(bbox));
ipcMain.handle('navaids-bbox', async (_e, bbox) => airportsData.navaidsDansBbox(bbox));
ipcMain.handle('aeroport-par-code', async (_e, code) => airportsData.aeroportParCode(code));

// Feature (aéroport/navaid) le plus proche d'un point, dans un rayon (NM).
ipcMain.handle('feature-proche', async (_e, { lat, lon, rayonNm } = {}) => airportsData.featureProche(lat, lon, rayonNm));

// Sauvegarde d'un plan de vol (.bcpfc) : dialogue natif « Enregistrer sous »,
// puis écriture du plan en JSON. `nomSuggere` = nom de fichier proposé.

// Dossier des plans de vol : Documents/backcountry pathfinders/flights plans
// (créé si absent).
function dossierPlansVol() {
  const dir = path.join(app.getPath('documents'), 'backcountry pathfinders', 'flights plans');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* repli silencieux */ }
  return dir;
}

ipcMain.handle('sauver-plan', async (_e, { nomSuggere, titre, plan } = {}) => {
  try {
    // Nettoie le nom des caractères interdits dans un nom de fichier Windows.
    let nom = String(nomSuggere || '').replace(/[\\/:*?"<>|]/g, '').trim();
    if (!nom) nom = 'plan-de-vol';
    if (!nom.toLowerCase().endsWith('.bcpfc')) nom += '.bcpfc';
    const res = await dialog.showSaveDialog(mainWindow, {
      title: titre || 'Sauvegarder le plan de vol',
      defaultPath: path.join(dossierPlansVol(), nom),
      filters: [{ name: 'Backcountry Pathfinders flight plan', extensions: ['bcpfc'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(plan, null, 2), 'utf-8');
    return { ok: true, filePath: res.filePath };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Ouverture d'un plan de vol (.bcpfc) : dialogue natif « Ouvrir », lecture JSON.
ipcMain.handle('ouvrir-plan', async (_e, { titre } = {}) => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: titre || 'Ouvrir un plan de vol',
      defaultPath: dossierPlansVol(),
      properties: ['openFile'],
      filters: [{ name: 'Backcountry Pathfinders flight plan', extensions: ['bcpfc'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    const plan = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
    return { ok: true, plan, filePath: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Déclinaison magnétique (WMM) en un point : decl en degrés, + = Est.
ipcMain.handle('declinaison', async (_e, { lat, lon } = {}) => {
  try {
    const info = geomagnetism.model().point([lat, lon]);
    return { ok: true, decl: info.decl };
  } catch (_) {
    return { ok: false, decl: 0 };
  }
});

// Lieux de poser des utilisateurs (depuis la base du site, GET /api/lieux).
ipcMain.handle('lieux-all', async () => recupererLieux(config));

// Redémarre et installe la mise à jour téléchargée (clic sur la bannière).
ipcMain.handle('update-install', async () => { quitAndInstall(); return { ok: true }; });

app.whenReady().then(() => {
  const splash = createSplash();
  createWindow();   // fenêtre principale masquée, chargée pendant le splash
  // Après 4 s : ferme le splash et révèle la fenêtre principale.
  setTimeout(() => {
    if (splash && !splash.isDestroyed()) splash.close();
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.maximize(); mainWindow.show(); mainWindow.focus(); }
  }, 4000);
  flushQueue();
  setInterval(flushQueue, 60000);
  // Auto-update seulement en app packagée : en dev, electron-updater n'a pas de
  // dev-app-update.yml et lèverait une erreur inutile.
  if (app.isPackaged) setupAutoUpdater(broadcast, mainWindow);
});

app.on('window-all-closed', () => {
  sim.deconnecter().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();                 // recréée masquée (show:false)…
    mainWindow.once('ready-to-show', () => { mainWindow.maximize(); mainWindow.show(); });   // …agrandie puis affichée
  }
});
