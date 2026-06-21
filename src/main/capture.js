/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// capture.js — capture d'écran du spot (façon Greenshot).
//
// Flux « cadrage manuel » : l'utilisateur cadre dans MSFS, puis clique Capture
// → on photographie immédiatement et on écrit le JPEG dans le dossier des
// screenshots, nommé avec l'uid du poser.
//
// CIBLAGE (vérifié au probe 21/06, plein écran exclusif, 2 moniteurs) :
//   1) FENÊTRE MSFS en priorité (rendu live OK même en plein écran exclusif) ;
//   2) repli capture d'ÉCRAN du moniteur `captureMonitor` si la fenêtre est
//      introuvable ou noire.
// ============================================================

const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen } = require('electron');

const JPEG_QUALITY = 88;
const THUMB_WIDTH = 480;
const MIN_LUM = 6;
const TITRE_MSFS = /flight simulator|fs2024|fs24|msfs/i;

function luminance(img) {
  const bmp = img.toBitmap();
  if (!bmp.length) return 0;
  const step = 4 * 97;
  let sum = 0; let n = 0;
  for (let p = 0; p + 2 < bmp.length; p += step) { sum += bmp[p] + bmp[p + 1] + bmp[p + 2]; n++; }
  return n ? sum / (n * 3) : 0;
}

// Sélectionne la meilleure source : fenêtre MSFS, sinon écran ciblé.
async function choisirImage(monitorIndex = 0) {
  const displays = screen.getAllDisplays();
  const w = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const h = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: w, height: h } });

  const win = sources.find((s) => s.id.startsWith('window:') && TITRE_MSFS.test(s.name));
  if (win && !win.thumbnail.isEmpty() && luminance(win.thumbnail) >= MIN_LUM) {
    return { image: win.thumbnail, via: 'window' };
  }
  const target = displays[monitorIndex] || screen.getPrimaryDisplay();
  const ecrans = sources.filter((s) => s.id.startsWith('screen:'));
  const scr = ecrans.find((s) => String(s.display_id) === String(target.id)) || ecrans[monitorIndex] || ecrans[0];
  if (scr && !scr.thumbnail.isEmpty()) return { image: scr.thumbnail, via: 'screen' };
  return null;
}

// Capture le spot et écrit destDir/{uid}.jpg. Renvoie une vignette pour l'aperçu.
async function capturerVersFichier(uid, destDir, monitorIndex = 0) {
  const choix = await choisirImage(monitorIndex);
  if (!choix) throw new Error('capture vide (ni fenêtre MSFS ni écran exploitable)');

  fs.mkdirSync(destDir, { recursive: true });
  const filename = `${uid}.jpg`;
  const file = path.join(destDir, filename);
  fs.writeFileSync(file, choix.image.toJPEG(JPEG_QUALITY));

  const size = choix.image.getSize();
  const thumbDataUrl = choix.image.resize({ width: THUMB_WIDTH }).toDataURL();
  return { ok: true, filename, file, via: choix.via, width: size.width, height: size.height, thumbDataUrl };
}

module.exports = { capturerVersFichier };
