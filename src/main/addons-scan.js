/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// addons-scan.js — quels aérodromes de la base viennent d'un add-on ?
//
// ── Pourquoi lire le disque ─────────────────────────────────────────────────
// La base est extraite du simulateur par l'API Facility de SimConnect
// (extract-airports-msfs.js), et le simulateur ne dit JAMAIS d'où vient un
// terrain : stock ou add-on, il renvoie la même fiche. C'est la limite bien
// connue qui empêche Little Navmap de marquer les add-ons sous MSFS 2024.
// L'information n'existe donc que dans les paquets posés sur le disque.
//
// ── Comment un paquet livre son ident ───────────────────────────────────────
// Un paquet de terrain contient un BGL dont la section « aéroport » (type 3)
// porte un enregistrement par terrain. Deux variantes coexistent dans une
// bibliothèque MSFS 2024 :
//
//   • 0x0056 — hérité de MSFS 2020 : l'ident y est compacté sur 32 bits.
//   • 0x0113 — nouveau en 2024 : plus d'ident compacté du tout.
//
// On ne lit donc PAS l'ident : on lit la POSITION, présente au même offset
// dans les deux (longitude +12, latitude +16, encodage FSX classique), et on
// la rapproche du terrain le plus proche de la base. C'est plus sûr qu'un
// ident — une position ne se décode pas de travers — et cela couvre les
// paquets dont le nom ne dit rien (« brooker », « northcoaster76-* »).
//
// Reste les paquets qui n'ajoutent que des objets autour d'un terrain déjà
// présent : pas d'enregistrement aéroport, donc rien à rapprocher. Pour ceux-là
// seulement, on retombe sur les mots du nom de dossier, des noms de BGL et du
// titre du manifest, retenus uniquement s'ils existent tels quels dans la base.
// Ce repli n'est PAS appliqué aux paquets déjà rattachés : « …-lflg-airstrips »
// contient huit terrains qui ne sont pas LFLG, et le nom mentirait.
// ============================================================

const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');

const { dossierBase } = require('./config');

const MAGIC_BGL = 0x19920201;
const SECTION_AEROPORT = 0x03;
// FSX · MSFS 2020 · MSFS 2024. Les trois portent lon/lat aux mêmes offsets.
const RECORDS_AEROPORT = new Set([0x003c, 0x0056, 0x0113]);

const RAYON_RATTACHEMENT_NM = 2;   // au-delà, le record ne désigne pas ce terrain
const PROFONDEUR_MAX = 8;          // garde-fou de récursion
const MAX_SECTIONS = 512;          // en-tête incohérent → on abandonne le fichier
// Un BGL de définition d'aéroport pèse quelques dizaines de Ko ; au-delà on est
// sur du terrain ou de la photogrammétrie, qu'il serait absurde de charger en
// mémoire pour n'y rien trouver.
const TAILLE_MAX_BGL = 64 * 1024 * 1024;

// ------------------------------------------------------------
// Lecture BGL
// ------------------------------------------------------------

// Positions des enregistrements « aéroport » d'un BGL. Tolérant : un fichier
// illisible ou d'un autre format rend un tableau vide, jamais une exception.
function positionsBgl(fichier) {
  let buf;
  try {
    if (fs.statSync(fichier).size > TAILLE_MAX_BGL) return [];
    buf = fs.readFileSync(fichier);
  } catch (_) { return []; }
  if (buf.length < 56 || buf.readUInt32LE(0) !== MAGIC_BGL) return [];

  const tailleEntete = buf.readUInt32LE(4);
  const nSections = buf.readUInt32LE(20);
  if (nSections > MAX_SECTIONS) return [];

  const positions = [];
  for (let i = 0; i < nSections; i++) {
    const o = tailleEntete + i * 20;
    if (o + 20 > buf.length) break;
    if (buf.readUInt32LE(o) !== SECTION_AEROPORT) continue;

    const drapeau = buf.readUInt32LE(o + 4);
    const nSous = buf.readUInt32LE(o + 8);
    const debut = buf.readUInt32LE(o + 12);
    // L'en-tête de sous-section fait 16 ou 20 octets selon ce drapeau.
    const taille = ((drapeau & 0x10000) | 0x40000) >>> 14;
    const decalage = taille === 16 ? 0 : 4;   // le format 20 o insère un second QMID

    for (let j = 0; j < nSous; j++) {
      const so = debut + j * taille;
      if (so + taille > buf.length) break;
      const nRec = buf.readUInt32LE(so + 4 + decalage);
      let p = buf.readUInt32LE(so + 8 + decalage);

      for (let k = 0; k < nRec; k++) {
        if (p < 0 || p + 20 > buf.length) break;
        const id = buf.readUInt16LE(p);
        const octets = buf.readUInt32LE(p + 2);
        if (RECORDS_AEROPORT.has(id) && octets >= 20) {
          // Encodage FSX : longitude sur 3·2^28 pour 360°, latitude sur 2·2^28
          // pour 180°, comptée depuis le pôle Nord.
          const lon = buf.readUInt32LE(p + 12) * (360 / (3 * 0x10000000)) - 180;
          const lat = 90 - buf.readUInt32LE(p + 16) * (180 / (2 * 0x10000000));
          if (Number.isFinite(lat) && Number.isFinite(lon)
              && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) positions.push({ lat, lon });
        }
        if (!octets) break;   // taille nulle : on ne saurait pas avancer
        p += octets;
      }
    }
  }
  return positions;
}

// ------------------------------------------------------------
// Parcours des paquets
// ------------------------------------------------------------

// Un paquet = un dossier portant un manifest.json. On ne descend pas dedans :
// les sous-dossiers d'un paquet ne sont pas des paquets. Accepte donc aussi
// bien une racine rangée par catégories qu'un dossier de paquets à plat.
function listerPaquets(racine, profondeur = 0, out = []) {
  if (profondeur > PROFONDEUR_MAX) return out;
  let entrees;
  try { entrees = fs.readdirSync(racine, { withFileTypes: true }); } catch (_) { return out; }
  if (entrees.some((e) => e.isFile() && e.name.toLowerCase() === 'manifest.json')) {
    out.push(racine);
    return out;
  }
  for (const e of entrees) {
    if (e.isDirectory()) listerPaquets(path.join(racine, e.name), profondeur + 1, out);
  }
  return out;
}

function fichiersBgl(dir, profondeur = 0, out = []) {
  if (profondeur > PROFONDEUR_MAX) return out;
  let entrees;
  try { entrees = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entrees) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fichiersBgl(p, profondeur + 1, out);
    else if (e.name.toLowerCase().endsWith('.bgl')) out.push(p);
  }
  return out;
}

// Mots d'un paquet susceptibles d'être un ident : nom de dossier, noms de BGL,
// titre du manifest. Découpés sur tout ce qui n'est ni lettre ni chiffre.
function jetons(dirPaquet, bgls) {
  const set = new Set();
  const ajouter = (s) => {
    for (const mot of String(s == null ? '' : s).split(/[^A-Za-z0-9]+/)) {
      if (mot.length >= 3 && mot.length <= 6) set.add(mot.toUpperCase());
    }
  };
  ajouter(path.basename(dirPaquet));
  for (const f of bgls) ajouter(path.basename(f).replace(/\.bgl$/i, ''));
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dirPaquet, 'manifest.json'), 'utf-8'));
    ajouter(m && m.title);
  } catch (_) {}
  return set;
}

// ------------------------------------------------------------
// Rapprochement avec la base
// ------------------------------------------------------------

function distNm(la1, lo1, la2, lo2) {
  const R = 3440.065;
  const f1 = la1 * Math.PI / 180, f2 = la2 * Math.PI / 180;
  const df = (la2 - la1) * Math.PI / 180, dl = (lo2 - lo1) * Math.PI / 180;
  const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Grille au degré : chercher le plus proche parmi 85 000 terrains, une centaine
// de fois, ne justifie pas d'index plus savant, mais un balayage complet si.
function construireGrille(aeroports) {
  const grille = new Map();
  for (const a of aeroports) {
    const k = Math.floor(a.lat) + '/' + Math.floor(a.lon);
    let seau = grille.get(k);
    if (!seau) { seau = []; grille.set(k, seau); }
    seau.push(a);
  }
  return grille;
}

function plusProche(grille, lat, lon) {
  let best = null;
  const la0 = Math.floor(lat), lo0 = Math.floor(lon);
  for (let dla = -1; dla <= 1; dla++) {
    for (let dlo = -1; dlo <= 1; dlo++) {
      const seau = grille.get((la0 + dla) + '/' + (lo0 + dlo));
      if (!seau) continue;
      for (const a of seau) {
        const d = distNm(lat, lon, a.lat, a.lon);
        if (!best || d < best.distNm) best = { aeroport: a, distNm: d };
      }
    }
  }
  return best;
}

// ------------------------------------------------------------
// Scan
// ------------------------------------------------------------

function dossierDonnees() { return path.join(dossierBase(), 'data'); }
function cheminAddons() { return path.join(dossierDonnees(), 'addons.json'); }

// État courant : ce que le dernier scan a écrit. Sert à pré-remplir le
// sélecteur de dossier et à afficher le résumé sans relancer d'analyse.
function etat() {
  try {
    const obj = JSON.parse(fs.readFileSync(cheminAddons(), 'utf-8'));
    const meta = obj && obj.__meta ? obj.__meta : {};
    return {
      ok: true,
      present: true,
      racine: meta.racine || '',
      date: meta.date || '',
      paquets: meta.paquets || 0,
      rattaches: meta.rattaches || 0,
      aerodromes: Object.keys((obj && obj.aeroports) || {}).length,
    };
  } catch (_) {
    return { ok: true, present: false, racine: '', date: '', paquets: 0, rattaches: 0, aerodromes: 0 };
  }
}

// Analyse une racine de paquets et écrit data/addons.json.
// `aeroports` est la liste normalisée d'airports-data : on réutilise SON champ
// `code`, sans quoi le marquage porterait sur un code que la carte n'affiche pas.
function scanner({ racine, aeroports } = {}) {
  const dir = String(racine || '').trim();
  if (!dir) return { ok: false, error: 'no-root' };
  let st;
  try { st = fs.statSync(dir); } catch (_) { return { ok: false, error: 'root-missing' }; }
  if (!st.isDirectory()) return { ok: false, error: 'root-missing' };
  if (!Array.isArray(aeroports) || !aeroports.length) return { ok: false, error: 'no-data' };

  const grille = construireGrille(aeroports);
  const codes = new Set();   // codes de la base, pour le repli par nom
  for (const a of aeroports) {
    const c = String(a.code || a.ident || '').toUpperCase();
    if (c) codes.add(c);
  }

  const paquets = listerPaquets(dir);
  const trouves = {};        // CODE → nom du paquet
  let parPosition = 0, parNom = 0, sansRattachement = 0;

  for (const p of paquets) {
    const nom = path.basename(p);
    const bgls = fichiersBgl(p);
    const positions = [];
    for (const f of bgls) positions.push(...positionsBgl(f));

    let compte = 0;
    for (const pos of positions) {
      const pp = plusProche(grille, pos.lat, pos.lon);
      if (!pp || pp.distNm > RAYON_RATTACHEMENT_NM) continue;
      const code = String(pp.aeroport.code || pp.aeroport.ident || '').toUpperCase();
      if (!code) continue;
      if (!trouves[code]) trouves[code] = nom;
      compte++;
    }
    if (compte) { parPosition++; continue; }

    // Repli par le nom, réservé aux paquets qu'aucune position n'a rattachés.
    for (const j of jetons(p, bgls)) {
      if (!codes.has(j)) continue;
      if (!trouves[j]) trouves[j] = nom;
      compte++;
    }
    if (compte) parNom++; else sansRattachement++;
  }

  const meta = {
    version: 1,
    racine: dir,
    date: new Date().toISOString(),
    paquets: paquets.length,
    rattaches: parPosition + parNom,
    parPosition,
    parNom,
    sansRattachement,
  };
  try {
    fs.mkdirSync(dossierDonnees(), { recursive: true });
    fs.writeFileSync(cheminAddons(), JSON.stringify({ __meta: meta, aeroports: trouves }, null, 2), 'utf-8');
  } catch (err) {
    return { ok: false, error: 'write-failed', detail: (err && err.message) || '' };
  }

  return { ok: true, ...meta, aerodromes: Object.keys(trouves).length };
}

// Sélection de la racine des paquets. Pré-ouvert sur la racine du dernier scan
// quand il y en a eu un : on revient presque toujours au même dossier.
async function choisirDossier(fenetre) {
  const precedent = etat().racine;
  const options = { properties: ['openDirectory'], title: 'Dossier des paquets add-on' };
  if (precedent) options.defaultPath = precedent;
  const res = await dialog.showOpenDialog(fenetre, options);
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, annule: true };
  return { ok: true, racine: res.filePaths[0] };
}

module.exports = { scanner, etat, choisirDossier, cheminAddons };
