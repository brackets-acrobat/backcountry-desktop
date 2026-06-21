/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 *
 * PROBE JETABLE (étude jalon 3.x) — deux questions d'un coup :
 *   1) CAPTURE : comparer capture de FENÊTRE (MSFS) vs capture d'ÉCRAN, dans
 *      le mode d'affichage courant (plein écran exclusif chez l'utilisateur).
 *      → on saura si « cibler FS24 » marche, ou s'il faut le repli écran.
 *   2) CAMÉRA : peut-on lire et CHANGER le CAMERA STATE via SimConnect
 *      (cockpit → drone → extérieur), de façon effective et réversible ?
 *      → préalable à l'idée de capture 360° par caméra drone.
 *
 * Sorties : PNG/JPEG + un resume.txt dans
 *   Mes documents/Backcountry Pathfinders/_probe/
 *
 * Lancement (MSFS EN VOL, à l'écran) :
 *   npx electron tools/probe-camera-capture.js
 * ou
 *   node_modules/.bin/electron tools/probe-camera-capture.js
 */

const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  open: scOpen,
  Protocol: SCProtocol,
  SimConnectDataType: SCDataType,
  SimConnectPeriod: SCPeriod,
  SimConnectConstants: SCConst,
  RawBuffer,
} = require('node-simconnect');

const DEF_CAM = 50;
const REQ_CAM = 50;

// Référence enum CAMERA STATE (MSFS, peut varier selon build) :
// 2=Cockpit, 3=Extérieur/Chase, 4=Drone, 5=Fixé sur avion, 6=Environnement,
// 9=Showcase, 11=Attente, 12=World map. On testera 4 (drone) et 3 (extérieur).
const ETATS = { 2: 'Cockpit', 3: 'Extérieur', 4: 'Drone', 5: 'Fixe', 6: 'Environnement', 9: 'Showcase' };

const lignes = [];
function log(s) { console.log(s); lignes.push(s); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Luminance moyenne d'une NativeImage (0 = noir).
function lum(img) {
  const bmp = img.toBitmap();
  if (!bmp.length) return 0;
  let sum = 0;
  for (let p = 0; p < bmp.length; p += 4) sum += bmp[p] + bmp[p + 1] + bmp[p + 2];
  return +(sum / (bmp.length / 4) / 3).toFixed(1);
}

let outDir;

// Capture la fenêtre MSFS + chaque écran, enregistre, rapporte la luminance.
async function capture(label) {
  const displays = screen.getAllDisplays();
  const w = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const h = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: w, height: h } });

  const win = sources.filter((s) => s.id.startsWith('window:'));
  const scr = sources.filter((s) => s.id.startsWith('screen:'));
  const fs24 = win.find((s) => /flight simulator|fs2024|fs24|msfs/i.test(s.name));

  log(`\n[${label}]`);
  const cibles = [];
  if (fs24) cibles.push(['fenetre-FS24', fs24]);
  else log(`  fenêtre FS24 : INTROUVABLE (titres dispo : ${win.map((s) => s.name).slice(0, 8).join(' | ') || 'aucun'})`);
  scr.forEach((s, i) => cibles.push([`ecran-${i}`, s]));

  for (const [kind, src] of cibles) {
    const img = src.thumbnail;
    if (img.isEmpty()) { log(`  ${kind}: VIDE (${src.name})`); continue; }
    const file = path.join(outDir, `${label}_${kind}.jpg`);
    fs.writeFileSync(file, img.toJPEG(85));
    const sz = img.getSize();
    log(`  ${kind}: « ${src.name} » ${sz.width}x${sz.height} — luminance ${lum(img)}/255 → ${path.basename(file)}`);
  }
}

async function main() {
  outDir = path.join(app.getPath('documents'), 'Backcountry Pathfinders', '_probe');
  fs.mkdirSync(outDir, { recursive: true });
  log(`=== PROBE caméra + capture — ${new Date().toLocaleString()} ===`);

  // --- SimConnect ---
  let handle = null;
  let camInitial = null;
  const pending = new Map();
  try {
    const { recvOpen, handle: h } = await scOpen('BackcountryProbe', SCProtocol.FSX_SP2);
    handle = h;
    log(`SimConnect connecté à ${recvOpen.applicationName}`);

    handle.on('simObjectData', (d) => {
      const r = pending.get(d.requestID);
      if (r) { pending.delete(d.requestID); r(d); }
    });
    handle.on('exception', (ex) => log(`  ⚠ exception SimConnect: ${JSON.stringify(ex)}`));

    handle.addToDataDefinition(DEF_CAM, 'CAMERA STATE', 'Enum', SCDataType.INT32);

    const readCam = () => new Promise((resolve) => {
      pending.set(REQ_CAM, (d) => resolve(d.data.readInt32()));
      handle.requestDataOnSimObject(REQ_CAM, DEF_CAM, SCConst.OBJECT_ID_USER, SCPeriod.ONCE, 0, 0, 0, 0);
    });
    const setCam = (v) => {
      const rb = new RawBuffer(4);
      rb.writeInt32(v);
      handle.setDataOnSimObject(DEF_CAM, SCConst.OBJECT_ID_USER, { buffer: rb, arrayCount: 0, tagged: false });
    };

    camInitial = await readCam();
    log(`CAMERA STATE initial = ${camInitial} (${ETATS[camInitial] || '?'})`);

    await capture('00-initial');

    // Drone
    log('\n-> set CAMERA STATE = 4 (Drone)');
    setCam(4);
    await wait(2000);
    log(`   relecture = ${await readCam()}`);
    await capture('01-drone');

    // Extérieur
    log('\n-> set CAMERA STATE = 3 (Extérieur)');
    setCam(3);
    await wait(2000);
    log(`   relecture = ${await readCam()}`);
    await capture('02-exterieur');

    // Restauration
    log(`\n-> restauration CAMERA STATE = ${camInitial}`);
    setCam(camInitial);
    await wait(1500);
    log(`   relecture = ${await readCam()}`);
    await capture('03-restaure');
  } catch (e) {
    log(`ERREUR : ${e && e.message}`);
    log('(MSFS doit être lancé ET dans un vol pour SimConnect.)');
  } finally {
    if (handle) { try { handle.close(); } catch (_) {} }
  }

  log(`\n=== Terminé. Dossier : ${outDir} ===`);
  log('Ouvre les images : compare fenetre-FS24 vs ecran-* (lequel est noir ?),');
  log('et regarde si 01-drone / 02-exterieur montrent bien un changement de caméra.');
  fs.writeFileSync(path.join(outDir, 'resume.txt'), lignes.join('\n'), 'utf-8');
  app.quit();
}

app.whenReady().then(main);
