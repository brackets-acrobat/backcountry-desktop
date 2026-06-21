/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// config.js — chargement de la configuration locale.
//
// Lit config.json à la racine du projet (gitignoré, contient la clé API).
// Si absent, retombe sur config.example.json puis sur des défauts, en
// signalant que la clé API n'est pas configurée. Aucun secret n'est jamais
// écrit ici : c'est une lecture seule.
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const DEFAULTS = {
  apiBaseUrl: 'http://localhost/backcountry',
  apiKey: '',
  captureDir: '',
  captureMonitor: 0,
  dedupRadiusM: 150,
  lowPassMaxAglFt: 500,
};

function lireFichier(p) {
  try {
    const brut = fs.readFileSync(p, 'utf-8');
    const obj = JSON.parse(brut);
    // On ignore les clés de commentaire (préfixe _).
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));
  } catch (_) {
    return null;
  }
}

// Charge la config effective. Priorité : config.json > config.example.json > défauts.
function chargerConfig() {
  const local = lireFichier(path.join(ROOT, 'config.json'));
  const exemple = lireFichier(path.join(ROOT, 'config.example.json'));
  const cfg = { ...DEFAULTS, ...(exemple || {}), ...(local || {}) };

  const cleConfiguree = !!cfg.apiKey && cfg.apiKey !== 'REMPLACE-MOI-PAR-TA-CLE-API';

  return { ...cfg, _source: local ? 'config.json' : (exemple ? 'config.example.json' : 'défauts'), _cleConfiguree: cleConfiguree };
}

module.exports = { chargerConfig, DEFAULTS };
