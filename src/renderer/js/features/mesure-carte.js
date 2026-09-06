/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// mesure-carte.js — mesure de distance et de route sur la carte.
// ============================================================
//
// Repris de Clear Sky VFR (features/mesure-carte.js), lui-même issu de l'outil
// de NavXpressVFR. Le menu contextuel démarre la mesure sur le point cliqué, un
// trait bleu foncé suit le curseur, le clic gauche suivant fige le tracé. Deux
// étiquettes s'inscrivent au milieu, orientées selon la ligne : la route
// au-dessus, la distance au-dessous. Échap annule en cours de traçage. Une seule
// mesure à la fois.
//
// DEUX PARTIS PRIS :
//
//  • La déclinaison est demandée au modèle WMM AU MILIEU du segment mesuré, au
//    lieu d'appliquer la moyenne globale de la route. Une mesure peut être prise
//    n'importe où sur la carte, souvent loin de la navigation en cours, où cette
//    moyenne ne veut plus rien dire. L'appel étant asynchrone, il n'a lieu qu'à
//    la finalisation — jamais pendant que le trait suit le curseur.
//
//  • La géométrie vient du socle (distanceNM, capVraiInitial de renderer.js) au
//    lieu d'être réécrite. Deux implémentations d'un même calcul finissent par
//    diverger.
//
// L'angle des étiquettes est calculé une seule fois, en pixels écran : Mercator
// étant conforme, cet angle ne change ni au zoom ni au déplacement.
// ============================================================

const MESURE_COULEUR = '#0d47a1';
const MESURE_ECART_PX = 12;   // demi-épaisseur du trait + demi-hauteur du texte
const MESURE_POINT_R = 3.5;   // rayon des points d'extrémité

let _mesureDepart = null;     // L.LatLng
let _mesureTrait = null;      // L.Polyline
let _mesurePointDebut = null; // L.CircleMarker — extrémité de départ
let _mesurePointFin = null;   // L.CircleMarker — extrémité d'arrivée
let _mesureEtiquettes = [];   // L.Marker
let _mesureEnTrace = false;   // entre le démarrage et le second clic

// Point d'extrémité : liseré blanc pour rester visible sur un fond chargé.
function _mesurePoint(latlng) {
  return L.circleMarker(latlng, {
    radius: MESURE_POINT_R,
    color: '#fff',
    weight: 1.5,
    fillColor: MESURE_COULEUR,
    fillOpacity: 1,
    interactive: false,
  }).addTo(map);
}

function mesureEnCours() { return _mesureEnTrace; }

function aUneMesure() { return !!(_mesureTrait || _mesureEtiquettes.length); }

// ------------------------------------------------------------
// Traçage
// ------------------------------------------------------------

function _mesureSurDeplacement(e) {
  if (!_mesureEnTrace || !_mesureTrait || !_mesureDepart) return;
  _mesureTrait.setLatLngs([_mesureDepart, e.latlng]);
  if (_mesurePointFin) _mesurePointFin.setLatLng(e.latlng);
}

function _mesureSurClic(e) {
  if (!_mesureEnTrace || !_mesureDepart) return;
  _mesureTerminer(e.latlng);
}

function _mesureSurTouche(e) {
  if (e.key === 'Escape' && _mesureEnTrace) effacerMesure();
}

function _mesureBrancher() {
  map.on('mousemove', _mesureSurDeplacement);
  map.on('click', _mesureSurClic);
  document.addEventListener('keydown', _mesureSurTouche);
}

function _mesureDebrancher() {
  map.off('mousemove', _mesureSurDeplacement);
  map.off('click', _mesureSurClic);
  document.removeEventListener('keydown', _mesureSurTouche);
}

// ------------------------------------------------------------
// Étiquettes
// ------------------------------------------------------------

function _mesureDeg(v) {
  return String(Math.round(v) % 360).padStart(3, '0');
}

// Déclinaison au milieu du segment. Le modèle WMM vit dans le main : on
// l'interroge, et on retombe sur le cache de route si l'appel échoue.
async function _mesureDeclinaison(lat, lon) {
  try {
    const res = await window.bc.declinaison(lat, wrapLon(lon));
    if (res && res.ok && Number.isFinite(res.decl)) return res.decl;
  } catch (_) { /* repli ci-dessous */ }
  return declinaisonEn(lat, lon);
}

function _mesurePoserEtiquette(texte, midLat, midLon, angleDeg, perpX, perpY, signe) {
  const dx = perpX * MESURE_ECART_PX * signe;
  const dy = perpY * MESURE_ECART_PX * signe;
  // Composition lue de droite à gauche : on tourne, on centre, puis on décale
  // perpendiculairement au trait.
  const transform = `translate(${dx}px,${dy}px) translate(-50%,-50%) rotate(${angleDeg}deg)`;
  const m = L.marker([midLat, midLon], {
    icon: L.divIcon({
      className: 'mesure-etiquette',
      html: `<div class="mesure-etiquette-texte" style="transform:${transform}">${escapeHtml(texte)}</div>`,
      iconSize: null,
      iconAnchor: [0, 0],
    }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
  _mesureEtiquettes.push(m);
}

async function _mesureTerminer(finLatLng) {
  _mesureEnTrace = false;
  _mesureDebrancher();
  if (!_mesureTrait || !_mesureDepart || !finLatLng) return;
  const depart = _mesureDepart;
  _mesureTrait.setLatLngs([depart, finLatLng]);
  if (_mesurePointFin) _mesurePointFin.setLatLng(finLatLng);

  const distance = distanceNM(depart.lat, depart.lng, finLatLng.lat, finLatLng.lng);
  const routeVraie = capVraiInitial(depart.lat, depart.lng, finLatLng.lat, finLatLng.lng);
  const midLat = (depart.lat + finLatLng.lat) / 2;
  const midLon = (depart.lng + finLatLng.lng) / 2;

  // Angle du trait à l'écran, ramené dans [-90, 90] pour que le texte ne se
  // lise jamais à l'envers.
  const p1 = map.latLngToContainerPoint(depart);
  const p2 = map.latLngToContainerPoint(finLatLng);
  const ex = p2.x - p1.x, ey = p2.y - p1.y;
  let angle = Math.atan2(ey, ex) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle < -90) angle += 180;

  // Perpendiculaire au trait, tenue vers le haut de l'écran.
  const len = Math.hypot(ex, ey) || 1;
  let perpX = -ey / len, perpY = ex / len;
  if (perpY > 0) { perpX = -perpX; perpY = -perpY; }

  const decl = await _mesureDeclinaison(midLat, midLon);
  // Une mesure effacée pendant l'attente de la déclinaison ne doit rien poser.
  if (!_mesureTrait) return;
  const routeMag = (routeVraie - decl + 360) % 360;

  _mesurePoserEtiquette(`${_mesureDeg(routeVraie)}°V / ${_mesureDeg(routeMag)}°M`,
    midLat, midLon, angle, perpX, perpY, +1);
  _mesurePoserEtiquette(`${distance.toFixed(1)} NM`,
    midLat, midLon, angle, perpX, perpY, -1);
}

// ------------------------------------------------------------
// Entrées
// ------------------------------------------------------------

function demarrerMesure(latlng) {
  if (!latlng || !map) return;
  effacerMesure();   // jamais plus d'une mesure à la fois
  const lon = latlng.lng !== undefined ? latlng.lng : latlng.lon;
  _mesureDepart = L.latLng(latlng.lat, lon);
  _mesureTrait = L.polyline([_mesureDepart, _mesureDepart], {
    color: MESURE_COULEUR, weight: 2, opacity: 1, interactive: false,
  }).addTo(map);
  // Les deux extrémités naissent confondues ; celle d'arrivée suit le curseur.
  _mesurePointDebut = _mesurePoint(_mesureDepart);
  _mesurePointFin = _mesurePoint(_mesureDepart);
  _mesureEnTrace = true;
  _mesureBrancher();
}

function effacerMesure() {
  _mesureEnTrace = false;
  _mesureDebrancher();
  [_mesureTrait, _mesurePointDebut, _mesurePointFin, ..._mesureEtiquettes]
    .forEach((c) => { if (c) { try { map.removeLayer(c); } catch (_) { /* déjà retirée */ } } });
  _mesureTrait = null;
  _mesurePointDebut = null;
  _mesurePointFin = null;
  _mesureEtiquettes = [];
  _mesureDepart = null;
}
