/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// math-engine.js — calculs de performance (local, sans réseau).
//
// Toutes les fonctions sont pures. Unités : altitudes en pieds (ft),
// températures en °C, distances horizontales en mètres (m), vents en kt.
//
// Briques (cf. note de conception) :
//   - altitude-densité instantanée (air raréfié)
//   - triangle des vents (composantes face/arrière + travers)
//   - longueur disponible par GÉOMÉTRIE (pas par roulage)
//   - distance + dénivelé entre deux points (haversine)
//
// NOTE : la friction n'est PAS calculée ici ; elle se dérive empiriquement
// de la décélération au freinage (côté fsm.js, au roulage). Le coefficient
// de freinage appliqué aux distances théoriques viendra ensuite.
// ============================================================

const FT_PER_M = 3.280839895;
const R_TERRE_M = 6371000;

// --- Conversions ---
const mToFt = (m) => m * FT_PER_M;
const ftToM = (ft) => ft / FT_PER_M;
const degToRad = (d) => (d * Math.PI) / 180;

// Altitude-pression (ft) à partir de l'altitude géométrique et du QNH (hPa).
// Approximation standard : +27 ft par hPa sous 1013.25.
function altitudePression(altFt, qnhHpa = 1013.25) {
  return altFt + (1013.25 - qnhHpa) * 27;
}

// Altitude-densité (ft) : altitude-pression corrigée de l'écart à l'ISA.
// ISA au niveau considéré : T = 15 - 1.98 °C / 1000 ft.
// DA ≈ PA + 118.8 * (OAT - ISA_temp).
function altitudeDensite(altFt, oatC, qnhHpa = 1013.25) {
  const pa = altitudePression(altFt, qnhHpa);
  const isaTemp = 15 - 1.98 * (pa / 1000);
  return pa + 118.8 * (oatC - isaTemp);
}

// Triangle des vents : projette le vent sur l'axe de piste.
// runwayHeadingTrue = cap VRAI de la piste (sens d'utilisation), degrés.
// windFromTrue = direction VRAIE d'où vient le vent, degrés. windSpeedKt = force.
// Retour : { headwind, crosswind } en kt (headwind > 0 = vent de face,
// headwind < 0 = vent arrière ; crosswind = valeur absolue du travers).
function composantesVent(runwayHeadingTrue, windFromTrue, windSpeedKt) {
  const angle = degToRad(windFromTrue - runwayHeadingTrue);
  const headwind = windSpeedKt * Math.cos(angle);
  const crosswind = Math.abs(windSpeedKt * Math.sin(angle));
  return { headwind, crosswind };
}

// Distance grand-cercle (m) entre deux points lat/lon (haversine).
function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_TERRE_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Longueur disponible (m) d'une piste improvisée définie par une polyligne de
// points {lat, lon}. C'est la DISTANCE GÉOMÉTRIQUE cumulée (pas un roulage) :
// on additionne les segments. Au moins 2 points requis.
function longueurDisponibleM(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return total;
}

// Profil de pente d'un échantillon {distM, altFt}[] (distance cumulée + altitude
// relief). Retour : { deniveleM, penteMaxPct, penteMoyennePct }.
function analyserPente(echantillons) {
  if (!Array.isArray(echantillons) || echantillons.length < 2) {
    return { deniveleM: 0, penteMaxPct: 0, penteMoyennePct: 0 };
  }
  const alts = echantillons.map((e) => ftToM(e.altFt));
  const deniveleM = Math.max(...alts) - Math.min(...alts);

  let penteMax = 0;
  for (let i = 1; i < echantillons.length; i++) {
    const dDist = echantillons[i].distM - echantillons[i - 1].distM;
    if (dDist <= 0) continue;
    const dAlt = ftToM(echantillons[i].altFt) - ftToM(echantillons[i - 1].altFt);
    penteMax = Math.max(penteMax, Math.abs((dAlt / dDist) * 100));
  }

  const dDistTot = echantillons[echantillons.length - 1].distM - echantillons[0].distM;
  const dAltTot = ftToM(echantillons[echantillons.length - 1].altFt) - ftToM(echantillons[0].altFt);
  const penteMoyennePct = dDistTot > 0 ? (dAltTot / dDistTot) * 100 : 0;

  return { deniveleM, penteMaxPct: penteMax, penteMoyennePct };
}

module.exports = {
  mToFt, ftToM,
  altitudePression, altitudeDensite,
  composantesVent,
  distanceM, longueurDisponibleM, analyserPente,
};
