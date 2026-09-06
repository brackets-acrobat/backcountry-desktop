/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// export-gtn750.js — dépose le plan de vol dans le GTN750 de PMS50.
//
// L'instrument n'offre pas de « parcourir » : sa documentation lui impose un
// nom et un emplacement uniques, et il ne regarde rien d'autre —
//   « The GTN750 import function checks only the file named fpl.pln. »
// L'export consiste donc à écrire CE fichier-là, à CET endroit-là, dans le
// paquet PMS50 du dossier Community. La suite se fait dans le simulateur, par
// le bouton Import de la page Flight Plan du GTN.
//
// Le dossier Community n'est pas à une place fixe : on le déplace, et Steam et
// le Microsoft Store ne rangent pas UserCfg.opt au même endroit. On lit donc
// InstalledPackagesPath dans ce fichier plutôt que de deviner un chemin.
//
// Cible : MSFS 2024 seulement — c'est déjà le simulateur dont l'application
// extrait ses terrains et ses navaids (extract-airports-msfs.js).
//
// Le XML est construit côté renderer (js/features/export-gtn750.js), comme le
// .bcpfc l'est par construirePlan() : ici on ne fait que poser le fichier.
// ============================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const NOM_FICHIER = 'fpl.pln';
const SOUS_DOSSIER = path.join('fpl', 'gtn750');
const PAQUET_OFFICIEL = 'pms50-instrument-gtn750';

// UserCfg.opt de MSFS 2024, aux deux emplacements possibles : Steam d'abord
// (Roaming), puis Microsoft Store — où le paquet s'appelle « Limitless ».
function cheminsUserCfg() {
  const chemins = [];
  try {
    chemins.push(path.join(app.getPath('appData'), 'Microsoft Flight Simulator 2024', 'UserCfg.opt'));
  } catch (_) { /* getPath peut échouer avant que l'app soit « ready » */ }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    chemins.push(path.join(local, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt'));
  }
  return chemins;
}

// Dossier Community de MSFS 2024, lu dans UserCfg.opt. null s'il est introuvable.
function dossierCommunity() {
  for (const cfg of cheminsUserCfg()) {
    let texte;
    try { texte = fs.readFileSync(cfg, 'utf-8'); } catch (_) { continue; }
    const m = /^\s*InstalledPackagesPath\s+"([^"]+)"/m.exec(texte);
    if (!m) continue;
    const community = path.join(m[1], 'Community');
    try { if (fs.statSync(community).isDirectory()) return community; } catch (_) { /* chemin périmé */ }
  }
  return null;
}

// Dossier d'import du GTN750 : <Community>/<paquet>/fpl/gtn750.
//
// Le paquet s'appelle « pms50-instrument-gtn750 », mais on ne se fie pas au seul
// nom : c'est la présence du sous-dossier fpl/gtn750 qui tranche. Beaucoup de
// mods portent « GTN750 » dans leur nom sans être l'instrument, et ce
// sous-dossier n'existe que chez lui.
function dossierImport(community) {
  let entrees;
  try { entrees = fs.readdirSync(community, { withFileTypes: true }); } catch (_) { return null; }
  const noms = entrees.filter((e) => e.isDirectory()).map((e) => e.name);
  // Le nom officiel passe en premier ; les variantes (versions à venir) suivent.
  noms.sort((a, b) => Number(b.toLowerCase() === PAQUET_OFFICIEL) - Number(a.toLowerCase() === PAQUET_OFFICIEL));
  for (const nom of noms) {
    if (!nom.toLowerCase().includes('pms50')) continue;
    const dir = path.join(community, nom, SOUS_DOSSIER);
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch (_) { /* pas ce paquet-là */ }
  }
  return null;
}

// Écrit le PLN sous son nom imposé. Le fichier précédent est remplacé : c'est le
// fonctionnement même de l'import du GTN, qui ne connaît que ce nom.
async function ecrire({ pln } = {}) {
  if (typeof pln !== 'string' || !pln.trim()) return { ok: false, raison: 'plan-vide' };
  const community = dossierCommunity();
  if (!community) return { ok: false, raison: 'sim-introuvable' };
  const dir = dossierImport(community);
  if (!dir) return { ok: false, raison: 'paquet-introuvable' };
  try {
    const cible = path.join(dir, NOM_FICHIER);
    fs.writeFileSync(cible, pln, 'utf-8');
    return { ok: true, filePath: cible };
  } catch (e) {
    return { ok: false, raison: 'ecriture', error: (e && e.message) || String(e) };
  }
}

module.exports = { ecrire, dossierCommunity, dossierImport };
