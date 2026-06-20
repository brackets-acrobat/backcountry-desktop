/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// scan.js — profil de relief par passage bas (STUB / contrat).
//
// Reconnaissance OPTIONNELLE : pendant un passage bas (< lowPassMaxAglFt sol),
// déclenché/arrêté au raccourci, on échantillonne lat/lon + GROUND ALTITUDE
// le long de la trajectoire (l'avion = la sonde). On en dérive ensuite, via
// math-engine.analyserPente(), le dénivelé et la pente max du spot.
//
// L'approche « grille via SimObject téléporté » a été ÉCARTÉE (latence de pose,
// LOD à distance). On reste sur l'échantillonnage le long de la trajectoire.
//
// Contrat (à implémenter) :
//   const scan = createScan();
//   scan.start();                 // début du buffer
//   scan.feed({ lat, lon, groundAltFt, aglFt });
//   scan.stop();                  // → retourne { points, echantillons }
// ============================================================

function createScan() {
  let actif = false;
  let points = [];   // { lat, lon } pour la longueur géométrique
  let distCumM = 0;

  return {
    get actif() { return actif; },
    start() { actif = true; points = []; distCumM = 0; },
    feed(/* frame */) {
      if (!actif) return;
      // TODO (jalon 2) : pousser {lat, lon, groundAltFt} + cumuler la distance.
    },
    stop() {
      actif = false;
      return { points: points.slice(), echantillons: [] };
    },
  };
}

module.exports = { createScan };
