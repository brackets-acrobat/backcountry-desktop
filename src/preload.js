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
  envoyerTout:  (payload) => ipcRenderer.invoke('envoyer-tout', payload),
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

  // Import des données d'élévation (GLOBE all10g.zip)
  elevationExiste: () => ipcRenderer.invoke('elevation-existe'),
  importerElevation: () => ipcRenderer.invoke('importer-elevation'),
  onElevationProgress: (cb) => subscribe('elevation-progress', cb),

  // Profil vertical (relief GLOBE le long du plan de vol)
  profilVertical: (payload) => ipcRenderer.invoke('profil-vertical', payload),

  // Données carte (par bounding box)
  aeroportsDansBbox: (bbox) => ipcRenderer.invoke('aeroports-bbox', bbox),
  navaidsDansBbox: (bbox) => ipcRenderer.invoke('navaids-bbox', bbox),
  aeroportParCode: (code) => ipcRenderer.invoke('aeroport-par-code', code),
  declinaison: (lat, lon) => ipcRenderer.invoke('declinaison', { lat, lon }),
  featureProche: (lat, lon, rayonNm) => ipcRenderer.invoke('feature-proche', { lat, lon, rayonNm }),
  sauverPlan: (payload) => ipcRenderer.invoke('sauver-plan', payload),
  ouvrirPlan: (payload) => ipcRenderer.invoke('ouvrir-plan', payload),

  // Lieux de poser des utilisateurs (base du site)
  lieux: () => ipcRenderer.invoke('lieux-all'),

  // Mise à jour automatique (electron-updater)
  installUpdate: () => ipcRenderer.invoke('update-install'),

  // Abonnements (main → renderer). Chaque appel renvoie une fonction de désabonnement.
  onUpdateStatus:    (cb) => subscribe('update-status', cb),
  onConfig:          (cb) => subscribe('app-config', cb),
  onStatus:          (cb) => subscribe('sc-status', cb),
  onScan:            (cb) => subscribe('sc-scan', cb),
  onLandingRecorded: (cb) => subscribe('fsm-landing-recorded', cb),
  onCaptureState:    (cb) => subscribe('fsm-capture-state', cb),
  onFlightEnded:     (cb) => subscribe('fsm-flight-ended', cb),
  onQueueStatus:     (cb) => subscribe('queue-status', cb),
});
