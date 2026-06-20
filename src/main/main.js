/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// main.js — process principal Electron.
//
// Rôle : créer la fenêtre, instancier le client SimConnect, relayer ses
// événements ('status' / 'scan') au renderer, et exposer les handlers IPC
// (connexion, déconnexion, envoi de relevé). La logique métier vit dans les
// modules dédiés (simconnect / fsm / scan / math-engine / capture / api-client).
// ============================================================

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { chargerConfig } = require('./config');
const { SimConnectClient } = require('./simconnect');
const { createFsm } = require('./fsm');
const { envoyerReleve } = require('./api-client');

let mainWindow = null;
let config = chargerConfig();
const sim = new SimConnectClient();

function broadcast(channel, payload) {
  BrowserWindow.getAllWindows().forEach((w) => {
    try { w.webContents.send(channel, payload); } catch (_) {}
  });
}

// FSM du poser : émet ses événements vers le renderer (préfixe fsm-).
const fsm = createFsm({ emit: (event, payload) => broadcast('fsm-' + event, payload) });

// Relais des événements SimConnect.
sim.on('status', (s) => broadcast('sc-status', s));
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

  // removeMenu() supprime les accélérateurs par défaut (Ctrl+R, F12…). On les
  // rebranche manuellement sur le renderer pour garder rechargement + DevTools.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    // Ctrl+R ou F5 → recharge le renderer
    if ((input.control && key === 'r') || key === 'f5') {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
    // Ctrl+Shift+I ou F12 → outils de développement
    if ((input.control && input.shift && key === 'i') || key === 'f12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

// --- IPC ---
ipcMain.handle('app-config', async () => ({
  apiBaseUrl: config.apiBaseUrl,
  cleConfiguree: config._cleConfiguree,
  source: config._source,
}));

ipcMain.handle('sc-connect', async () => sim.connecter());
ipcMain.handle('sc-disconnect', async () => { await sim.deconnecter(); return { ok: true }; });

ipcMain.handle('releve-envoyer', async (_e, releve) => {
  if (!config._cleConfiguree) {
    return { ok: false, status: 0, body: { erreur: 'Clé API non configurée (config.json).' } };
  }
  const res = await envoyerReleve(config, releve);
  if (res.ok) fsm.reset();   // poser enregistré → on repart à zéro pour le suivant
  return res;
});

// « Ne pas enregistrer » confirmé → on efface la session sans rien envoyer.
ipcMain.handle('releve-discard', async () => { fsm.reset(); return { ok: true }; });

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  sim.deconnecter().finally(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
