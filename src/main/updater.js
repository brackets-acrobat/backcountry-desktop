/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// updater.js — mise à jour automatique via electron-updater (releases GitHub).
//
// Repris du mécanisme de NavXpressVFR : on interroge les releases GitHub
// (latest.yml) une fois le renderer CHARGÉ (did-finish-load) — donc après qu'il
// a posé ses écouteurs de MAJ, pour ne pas émettre les événements « dans le
// vide » (course au démarrage) — puis toutes les 6 h. electron-updater télécharge
// en tâche de fond ; l'installeur NSIS s'applique au prochain quit (ou via
// quitAndInstall depuis la bannière du renderer).
//
// L'état est diffusé au renderer via le canal 'update-status' :
//   { state: 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error', … }
// et mémorisé (_lastState) pour être REJOUÉ à la demande via 'update-get-state'
// (filet complémentaire si le renderer se (re)charge après un événement).
// ============================================================

const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');

const SIX_HOURS = 6 * 60 * 60 * 1000;

let _lastState = null;   // dernier état diffusé (rejoué au renderer)

// Le renderer, une fois prêt, réclame le dernier état connu (rattrape un
// événement émis avant que ses écouteurs soient posés). Enregistré au chargement
// du module → toujours disponible, renvoie null tant qu'aucun état n'a été émis.
ipcMain.handle('update-get-state', () => _lastState);

function setupAutoUpdater(broadcast, win) {
  autoUpdater.autoDownload = true;             // télécharge dès qu'une version est dispo
  autoUpdater.autoInstallOnAppQuit = true;     // pose la MAJ à la fermeture si non redémarré

  const emit = (payload) => { _lastState = payload; broadcast('update-status', payload); };

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }));
  autoUpdater.on('update-available',    (info) => emit({ state: 'available', version: info && info.version }));
  autoUpdater.on('update-not-available', () => emit({ state: 'none' }));
  autoUpdater.on('download-progress',   (p) => emit({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on('update-downloaded',   (info) => emit({ state: 'ready', version: info && info.version }));
  autoUpdater.on('error',               (err) => emit({ state: 'error', message: (err && err.message) || String(err) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => { /* silencieux (hors-ligne, etc.) */ });

  // Vérification une fois le renderer chargé (écouteurs de MAJ posés), sinon
  // immédiatement. Puis toutes les 6 h.
  const wc = win && win.webContents;
  if (wc && wc.isLoading()) wc.once('did-finish-load', check);
  else check();
  setInterval(check, SIX_HOURS);
}

// Redémarre l'app et applique la mise à jour téléchargée (clic sur la bannière).
function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = { setupAutoUpdater, quitAndInstall };
