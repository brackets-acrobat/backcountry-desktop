/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// preload.js — pont sécurisé entre le renderer et le process principal.
// contextIsolation activé : on n'expose qu'une API minimale et explicite.
// (Rappel NavXpress : NE JAMAIS require() un fichier ici sous sandbox.)
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bc', {
  // Requêtes (renderer → main)
  getConfig:   () => ipcRenderer.invoke('app-config'),
  connect:     () => ipcRenderer.invoke('sc-connect'),
  disconnect:  () => ipcRenderer.invoke('sc-disconnect'),
  envoyerReleve: (releve) => ipcRenderer.invoke('releve-envoyer', releve),
  effacerReleve: () => ipcRenderer.invoke('releve-discard'),

  // Abonnements (main → renderer). Retourne une fonction de désabonnement.
  onStatus: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('sc-status', h);
    return () => ipcRenderer.removeListener('sc-status', h);
  },
  onScan: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('sc-scan', h);
    return () => ipcRenderer.removeListener('sc-scan', h);
  },

  // Événements de la FSM du poser.
  onTouchdown: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('fsm-touchdown', h);
    return () => ipcRenderer.removeListener('fsm-touchdown', h);
  },
  onProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('fsm-progress', h);
    return () => ipcRenderer.removeListener('fsm-progress', h);
  },
  onStopped: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('fsm-stopped', h);
    return () => ipcRenderer.removeListener('fsm-stopped', h);
  },
  onAwaitingDecision: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('fsm-awaiting-decision', h);
    return () => ipcRenderer.removeListener('fsm-awaiting-decision', h);
  },
});
