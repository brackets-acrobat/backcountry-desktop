/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// flanquement.js — flanquement VOR.
// ============================================================
//
// Trace le radial magnétique reliant une station VOR à un point de la route,
// avec une étiquette « R-090° / 12.3 nm » au milieu du trait. Repris de
// Clear Sky VFR (features/flanquement.js), lui-même issu de NavXpressVFR.
//
// Parcours : clic droit sur un VOR → « Flanquement VOR » → une modale liste les
// points de la route, plus « un point de la carte » qui fait désigner la cible
// à la souris → le tracé apparaît. Plusieurs flanquements coexistent ; chacun
// s'efface par clic droit sur son trait, comme les cercles de portée.
//
// Le point quelconque étant toujours offert, l'entrée de menu ne dépend pas de
// l'existence d'une route : on peut flanquer un lieu de poser repéré à l'œil
// avant même d'avoir saisi un départ.
//
// TROIS PARTIS PRIS :
//
//  • La déclinaison est prise À LA STATION, par le modèle WMM, au lieu de la
//    moyenne globale de la route. Les radiaux d'un VOR sont calés sur la
//    variation magnétique de la station : la moyenne d'une navigation qui passe
//    à cent milles de là n'a aucune raison de lui correspondre.
//    (Réserve : la « station declination » publiée d'un VOR peut différer de la
//    variation magnétique du moment — parfois de plusieurs degrés sur une
//    station ancienne. Nous ne disposons pas de cette valeur ; le WMM au point
//    de la station est la meilleure approximation à notre portée.)
//
//  • La portée vient de navaid.rangeNm, que la base extraite porte déjà, au lieu
//    d'être devinée d'après le type de station.
//
//  • La géométrie vient du socle (renderer.js) plutôt que d'être recopiée.
//
// Seules l'identité de la station et les coordonnées sont enregistrées dans le
// plan : radial et distance sont RECALCULÉS au chargement, la déclinaison ayant
// pu changer entre-temps.
// ============================================================

const FLANQ_COULEUR = '#c026a3';   // magenta soutenu, distinct de la route et des cercles
const FLANQ_ECART_PX = 12;
const FLANQ_POINT_R = 3.5;         // rayon du point de cible, comme pour la mesure

// Stations qui émettent des radiaux. Un NDB donne un relèvement et non un
// radial ; un DME ou un TACAN seul ne donne aucun azimut exploitable.
const FLANQ_TYPES_VOR = new Set(['VOR', 'VOR-DME', 'VORTAC']);

let _flanquements = [];
let _flanqNavaidEnAttente = null;
let _flanqCibles = [];
let _flanqNavaidPourPoint = null;   // station en attente d'un point désigné à la souris

function estStationVor(n) {
  return !!n && FLANQ_TYPES_VOR.has(String(n.type || '').toUpperCase());
}

function aDesFlanquements() { return _flanquements.length > 0; }

// ------------------------------------------------------------
// Cibles : les points de la route, dans l'ordre du vol
// ------------------------------------------------------------

function ciblesFlanquement() {
  const out = [];
  const dep = nettoyerIcao($('icao-dep').value);
  const arr = nettoyerIcao($('icao-arr').value);
  if (_routeDep) out.push({ nom: dep || t('flanqDepart'), lat: _routeDep.lat, lon: _routeDep.lon });
  nomsPointsTournants(routeWaypoints).forEach((nom, i) => {
    out.push({ nom, lat: routeWaypoints[i].lat, lon: routeWaypoints[i].lon });
  });
  if (_routeArr) out.push({ nom: arr || t('flanqArrivee'), lat: _routeArr.lat, lon: _routeArr.lon });
  return out;
}

// Nom d'un point désigné à la souris : ses coordonnées. Elles ne s'affichent
// nulle part sur la carte, mais elles partent dans le plan, où « Point de la
// carte » répété cinq fois ne dirait rien à la relecture.
function _flanqNomPoint(lat, lon) {
  const l = wrapLon(lon);
  return `${Math.abs(lat).toFixed(4)}${lat >= 0 ? 'N' : 'S'} `
       + `${Math.abs(l).toFixed(4)}${l >= 0 ? 'E' : 'W'}`;
}

// ------------------------------------------------------------
// Calcul
// ------------------------------------------------------------

// Radial affiché : entier dans [1..360], un radial 000 se notant 360.
function _flanqRadial(v) {
  const r = Math.round(v) % 360;
  return String(r === 0 ? 360 : r).padStart(3, '0');
}

// Déclinaison à la station. Repli sur le cache de route si le modèle ne répond
// pas — mieux vaut un radial approché qu'aucun tracé.
async function _flanqDeclinaison(lat, lon) {
  try {
    const res = await window.bc.declinaison(lat, wrapLon(lon));
    if (res && res.ok && Number.isFinite(res.decl)) return res.decl;
  } catch (_) { /* repli ci-dessous */ }
  return declinaisonEn(lat, lon);
}

async function creerFlanquement(navaid, cible) {
  const vraie = capVraiInitial(navaid.lat, navaid.lon, cible.lat, cible.lon);
  const decl = await _flanqDeclinaison(navaid.lat, navaid.lon);
  return {
    vorIdent: navaid.ident || '',
    vorLat: navaid.lat,
    vorLon: navaid.lon,
    cibleNom: cible.nom || '',
    lat: cible.lat,
    lon: cible.lon,
    radialMag: ((vraie - decl) % 360 + 360) % 360,
    distNm: distanceNM(navaid.lat, navaid.lon, cible.lat, cible.lon),
    rangeNm: Number.isFinite(navaid.rangeNm) ? navaid.rangeNm : null,
    trait: null,
    point: null,
    etiquette: null,
  };
}

// ------------------------------------------------------------
// Tracé
// ------------------------------------------------------------

// Pose le trait et l'étiquette. À n'appeler QUE sur un flanquement déjà inscrit
// dans _flanquements : ce qui est dessiné sans y figurer devient un orphelin que
// effacerTousFlanquements() ne saura pas retirer.
function _flanqTracer(f) {
  if (!map || !f) return;
  // Longitude de la cible déroulée par rapport à la station : l'antiméridien se
  // franchit proprement sans toucher à la donnée enregistrée.
  let lonCible = f.lon;
  while (lonCible - f.vorLon > 180) lonCible -= 360;
  while (lonCible - f.vorLon < -180) lonCible += 360;

  const pVor = L.latLng(f.vorLat, f.vorLon);
  const pCible = L.latLng(f.lat, lonCible);

  const trait = L.polyline([pVor, pCible], {
    color: FLANQ_COULEUR, weight: 2, opacity: 0.9, dashArray: '6 5', interactive: true,
  }).addTo(map);
  trait.on('mouseover', () => { trait.setStyle({ weight: 4 }); map.getContainer().style.cursor = 'pointer'; });
  trait.on('mouseout', () => { trait.setStyle({ weight: 2 }); map.getContainer().style.cursor = ''; });
  trait.on('contextmenu', (e) => ouvrirMenuFlanquement(e, () => supprimerFlanquement(f)));
  f.trait = trait;

  // Point de cible seulement : l'autre extrémité est la station, déjà marquée
  // par son propre symbole. Liseré blanc pour rester visible sur fond chargé.
  f.point = L.circleMarker(pCible, {
    radius: FLANQ_POINT_R, color: '#fff', weight: 1.5,
    fillColor: FLANQ_COULEUR, fillOpacity: 1, interactive: false,
  }).addTo(map);

  const midLat = (pVor.lat + pCible.lat) / 2;
  const midLon = (pVor.lng + pCible.lng) / 2;
  const p1 = map.latLngToContainerPoint(pVor);
  const p2 = map.latLngToContainerPoint(pCible);
  const ex = p2.x - p1.x, ey = p2.y - p1.y;
  let angle = Math.atan2(ey, ex) * 180 / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle < -90) angle += 180;
  const len = Math.hypot(ex, ey) || 1;
  let perpX = -ey / len, perpY = ex / len;
  if (perpY > 0) { perpX = -perpX; perpY = -perpY; }
  const transform = `translate(${perpX * FLANQ_ECART_PX}px,${perpY * FLANQ_ECART_PX}px)`
    + ` translate(-50%,-50%) rotate(${angle}deg)`;

  let texte = `R-${_flanqRadial(f.radialMag)}° / ${f.distNm.toFixed(1)} nm`;
  // Hors du volume de service publié, le radial reste juste mais peut n'être
  // pas recevable en vol : on le dit plutôt que de laisser croire l'inverse.
  if (Number.isFinite(f.rangeNm) && f.rangeNm > 0 && f.distNm > f.rangeNm) {
    texte += ` (>${f.rangeNm} nm)`;
  }
  f.etiquette = L.marker([midLat, midLon], {
    icon: L.divIcon({
      className: 'flanq-etiquette',
      html: `<div class="flanq-etiquette-texte" style="transform:${transform}">${escapeHtml(texte)}</div>`,
      iconSize: null,
      iconAnchor: [0, 0],
    }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
}

function _flanqRetirerTrace(f) {
  if (!f) return;
  [f.trait, f.point, f.etiquette].forEach((c) => { if (c) { try { map.removeLayer(c); } catch (_) { /* déjà retirée */ } } });
  f.trait = null;
  f.point = null;
  f.etiquette = null;
}

function supprimerFlanquement(f) {
  _flanqRetirerTrace(f);
  _flanquements = _flanquements.filter((x) => x !== f);
}

function effacerTousFlanquements() {
  _flanquements.forEach(_flanqRetirerTrace);
  _flanquements = [];
}

// ------------------------------------------------------------
// Désignation d'un point quelconque à la souris
// ------------------------------------------------------------

function _flanqSurClicPoint(e) {
  const navaid = _flanqNavaidPourPoint;
  _flanqFinDesignation();
  if (!navaid || !e || !e.latlng) return;
  const lat = e.latlng.lat, lon = wrapLon(e.latlng.lng);
  creerFlanquement(navaid, { nom: _flanqNomPoint(lat, lon), lat, lon }).then((f) => {
    _flanquements.push(f);
    _flanqTracer(f);
  });
}

function _flanqSurTouchePoint(e) {
  if (e.key === 'Escape') _flanqFinDesignation();
}

function _flanqFinDesignation() {
  if (!_flanqNavaidPourPoint) return;
  _flanqNavaidPourPoint = null;
  map.off('click', _flanqSurClicPoint);
  document.removeEventListener('keydown', _flanqSurTouchePoint);
  map.getContainer().style.cursor = '';
  fermerMessageCarte();
}

function demarrerDesignationPoint(navaid) {
  if (!navaid || !map) return;
  // Une mesure en cours capterait le même clic : deux tracés naîtraient d'un
  // seul geste. On la referme plutôt que de laisser les deux modes coexister.
  if (mesureEnCours()) effacerMesure();
  _flanqNavaidPourPoint = navaid;
  map.on('click', _flanqSurClicPoint);
  document.addEventListener('keydown', _flanqSurTouchePoint);
  map.getContainer().style.cursor = 'crosshair';
  messageCarte(t('flanqDesignerPoint'), true);
}

// ------------------------------------------------------------
// Modale de choix de la cible
// ------------------------------------------------------------

function ouvrirModaleFlanquement(navaid) {
  if (!navaid) return;
  _flanqNavaidEnAttente = navaid;
  _flanqCibles = ciblesFlanquement();
  $('flanq-vor').textContent = navaid.ident || '—';
  $('flanq-error').textContent = '';
  // Un point quelconque de la carte est toujours proposé, en dernier : il reste
  // offert même sans route, d'où un bouton jamais désactivé.
  _flanqCibles.push({ carte: true, nom: t('flanqPointCarte') });
  const liste = $('flanq-list');
  liste.innerHTML = '';
  $('flanq-empty').hidden = _flanqCibles.length > 1;
  $('btn-flanq-ok').disabled = false;
  _flanqCibles.forEach((c, i) => {
    const l = document.createElement('label');
    l.className = c.carte ? 'flanq-item flanq-item-carte' : 'flanq-item';
    l.innerHTML = `<input type="radio" name="flanq-cible" value="${i}">`
      + `<span class="flanq-item-nom">${escapeHtml(c.nom)}</span>`;
    liste.appendChild(l);
  });
  $('flanq-overlay').hidden = false;
}

function fermerModaleFlanquement() {
  $('flanq-overlay').hidden = true;
  _flanqNavaidEnAttente = null;
  _flanqCibles = [];
}

async function validerFlanquement() {
  if (!_flanqNavaidEnAttente) { fermerModaleFlanquement(); return; }
  const choix = $('flanq-list').querySelector('input[name="flanq-cible"]:checked');
  if (!choix) { $('flanq-error').textContent = t('flanqChoixRequis'); return; }
  const cible = _flanqCibles[parseInt(choix.value, 10)];
  const navaid = _flanqNavaidEnAttente;
  fermerModaleFlanquement();
  if (!cible) return;
  if (cible.carte) { demarrerDesignationPoint(navaid); return; }
  const f = await creerFlanquement(navaid, cible);
  _flanquements.push(f);
  _flanqTracer(f);
}

// ------------------------------------------------------------
// Plan de vol
// ------------------------------------------------------------

// Ce qui part dans le .bcpfc : l'identité de la station et les deux positions.
// Ni radial ni distance — ils se recalculent, et la déclinaison aura bougé.
function flanquementsEnregistrables() {
  return _flanquements.map((f) => ({
    vorIdent: f.vorIdent, vorLat: f.vorLat, vorLon: f.vorLon,
    cibleNom: f.cibleNom, lat: f.lat, lon: f.lon,
    rangeNm: Number.isFinite(f.rangeNm) ? f.rangeNm : null,
  }));
}

async function chargerFlanquements(liste) {
  effacerTousFlanquements();
  if (!Array.isArray(liste)) return;
  for (const s of liste) {
    if (!s || !Number.isFinite(s.vorLat) || !Number.isFinite(s.lat)) continue;
    const f = await creerFlanquement(
      { ident: s.vorIdent, lat: s.vorLat, lon: s.vorLon, rangeNm: s.rangeNm },
      { nom: s.cibleNom, lat: s.lat, lon: s.lon }
    );
    _flanquements.push(f);
    _flanqTracer(f);
  }
}

$('btn-flanq-ok').addEventListener('click', validerFlanquement);
$('btn-flanq-cancel').addEventListener('click', fermerModaleFlanquement);
$('flanq-overlay').addEventListener('click', (e) => {
  if (e.target === $('flanq-overlay')) fermerModaleFlanquement();
});
