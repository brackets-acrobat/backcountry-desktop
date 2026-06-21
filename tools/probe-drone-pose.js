/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 *
 * PROBE JETABLE (étude 360°) — précision de pose de la caméra.
 *
 * Question : peut-on placer la caméra ~5 m AU-DESSUS de l'avion et la faire
 * regarder dans des directions précises (avant / 90°G / 90°D / arrière / bas /
 * haut), de façon répétable, en vue d'un cubemap 360° ?
 *
 * Outil testé : SimConnect_CameraSetRelative6DOF(dx, dy, dz, pitch, bank, heading)
 *   - dx/dy/dz en PIEDS, relatifs à l'avion (convention supposée : x=droite,
 *     y=haut, z=avant) — à VÉRIFIER sur les images.
 *   - pitch/bank/heading en DEGRÉS.
 * On teste aussi QUEL CAMERA STATE honore le 6DOF (cockpit/extérieur/drone),
 * et on DUMP la liste des input events (contrôles drone éventuels).
 *
 * Captures : on cible la FENÊTRE MSFS (prouvée OK en plein écran exclusif).
 * Sorties dans Mes documents/Backcountry Pathfinders/_probe-drone/.
 *
 * Lancement (MSFS EN VOL) :  npx electron tools/probe-drone-pose.js
 * ⚠ La caméra va bouger ~25 s : laisse MSFS au premier plan.
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

const DEF_CAM = 60, REQ_CAM = 60;
const UP_FT = 16.4;            // ~5 m au-dessus
const ETATS = { 2: 'Cockpit', 3: 'Exterieur', 4: 'Drone', 5: 'Fixe', 6: 'Environnement' };
const TITRE_MSFS = /flight simulator|fs2024|fs24|msfs/i;

const lignes = [];
const log = (s) => { console.log(s); lignes.push(s); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let outDir;

async function capture(label) {
  const displays = screen.getAllDisplays();
  const w = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const h = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: w, height: h } });
  const src = sources.find((s) => s.id.startsWith('window:') && TITRE_MSFS.test(s.name))
    || sources.find((s) => s.id.startsWith('screen:'));
  if (!src || src.thumbnail.isEmpty()) { log(`  [${label}] capture introuvable`); return; }
  fs.writeFileSync(path.join(outDir, `${label}.jpg`), src.thumbnail.toJPEG(85));
  log(`  [${label}] via ${src.id.startsWith('window:') ? 'fenêtre' : 'écran'} → ${label}.jpg`);
}

async function main() {
  outDir = path.join(app.getPath('documents'), 'Backcountry Pathfinders', '_probe-drone');
  fs.mkdirSync(outDir, { recursive: true });
  log(`=== PROBE pose drone — ${new Date().toLocaleString()} ===`);

  let handle = null, camInitial = null;
  const pending = new Map();
  try {
    const { recvOpen, handle: h } = await scOpen('BackcountryDroneProbe', SCProtocol.FSX_SP2);
    handle = h;
    log(`SimConnect connecté à ${recvOpen.applicationName}`);
    handle.on('simObjectData', (d) => { const r = pending.get(d.requestID); if (r) { pending.delete(d.requestID); r(d); } });
    handle.on('exception', (ex) => log(`  ⚠ exception SimConnect: ${JSON.stringify(ex)}`));

    handle.addToDataDefinition(DEF_CAM, 'CAMERA STATE', 'Enum', SCDataType.INT32);
    const readCam = () => new Promise((res) => { pending.set(REQ_CAM, (d) => res(d.data.readInt32())); handle.requestDataOnSimObject(REQ_CAM, DEF_CAM, SCConst.OBJECT_ID_USER, SCPeriod.ONCE, 0, 0, 0, 0); });
    const setCam = (v) => { const rb = new RawBuffer(4); rb.writeInt32(v); handle.setDataOnSimObject(DEF_CAM, SCConst.OBJECT_ID_USER, { buffer: rb, arrayCount: 0, tagged: false }); };
    const sixDof = (dx, dy, dz, pitch, bank, hdg) => handle.cameraSetRelative6DOF(dx, dy, dz, pitch, bank, hdg);

    camInitial = await readCam();
    log(`CAMERA STATE initial = ${camInitial} (${ETATS[camInitial] || '?'})`);

    // --- Dump des input events (découverte des contrôles drone) ---
    try {
      const events = [];
      handle.on('inputEventsList', (recv) => {
        for (const d of recv.inputEventDescriptors) events.push(`${d.name}\t${d.inputEventIdHash}`);
      });
      handle.enumerateInputEvents(9000);
      await wait(2500);
      if (events.length) {
        fs.writeFileSync(path.join(outDir, 'input-events.txt'), events.sort().join('\n'), 'utf-8');
        const interessants = events.filter((e) => /drone|camera|cockpit|chase|view/i.test(e));
        log(`Input events : ${events.length} listés (input-events.txt). Pertinents (caméra/drone) :`);
        interessants.slice(0, 25).forEach((e) => log('   ' + e.split('\t')[0]));
        if (!interessants.length) log('   (aucun nom évident caméra/drone)');
      } else {
        log('Input events : aucun reçu (API peut-être indisponible sur ce build).');
      }
    } catch (e) { log(`Input events : erreur ${e && e.message}`); }

    // --- Phase A : quel CAMERA STATE honore le 6DOF ? (base vs +5 m) ---
    log('\n--- Phase A : 6DOF base vs +5 m, par état caméra ---');
    for (const st of [2, 3, 4]) {
      setCam(st); await wait(1500);
      sixDof(0, 0, 0, 0, 0, 0); await wait(1200); await capture(`A_state${st}-${ETATS[st]}_base`);
      sixDof(0, UP_FT, 0, 0, 0, 0); await wait(1200); await capture(`A_state${st}-${ETATS[st]}_up5m`);
    }

    // --- Phase B : balayage 6 directions en mode Drone (au-dessus de l'avion) ---
    log('\n--- Phase B : 6 directions (drone, +5 m) ---');
    setCam(4); await wait(1500);
    const dirs = [
      ['avant',     [0, UP_FT, 0,   0, 0,   0]],
      ['gauche90',  [0, UP_FT, 0,   0, 0, 270]],
      ['droite90',  [0, UP_FT, 0,   0, 0,  90]],
      ['arriere',   [0, UP_FT, 0,   0, 0, 180]],
      ['bas',       [0, UP_FT, 0, -90, 0,   0]],
      ['haut',      [0, UP_FT, 0,  90, 0,   0]],
    ];
    for (const [nom, p] of dirs) { sixDof(...p); await wait(1200); await capture(`B_${nom}`); }

    // --- Restauration ---
    log('\n-> restauration');
    sixDof(0, 0, 0, 0, 0, 0); await wait(300);
    setCam(camInitial); await wait(1200);
    log(`   CAMERA STATE = ${await readCam()}`);
  } catch (e) {
    log(`ERREUR : ${e && e.message}`);
    log('(MSFS doit être lancé ET dans un vol.)');
  } finally {
    if (handle) { try { handle.close(); } catch (_) {} }
  }

  log(`\n=== Terminé. Dossier : ${outDir} ===`);
  log('À regarder : Phase A → quel état montre la caméra MONTÉE de 5 m (base ≠ up5m) ;');
  log('Phase B → les 6 vues sont-elles bien orientées (avant/gauche/droite/arrière/bas/haut) ?');
  fs.writeFileSync(path.join(outDir, 'resume.txt'), lignes.join('\n'), 'utf-8');
  app.quit();
}

app.whenReady().then(main);
