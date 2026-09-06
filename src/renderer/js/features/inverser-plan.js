/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// inverser-plan.js — inversion du plan de vol.
//
// L'arrivée devient le départ, et les points tournants sont parcourus du dernier
// au premier. Repris de Clear Sky VFR (features/plan-io.js).
//
// Aucun renommage à écrire : « WPn » n'est PAS stocké. nomsPointsTournants le
// fabrique à la volée en numérotant les points non nommés dans l'ordre du
// tableau, et appliquerPlan écarte à la lecture tout nom de cette forme.
// Retourner le tableau suffit donc à ce que le dernier point devienne WP1,
// l'avant-dernier WP2, et ainsi de suite. Les points VRAIMENT nommés (renommés
// au tableau) et les points aimantés sur un code gardent le leur — les
// renuméroter effacerait une intention du pilote.
// ============================================================

function inverserPlan() {
  const dep = nettoyerIcao($('icao-dep').value);
  const arr = nettoyerIcao($('icao-arr').value);
  if (!dep && !arr && routeWaypoints.length === 0) return;   // rien à inverser

  // Altitudes de leg : elles sont ancrées sur le point SOURCE du leg, qui change
  // en sens inverse. Un leg parcouru à l'envers reste pourtant le MÊME tronçon
  // de terrain et doit garder son altitude : on retourne la suite des altitudes
  // en même temps que celle des points, puis on la ré-ancre. Relevé avant
  // l'inversion, et en BRUT — seules les altitudes réellement saisies se
  // transportent, l'altitude par défaut se réapplique d'elle-même.
  const nbLeg = routeWaypoints.length + 1;
  const alts = [];
  for (let i = 0; i < nbLeg; i++) alts.push(getLegAltBrut(i));
  alts.reverse();

  routeWaypoints = routeWaypoints.slice().reverse();

  // ZZZY (départ cliqué) et ZZZZ (arrivée cliquée) marquent une PLACE dans le
  // plan, pas l'identité d'un lieu : on déplace les coordonnées derrière elles
  // et on réécrit le code selon la nouvelle place. Sans quoi le champ « départ »
  // afficherait ZZZZ, et resoudrePointIcao irait chercher le mauvais point dès
  // qu'un second lieu serait cliqué.
  const ancienDep = _lieuDepartLatLng, ancienArr = _lieuArriveeLatLng;
  const estClique = (code) => code === 'ZZZY' || code === 'ZZZZ';
  const lieuDe = (code) => (code === 'ZZZY' ? ancienDep : code === 'ZZZZ' ? ancienArr : null);
  _lieuDepartLatLng  = lieuDe(arr);   // l'ancienne arrivée prend la place du départ
  _lieuArriveeLatLng = lieuDe(dep);
  $('icao-dep').value = estClique(arr) ? 'ZZZY' : arr;
  $('icao-arr').value = estClique(dep) ? 'ZZZZ' : dep;

  for (let i = 0; i < nbLeg; i++) setLegAlt(i, alts[i]);

  _legActif = 0;   // la route change de sens : le séquencement repart du premier leg
  majBoutonsPlan();
  // Pas de recadrage : le tracé couvre exactement le même terrain qu'avant, un
  // fitBounds ne ferait que bousculer la vue du pilote.
  majLigneRoute();
}

$('btn-inverser').addEventListener('click', inverserPlan);
