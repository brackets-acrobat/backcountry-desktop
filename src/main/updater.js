/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// updater.js — mise à jour automatique via electron-updater (releases GitHub).
//
// Repris du mécanisme de NavXpressVFR : au démarrage (léger différé) puis toutes
// les 6 h, on interroge les releases GitHub (latest.yml). electron-updater
// télécharge en tâche de fond ; l'installeur NSIS s'applique au prochain quit
// (ou immédiatement via quitAndInstall depuis la bannière du renderer).
//
// L'état est diffusé au renderer via le canal 'update-status' :
//   { state: 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error', … }
// ============================================================

const { autoUpdater } = require('electron-updater');

const SIX_HOURS = 6 * 60 * 60 * 1000;

function setupAutoUpdater(broadcast) {
  autoUpdater.autoDownload = true;             // télécharge dès qu'une version est dispo
  autoUpdater.autoInstallOnAppQuit = true;     // pose la MAJ à la fermeture si non redémarré

  autoUpdater.on('checking-for-update', () => broadcast('update-status', { state: 'checking' }));
  autoUpdater.on('update-available',    (info) => broadcast('update-status', { state: 'available', version: info && info.version }));
  autoUpdater.on('update-not-available', () => broadcast('update-status', { state: 'none' }));
  autoUpdater.on('download-progress',   (p) => broadcast('update-status', { state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded',   (info) => broadcast('update-status', { state: 'ready', version: info && info.version }));
  autoUpdater.on('error',               (err) => broadcast('update-status', { state: 'error', message: (err && err.message) || String(err) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* silencieux (hors-ligne, etc.) */ });
  setTimeout(check, 4000);        // laisse la fenêtre s'afficher avant de sonder le réseau
  setInterval(check, SIX_HOURS);
}

// Redémarre l'app et applique la mise à jour téléchargée (clic sur la bannière).
function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = { setupAutoUpdater, quitAndInstall };
