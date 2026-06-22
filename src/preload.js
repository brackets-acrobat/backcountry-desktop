/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// preload.js — pont sécurisé renderer ↔ main (contextIsolation).
// (Rappel NavXpress : NE JAMAIS require() un fichier ici sous sandbox.)
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld('bc', {
  // Requêtes (renderer → main)
  getConfig:    () => ipcRenderer.invoke('app-config'),
  setApiKey:    (apiKey, apiBaseUrl) => ipcRenderer.invoke('config-set-key', { apiKey, apiBaseUrl }),
  connect:      () => ipcRenderer.invoke('sc-connect'),
  disconnect:   () => ipcRenderer.invoke('sc-disconnect'),
  captureNow:   (uid) => ipcRenderer.invoke('capture-now', uid),
  envoyerTout:  (landings) => ipcRenderer.invoke('envoyer-tout', landings),
  flightDiscard: () => ipcRenderer.invoke('flight-discard'),
  etatFile:     () => ipcRenderer.invoke('queue-status'),
  relancerFile: () => ipcRenderer.invoke('queue-flush'),

  // Import des aéroports MSFS 2024
  msfsVerifierLancement: () => ipcRenderer.invoke('msfs-verifier-lancement'),
  msfsExtraireAeroports: (options) => ipcRenderer.invoke('extraire-aeroports-msfs', options),
  onMsfsExtractProgress: (cb) => subscribe('msfs-extract-progress', cb),

  // Import des navaids MSFS 2024
  msfsExtraireNavaids: () => ipcRenderer.invoke('extraire-navaids-msfs'),
  onMsfsNavaidsProgress: (cb) => subscribe('msfs-navaids-progress', cb),

  // Données carte (par bounding box)
  aeroportsDansBbox: (bbox) => ipcRenderer.invoke('aeroports-bbox', bbox),
  navaidsDansBbox: (bbox) => ipcRenderer.invoke('navaids-bbox', bbox),

  // Lieux de poser des utilisateurs (base du site)
  lieux: () => ipcRenderer.invoke('lieux-all'),

  // Abonnements (main → renderer). Chaque appel renvoie une fonction de désabonnement.
  onConfig:          (cb) => subscribe('app-config', cb),
  onStatus:          (cb) => subscribe('sc-status', cb),
  onScan:            (cb) => subscribe('sc-scan', cb),
  onLandingRecorded: (cb) => subscribe('fsm-landing-recorded', cb),
  onCaptureState:    (cb) => subscribe('fsm-capture-state', cb),
  onFlightEnded:     (cb) => subscribe('fsm-flight-ended', cb),
  onQueueStatus:     (cb) => subscribe('queue-status', cb),
});
