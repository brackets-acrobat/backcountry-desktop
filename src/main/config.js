/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// config.js — chargement de la configuration locale.
//
// Priorité de lecture : settings.json (inscriptible — la clé API saisie dans
// l'UI y est écrite) > config.json (racine, gitignoré) > config.example.json >
// défauts. settings.json est le SEUL fichier écrit ici ; il est centralisé
// dans le dossier de travail « Documents/Backcountry Pathfinders » aux côtés
// de screenshots/ et queue/ (et non dans l'arborescence du code → fonctionne
// aussi quand l'app est packagée, l'asar étant en lecture seule).
// ============================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

// Dossier de travail commun (screenshots/, queue/, settings.json).
// Déterminé par captureDir (config.json/example) sinon « Documents/Backcountry
// Pathfinders ». NB : on ignore ici settings.json (qui s'y trouve) pour éviter
// toute dépendance circulaire — l'emplacement du dossier ne s'auto-déplace pas.
function dossierBase() {
  const exemple = lireFichier(path.join(ROOT, 'config.example.json'));
  const local = lireFichier(path.join(ROOT, 'config.json'));
  const captureDir = ((local && local.captureDir) || (exemple && exemple.captureDir) || '').trim();
  return captureDir || path.join(app.getPath('documents'), 'Backcountry Pathfinders');
}

// Réglages inscriptibles (clé API saisie dans l'UI), dans le dossier de travail.
function cheminSettings() {
  return path.join(dossierBase(), 'settings.json');
}

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

// Charge la config effective.
// Priorité : settings.json > config.json > config.example.json > défauts.
function chargerConfig() {
  const exemple = lireFichier(path.join(ROOT, 'config.example.json'));
  const local = lireFichier(path.join(ROOT, 'config.json'));
  const reglages = lireFichier(cheminSettings());
  const cfg = { ...DEFAULTS, ...(exemple || {}), ...(local || {}), ...(reglages || {}) };

  const cleConfiguree = !!cfg.apiKey && cfg.apiKey !== 'REMPLACE-MOI-PAR-TA-CLE-API';

  const source = (reglages && reglages.apiKey) ? 'paramètres'
    : (local ? 'config.json' : (exemple ? 'config.example.json' : 'défauts'));

  return { ...cfg, _source: source, _cleConfiguree: cleConfiguree };
}

// Persiste la clé API (et éventuellement l'URL de l'API) dans settings.json,
// puis renvoie la config rechargée. Une clé vide efface le réglage stocké.
function enregistrerCle(apiKey, apiBaseUrl) {
  const p = cheminSettings();
  const courant = lireFichier(p) || {};

  const cle = (apiKey || '').trim();
  if (cle) courant.apiKey = cle; else delete courant.apiKey;

  if (typeof apiBaseUrl === 'string') {
    const url = apiBaseUrl.trim();
    if (url) courant.apiBaseUrl = url; else delete courant.apiBaseUrl;
  }

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(courant, null, 2), 'utf-8');
  return chargerConfig();
}

module.exports = { chargerConfig, enregistrerCle, dossierBase, DEFAULTS };
