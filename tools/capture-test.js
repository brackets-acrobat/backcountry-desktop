/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 *
 * OUTIL DE TEST JETABLE (jalon 3) — preuve de capture d'écran.
 * Capture chaque écran en pleine résolution et écrit un PNG dans
 *   Mes documents/Backcountry Pathfinders/_capture-test/
 * puis quitte. Ne touche pas à l'application.
 *
 * Lancement (MSFS en vol, à l'écran) :
 *   npx electron tools/capture-test.js
 * ou
 *   node_modules/.bin/electron tools/capture-test.js
 */

const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

// Petit délai pour laisser le temps à MSFS de rester au premier plan.
const DELAY_MS = 1500;

app.whenReady().then(async () => {
  const outDir = path.join(app.getPath('documents'), 'Backcountry Pathfinders', '_capture-test');
  fs.mkdirSync(outDir, { recursive: true });

  await new Promise((r) => setTimeout(r, DELAY_MS));

  const displays = screen.getAllDisplays();
  // Dimensionne les vignettes à la résolution NATIVE (taille logique × facteur d'échelle).
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`[capture-test] ${displays.length} écran(s), ${sources.length} source(s)`);

  sources.forEach((s, i) => {
    const img = s.thumbnail;
    const size = img.getSize();
    const png = img.toPNG();
    const file = path.join(outDir, `screen-${i}-${stamp}.png`);
    fs.writeFileSync(file, png);
    // Mesure très simple de « noir » : moyenne des octets RGBA du bitmap.
    const bmp = img.toBitmap();
    let sum = 0;
    for (let p = 0; p < bmp.length; p += 4) sum += bmp[p] + bmp[p + 1] + bmp[p + 2];
    const avg = (sum / (bmp.length / 4) / 3).toFixed(1);
    console.log(`[capture-test] écran ${i}: ${size.width}x${size.height}px, ${(png.length / 1024).toFixed(0)} Ko, luminance moy ≈ ${avg}/255 → ${file}`);
  });

  console.log(`[capture-test] Terminé. Dossier : ${outDir}`);
  app.quit();
});
