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

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { chargerConfig, enregistrerCle, dossierBase } = require('./config');
const { SimConnectClient } = require('./simconnect');
const { createFsm } = require('./fsm');
const { envoyer } = require('./api-client');
const { capturerVersFichier } = require('./capture');
const { enfiler, compter, flush } = require('./queue');

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
    await flush(dossiers().queue, (r) => envoyer(config, r, r._capturePath || null));
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

// Envoi groupé de tous les posers du vol (fin de vol).
ipcMain.handle('envoyer-tout', async (_e, landings) => {
  if (!config._cleConfiguree) {
    return { ok: false, erreur: 'Clé API non configurée (config.json).' };
  }
  // Règle : un poser SANS photo n'est pas valide → on ne l'envoie pas.
  const valides = (landings || []).filter((l) => l.hasCapture);
  let envoyes = 0; let enfiles = 0; let echecs = 0;
  for (const l of valides) {
    const imagePath = cheminCapture(l.uid);
    const payload = { ...l.releve, _uid: l.uid, _capturePath: imagePath };
    const res = await envoyer(config, payload, imagePath);
    if (res.ok) {
      envoyes++;
    } else if (!res.status || res.status === 0) {
      enfiler(dossiers().queue, payload);   // hors-ligne → file
      enfiles++;
    } else {
      echecs++;                              // refus serveur (4xx/5xx)
    }
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

app.whenReady().then(() => {
  createWindow();
  flushQueue();
  setInterval(flushQueue, 60000);
});

app.on('window-all-closed', () => {
  sim.deconnecter().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
