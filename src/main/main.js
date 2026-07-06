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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    backgroundColor: '#161310',
    title: 'Backcountry Pathfinders',
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
  createWindow();
  flushQueue();
  setInterval(flushQueue, 60000);
  // Auto-update seulement en app packagée : en dev, electron-updater n'a pas de
  // dev-app-update.yml et lèverait une erreur inutile.
  if (app.isPackaged) setupAutoUpdater(broadcast);
});

app.on('window-all-closed', () => {
  sim.deconnecter().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
