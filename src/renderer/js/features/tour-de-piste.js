/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// tour-de-piste.js — circuit d'aérodrome tracé sur la carte.
// ============================================================
//
// Repris de Cap CAVVA, qui le tenait de NavXpressVFR (traffic-pattern.js).
// Clic droit sur un terrain → « Tracer un tour de piste » → une modale demande
// la piste (donc le sens d'atterrissage), la main du circuit, la longueur des
// branches et l'altitude. À la validation, le circuit apparaît en rouge, avec
// le cap MAGNÉTIQUE de chaque branche, une pointe de flèche dans le sens du vol,
// et l'altitude au centre. Plusieurs circuits coexistent ; chacun s'efface par
// clic droit sur son tracé, comme les cercles de portée et les flanquements.
//
// GÉOMÉTRIE — à partir des DEUX seuils de la piste (details-aeroport) :
//   SEUIL   = seuil d'atterrissage (l'extrémité choisie dans la modale)
//   OPPOSÉ  = seuil opposé (celui du décollage)
//   axe     = relèvement SEUIL→OPPOSÉ = sens d'atterrissage (cap vrai)
//   côté    = axe − 90 (main gauche) ou + 90 (main droite)
//   Pf      = à `finale` NM en amont du SEUIL, dans l'axe    — entrée de finale
//   Pm      = à `montée` NM au-delà de l'OPPOSÉ, dans l'axe  — fin de la montée
//   PmCôté  = Pm décalé de `traversier` NM vers le côté      — fin du traversier
//   PfCôté  = Pf décalé de `traversier` NM vers le côté      — fin du vent arrière
// Boucle : Pf → SEUIL → OPPOSÉ → Pm (axe de piste, non étiqueté) → PmCôté
// (traversier) → PfCôté (vent arrière) → Pf (base) → SEUIL (finale).
//
// SEUILS DE ZOOM : le tracé apparaît au zoom 11, les étiquettes de cap au
// zoom 13 — en deçà, un circuit de deux milles n'est qu'un pâté illisible.
//
// ÉCARTS AVEC NAVXPRESSVFR, REPRIS DE CAP CAVVA :
//
//  • La géométrie de base vient de renderer.js (capVraiInitial, pointADistance,
//    angleEcranPourCap, wrapLon) plutôt que d'être recopiée, comme pour le
//    flanquement. La couche « pistes » s'en sert aussi.
//
//  • Pas de modale de confirmation avant une suppression : il n'y en a ni pour
//    les cercles de portée, ni pour les mesures, ni pour les flanquements. Un
//    tracé se refait en trois clics.
//
//  • Pas d'annonce vocale « vent arrière ». Le simulateur fournit pourtant déjà
//    tout ce qu'il faudrait (cap vrai, altitude, hauteur-sol) — l'ajout reste
//    ouvert.
//
// Les circuits partent dans le plan de vol (.bcpfc) : les paramètres saisis, les
// deux seuils et la déclinaison. Rien n'y est recalculé à la lecture — un
// circuit tracé est un choix du pilote, pas une donnée dérivée.
// ============================================================

const TDP_COULEUR = '#ff0000';
const TDP_ZOOM_TRACE = 11;        // tracé visible à partir de ce zoom
const TDP_ZOOM_CAPS = 13;         // étiquettes de cap visibles à partir de ce zoom
const TDP_NM_M = 1852;            // 1 NM en mètres
const TDP_CONGE_NM = 0.1;         // rayon d'arrondi des angles du circuit
// Décalage écran de l'étiquette vers l'extérieur du circuit : demi-hauteur de
// police + demi-épaisseur du trait + ~4 px de marge.
const TDP_ECART_ETIQ_PX = 16;

// Bornes de saisie de la modale (reprises de NavXpressVFR).
const TDP_BRANCHE_MIN = 0.1, TDP_BRANCHE_MAX = 3;
const TDP_FINALE_MAX = 4;
const TDP_ALT_MIN = 500, TDP_ALT_MAX = 3000;

// Valeurs proposées à la première ouverture ; ensuite la modale garde la
// dernière saisie — on trace rarement un seul circuit dans une préparation.
const TDP_DEFAUTS = { montee: '0.5', traversier: '0.5', finale: '0.7', altitude: '1000' };

let toursDePiste = [];        // circuits tracés : paramètres + couches Leaflet
let _tdpTraceLayer = null;    // tracé et flèches (zoom ≥ 11)
let _tdpEtiqLayer = null;     // caps et altitude (zoom ≥ 13)
let _tdpTraceVisible = false, _tdpEtiqVisible = false;
let _tdpTerrain = null;       // terrain de la modale ouverte
let _tdpExtremites = [];      // extrémités de piste proposées dans la modale

// ------------------------------------------------------------
// Couches et seuils de zoom
// ------------------------------------------------------------

// Les deux couches ne sont PAS ajoutées d'emblée : leur présence sur la carte
// est précisément ce qui porte le seuil de zoom.
function initTourDePiste() {
  _tdpTraceLayer = L.layerGroup();
  _tdpEtiqLayer = L.layerGroup();
  map.on('zoomend', majVisibiliteTourDePiste);
}

function majVisibiliteTourDePiste() {
  if (!map || !_tdpTraceLayer) return;
  const y = toursDePiste.length > 0;
  const z = map.getZoom();
  const trace = y && z >= TDP_ZOOM_TRACE;
  const etiq = y && z >= TDP_ZOOM_CAPS;
  if (trace && !_tdpTraceVisible) { _tdpTraceLayer.addTo(map); _tdpTraceVisible = true; }
  else if (!trace && _tdpTraceVisible) { map.removeLayer(_tdpTraceLayer); _tdpTraceVisible = false; }
  if (etiq && !_tdpEtiqVisible) { _tdpEtiqLayer.addTo(map); _tdpEtiqVisible = true; }
  else if (!etiq && _tdpEtiqVisible) { map.removeLayer(_tdpEtiqLayer); _tdpEtiqVisible = false; }
}

function aDesToursDePiste() { return toursDePiste.length > 0; }

// ------------------------------------------------------------
// Géométrie
// ------------------------------------------------------------

// Longitude ramenée à moins de 180° d'une référence (déroulage local).
function tdpDerouler(lon, ref) {
  let l = lon;
  while (l - ref > 180) l -= 360;
  while (l - ref < -180) l += 360;
  return l;
}

// Écart angulaire absolu entre deux caps, en degrés (0..180).
function tdpEcartCap(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

// Boucle fermée [[lat, lon], …] passant par `coins` ({lat, lon}), chaque angle
// remplacé par un congé (arc de cercle) de rayon `rNM`. Calcul en projection
// planaire locale (équirectangulaire) autour du premier coin — exact à
// l'échelle d'un tour de piste. La distance de tangence est bornée à la
// demi-longueur des côtés adjacents : un côté plus court que le rayon réduit
// l'arrondi au lieu de le faire déborder.
function tdpBoucleArrondie(coins, rNM, segParArc) {
  const n = coins.length;
  if (n < 3) return coins.map((c) => [c.lat, c.lon]);
  const lat0 = coins[0].lat, lon0 = coins[0].lon;
  const MPD = 111320;                                   // mètres par degré de latitude
  const cosL = Math.cos(lat0 * Math.PI / 180) || 1e-6;
  const versXY = (c) => ({ x: (c.lon - lon0) * MPD * cosL, y: (c.lat - lat0) * MPD });
  const versLL = (p) => [lat0 + p.y / MPD, lon0 + p.x / (MPD * cosL)];
  const P = coins.map(versXY);
  const rM = rNM * TDP_NM_M;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cur = P[i], prec = P[(i - 1 + n) % n], suiv = P[(i + 1) % n];
    let ax = prec.x - cur.x, ay = prec.y - cur.y;
    let bx = suiv.x - cur.x, by = suiv.y - cur.y;
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    ax /= la; ay /= la; bx /= lb; by /= lb;
    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by));
    const alpha = Math.acos(dot);                       // angle intérieur au coin
    if (alpha < 1e-3 || Math.PI - alpha < 1e-3) { out.push(versLL(cur)); continue; }
    const demi = alpha / 2;
    const tang = Math.min(rM / Math.tan(demi), 0.5 * la, 0.5 * lb);
    const rEff = tang * Math.tan(demi);
    const T1 = { x: cur.x + ax * tang, y: cur.y + ay * tang };
    const T2 = { x: cur.x + bx * tang, y: cur.y + by * tang };
    let bisx = ax + bx, bisy = ay + by;
    const lbis = Math.hypot(bisx, bisy) || 1;
    bisx /= lbis; bisy /= lbis;
    const O = { x: cur.x + bisx * (rEff / Math.sin(demi)), y: cur.y + bisy * (rEff / Math.sin(demi)) };
    const a1 = Math.atan2(T1.y - O.y, T1.x - O.x);
    let da = Math.atan2(T2.y - O.y, T2.x - O.x) - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const pas = Math.max(2, segParArc);
    for (let s = 0; s <= pas; s++) {
      const ang = a1 + da * (s / pas);
      out.push(versLL({ x: O.x + rEff * Math.cos(ang), y: O.y + rEff * Math.sin(ang) }));
    }
  }
  return out;
}

// ------------------------------------------------------------
// Tracé
// ------------------------------------------------------------

// Construit la géométrie et pose le tracé à partir d'un jeu de paramètres
// complet — le même objet vient de la modale ou du plan de vol relu. L'entrée
// (paramètres + couches Leaflet) est poussée dans `toursDePiste`.
function tracerTourDePiste(p) {
  if (!p || !p.seuil || !p.oppose || !_tdpTraceLayer) return null;

  // Repère déroulé autour du seuil : tout le circuit tient dans quelques
  // milles, l'antiméridien ne coupe donc jamais une branche.
  const ref = p.seuil.lon;
  const SEUIL = { lat: p.seuil.lat, lon: ref };
  const OPPOSE = { lat: p.oppose.lat, lon: tdpDerouler(p.oppose.lon, ref) };

  const axe = capVraiInitial(SEUIL.lat, SEUIL.lon, OPPOSE.lat, OPPOSE.lon);
  const cote = ((p.sens === 'droite' ? axe + 90 : axe - 90) + 360) % 360;

  const Pf = pointADistance(SEUIL.lat, SEUIL.lon, (axe + 180) % 360, p.finaleNM * TDP_NM_M);
  const Pm = pointADistance(OPPOSE.lat, OPPOSE.lon, axe, p.monteeNM * TDP_NM_M);
  const PmCote = pointADistance(Pm.lat, Pm.lon, cote, p.traversierNM * TDP_NM_M);
  const PfCote = pointADistance(Pf.lat, Pf.lon, cote, p.traversierNM * TDP_NM_M);

  const decl = Number.isFinite(p.declinaison) ? p.declinaison : 0;
  const capMag = (vrai) => String(Math.round(((vrai - decl) % 360 + 360) % 360) % 360).padStart(3, '0');

  // Centroïde du circuit : il dit de quel côté est l'EXTÉRIEUR, donc où poser
  // les étiquettes pour qu'elles ne tombent pas à l'intérieur du circuit.
  const pts = [Pf, SEUIL, OPPOSE, Pm, PmCote, PfCote];
  const cLat = pts.reduce((s, q) => s + q.lat, 0) / pts.length;
  const cLon = pts.reduce((s, q) => s + q.lon, 0) / pts.length;

  // Branches étiquetées. La piste elle-même (SEUIL→OPPOSÉ) ne l'est pas : son
  // cap est celui de la finale, et le numéro de piste le dit déjà.
  const branches = [
    { de: OPPOSE, a: Pm },       // montée initiale
    { de: Pm, a: PmCote },       // vent traversier
    { de: PmCote, a: PfCote },   // vent arrière
    { de: PfCote, a: Pf },       // étape de base
    { de: Pf, a: SEUIL },        // finale
  ];

  const entree = {
    ident: p.ident, code: p.code, nom: p.nom,
    lat: p.lat, lon: p.lon,
    piste: p.piste, opposee: p.opposee,
    seuil: { lat: p.seuil.lat, lon: p.seuil.lon },
    oppose: { lat: p.oppose.lat, lon: p.oppose.lon },
    sens: p.sens,
    monteeNM: p.monteeNM,
    traversierNM: p.traversierNM,
    finaleNM: p.finaleNM,
    altitudeFt: p.altitudeFt,
    declinaison: decl,
    _couches: [],
  };

  // Rectangle aux angles arrondis : Pf → Pm (axe de piste) → PmCôté
  // (traversier) → PfCôté (vent arrière), la base refermant la boucle.
  const trace = tdpBoucleArrondie([Pf, Pm, PmCote, PfCote], TDP_CONGE_NM, 8);
  trace.push(trace[0]);

  // Bande de clic élargie, invisible : viser un trait de 3 px au clic droit
  // n'est pas un geste, c'est une épreuve. Même procédé que les cercles.
  const zone = L.polyline(trace, { color: TDP_COULEUR, weight: 14, opacity: 0, interactive: true });
  zone.on('contextmenu', (e) => ouvrirMenuTourDePiste(e, () => supprimerTourDePiste(entree)));
  zone.on('mouseover', () => { if (!_routeDragging) map.getContainer().style.cursor = 'pointer'; });
  zone.on('mouseout', () => { if (!_routeDragging) map.getContainer().style.cursor = ''; });
  _tdpTraceLayer.addLayer(zone);
  entree._couches.push(zone);

  const ligne = L.polyline(trace, { color: TDP_COULEUR, weight: 3, opacity: 1, fill: false, interactive: false });
  _tdpTraceLayer.addLayer(ligne);
  entree._couches.push(ligne);

  const signe = (v) => (v >= 0 ? `+ ${v.toFixed(1)}px` : `- ${Math.abs(v).toFixed(1)}px`);
  branches.forEach((b) => {
    const vrai = capVraiInitial(b.de.lat, b.de.lon, b.a.lat, b.a.lon);
    const milieu = { lat: (b.de.lat + b.a.lat) / 2, lon: (b.de.lon + b.a.lon) / 2 };

    // Perpendiculaire EXTÉRIEURE : celle des deux qui s'éloigne du centroïde.
    const versMilieu = capVraiInitial(cLat, cLon, milieu.lat, milieu.lon);
    const p1 = (vrai + 90) % 360, p2 = (vrai + 270) % 360;
    const dehors = tdpEcartCap(p1, versMilieu) <= tdpEcartCap(p2, versMilieu) ? p1 : p2;
    const dx = Math.sin(dehors * Math.PI / 180) * TDP_ECART_ETIQ_PX;
    const dy = -Math.cos(dehors * Math.PI / 180) * TDP_ECART_ETIQ_PX;
    const transform = `translate(calc(-50% ${signe(dx)}), calc(-50% ${signe(dy)}))`
      + ` rotate(${angleEcranPourCap(vrai).toFixed(1)}deg)`;

    const etiq = L.marker([milieu.lat, milieu.lon], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'tdp-etiquette',
        html: `<span class="tdp-cap" style="transform:${transform};">${capMag(vrai)}&deg;</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    });
    _tdpEtiqLayer.addLayer(etiq);
    entree._couches.push(etiq);

    // Pointe de flèche au milieu de la branche, dans le SENS DU VOL : c'est
    // elle qui dit si le circuit se fait main gauche ou main droite. Angle
    // écran RÉEL, non ramené dans ±90 comme celui du texte — une flèche
    // retournée désignerait le sens inverse.
    const angle = Math.atan2(-Math.cos(vrai * Math.PI / 180), Math.sin(vrai * Math.PI / 180)) * 180 / Math.PI;
    const fleche = L.marker([milieu.lat, milieu.lon], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'tdp-etiquette',
        html: `<span class="tdp-fleche" style="transform:translate(-50%,-50%) rotate(${angle.toFixed(1)}deg);">`
          + '<svg width="20" height="20" viewBox="-10 -10 20 20" style="display:block;overflow:visible;">'
          + `<polygon points="-4,-6 7,0 -4,6" fill="${TDP_COULEUR}"/></svg></span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    });
    _tdpTraceLayer.addLayer(fleche);
    entree._couches.push(fleche);
  });

  // Altitude au centre du circuit, alignée sur les grands côtés (axe de piste
  // et vent arrière), donc lisible sans tourner la tête.
  const centre = [
    (Pf.lat + Pm.lat + PmCote.lat + PfCote.lat) / 4,
    (Pf.lon + Pm.lon + PmCote.lon + PfCote.lon) / 4,
  ];
  const etiqAlt = L.marker(centre, {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: 'tdp-etiquette',
      html: `<span class="tdp-alt" style="transform:translate(-50%,-50%) rotate(${angleEcranPourCap(axe).toFixed(1)}deg);">`
        + `${entree.altitudeFt} ft</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
  _tdpEtiqLayer.addLayer(etiqAlt);
  entree._couches.push(etiqAlt);

  toursDePiste.push(entree);
  majVisibiliteTourDePiste();
  return entree;
}

function supprimerTourDePiste(entree) {
  const i = toursDePiste.indexOf(entree);
  if (i < 0) return;
  (entree._couches || []).forEach((c) => {
    if (_tdpTraceLayer.hasLayer(c)) _tdpTraceLayer.removeLayer(c);
    if (_tdpEtiqLayer.hasLayer(c)) _tdpEtiqLayer.removeLayer(c);
  });
  toursDePiste.splice(i, 1);
  majVisibiliteTourDePiste();
}

function effacerTousToursDePiste() {
  if (_tdpTraceLayer) _tdpTraceLayer.clearLayers();
  if (_tdpEtiqLayer) _tdpEtiqLayer.clearLayers();
  toursDePiste = [];
  majVisibiliteTourDePiste();
}

// ------------------------------------------------------------
// Modale
// ------------------------------------------------------------

// UNE ENTRÉE PAR EXTRÉMITÉ de piste : c'est le sens d'atterrissage qui définit
// le circuit, et une piste 17/35 en offre donc deux, opposées.
function tdpExtremites(pistes) {
  const out = [];
  for (const r of (Array.isArray(pistes) ? pistes : [])) {
    out.push({
      piste: r.le, opposee: r.he,
      seuil: { lat: r.leLat, lon: r.leLon },
      oppose: { lat: r.heLat, lon: r.heLon },
      longueurFt: r.longueurFt,
    });
    out.push({
      piste: r.he, opposee: r.le,
      seuil: { lat: r.heLat, lon: r.heLon },
      oppose: { lat: r.leLat, lon: r.leLon },
      longueurFt: r.longueurFt,
    });
  }
  return out;
}

async function ouvrirModaleTourDePiste(airport) {
  if (!airport || !airport.ident) return;
  let res = null;
  try { res = await window.bc.detailsAeroport(airport.ident); } catch (_) { res = null; }
  const a = (res && res.ok) ? res.airport : null;

  // Le marqueur cliqué reste la source de repli : la base a pu changer sous nos
  // pieds (import en cours), la modale doit s'ouvrir quand même — quitte à
  // n'avoir aucune piste à proposer, ce qu'elle dit alors.
  _tdpTerrain = {
    ident: airport.ident,
    code: airport.code || (a && a.code) || airport.ident,
    nom: (a && a.name) || airport.name || airport.ident,
    lat: (a && Number.isFinite(a.lat)) ? a.lat : airport.lat,
    lon: (a && Number.isFinite(a.lon)) ? a.lon : airport.lon,
  };
  _tdpExtremites = tdpExtremites(res && res.ok ? res.pistes : []);

  $('tdp-terrain').textContent = `${_tdpTerrain.code} — ${_tdpTerrain.nom}`;
  const liste = $('tdp-pistes');
  liste.innerHTML = '';
  $('tdp-aucune').hidden = _tdpExtremites.length > 0;
  _tdpExtremites.forEach((e, i) => {
    const longueur = Number.isFinite(e.longueurFt) ? ` — ${e.longueurFt} ft` : '';
    const l = document.createElement('label');
    l.className = 'tdp-item';
    l.innerHTML = `<input type="radio" name="tdp-piste" value="${i}"${i === 0 ? ' checked' : ''}>`
      + `<span class="tdp-item-nom">${escapeHtml(t('tdpPisteMot'))} ${escapeHtml(e.piste)}${escapeHtml(longueur)}</span>`;
    liste.appendChild(l);
  });

  // La saisie précédente est conservée d'une ouverture à l'autre.
  if (!$('tdp-montee').value) $('tdp-montee').value = TDP_DEFAUTS.montee;
  if (!$('tdp-traversier').value) $('tdp-traversier').value = TDP_DEFAUTS.traversier;
  if (!$('tdp-finale').value) $('tdp-finale').value = TDP_DEFAUTS.finale;
  if (!$('tdp-altitude').value) $('tdp-altitude').value = TDP_DEFAUTS.altitude;
  $('tdp-error').textContent = '';
  $('tdp-overlay').hidden = false;
}

function fermerModaleTourDePiste() {
  $('tdp-overlay').hidden = true;
  _tdpTerrain = null;
  _tdpExtremites = [];
}

// Nombre saisi, virgule décimale acceptée (un clavier français la donne).
function tdpNombre(id) {
  return parseFloat(String($(id).value || '').trim().replace(',', '.'));
}

async function validerTourDePiste() {
  if (!_tdpTerrain) { fermerModaleTourDePiste(); return; }
  const err = $('tdp-error');
  err.textContent = '';

  const choix = $('tdp-pistes').querySelector('input[name="tdp-piste"]:checked');
  const bout = choix ? _tdpExtremites[parseInt(choix.value, 10)] : null;
  if (!bout) { err.textContent = t('tdpErrPiste'); return; }

  const montee = tdpNombre('tdp-montee');
  const traversier = tdpNombre('tdp-traversier');
  const finale = tdpNombre('tdp-finale');
  const altitude = tdpNombre('tdp-altitude');
  const dansPlage = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
  if (!dansPlage(montee, TDP_BRANCHE_MIN, TDP_BRANCHE_MAX)) { err.textContent = t('tdpErrMontee'); return; }
  if (!dansPlage(traversier, TDP_BRANCHE_MIN, TDP_BRANCHE_MAX)) { err.textContent = t('tdpErrTraversier'); return; }
  if (!dansPlage(finale, TDP_BRANCHE_MIN, TDP_FINALE_MAX)) { err.textContent = t('tdpErrFinale'); return; }
  if (!dansPlage(altitude, TDP_ALT_MIN, TDP_ALT_MAX)) { err.textContent = t('tdpErrAltitude'); return; }

  const sensChoisi = $('tdp-overlay').querySelector('input[name="tdp-sens"]:checked');
  const sens = (sensChoisi && sensChoisi.value === 'droite') ? 'droite' : 'gauche';

  // Déclinaison AU TERRAIN, comme pour le flanquement : les caps d'un circuit
  // se lisent sur place, pas à la moyenne d'une route qui passe au loin.
  const terrain = _tdpTerrain;
  fermerModaleTourDePiste();
  let decl = declinaisonEn(terrain.lat, terrain.lon);
  try {
    const rd = await window.bc.declinaison(terrain.lat, wrapLon(terrain.lon));
    if (rd && rd.ok && Number.isFinite(rd.decl)) decl = rd.decl;
  } catch (_) { /* repli : le cache de route, déjà chargé ci-dessus */ }

  tracerTourDePiste({
    ident: terrain.ident, code: terrain.code, nom: terrain.nom,
    lat: terrain.lat, lon: terrain.lon,
    piste: bout.piste, opposee: bout.opposee,
    seuil: bout.seuil, oppose: bout.oppose,
    sens,
    monteeNM: montee, traversierNM: traversier, finaleNM: finale,
    altitudeFt: Math.round(altitude),
    declinaison: decl,
  });
}

// ------------------------------------------------------------
// Plan de vol
// ------------------------------------------------------------

// Ce qui part dans le .bcpfc : les paramètres saisis et les deux seuils. La
// déclinaison EST enregistrée, contrairement au flanquement — un tour de piste
// relu doit porter les caps qui ont servi à la préparation, et non ceux du jour
// où on le rouvre.
function toursDePisteEnregistrables() {
  return toursDePiste.map((e) => ({
    ident: e.ident, code: e.code, nom: e.nom,
    lat: e.lat, lon: e.lon,
    piste: e.piste, opposee: e.opposee,
    seuil: { lat: e.seuil.lat, lon: e.seuil.lon },
    oppose: { lat: e.oppose.lat, lon: e.oppose.lon },
    sens: e.sens,
    monteeNM: e.monteeNM, traversierNM: e.traversierNM, finaleNM: e.finaleNM,
    altitudeFt: e.altitudeFt,
    declinaison: e.declinaison,
  }));
}

// Relit les circuits d'un plan. Aucun appel : tout est dans le fichier. Les
// entrées privées de seuils sont ignorées — sans axe, pas de circuit.
function chargerToursDePiste(liste) {
  effacerTousToursDePiste();
  if (!Array.isArray(liste)) return;
  for (const p of liste) {
    if (!p || !p.seuil || !p.oppose) continue;
    if (!Number.isFinite(p.seuil.lat) || !Number.isFinite(p.seuil.lon)) continue;
    if (!Number.isFinite(p.oppose.lat) || !Number.isFinite(p.oppose.lon)) continue;
    tracerTourDePiste({
      ident: p.ident, code: p.code, nom: p.nom,
      lat: p.lat, lon: p.lon,
      piste: p.piste, opposee: p.opposee,
      seuil: p.seuil, oppose: p.oppose,
      sens: p.sens === 'droite' ? 'droite' : 'gauche',
      monteeNM: Number(p.monteeNM) || 0.5,
      traversierNM: Number(p.traversierNM) || 0.5,
      finaleNM: Number(p.finaleNM) || 0.7,
      altitudeFt: Number(p.altitudeFt) || 1000,
      declinaison: Number(p.declinaison) || 0,
    });
  }
}

$('btn-tdp-ok').addEventListener('click', validerTourDePiste);
$('btn-tdp-cancel').addEventListener('click', fermerModaleTourDePiste);
$('tdp-overlay').addEventListener('click', (e) => {
  if (e.target === $('tdp-overlay')) fermerModaleTourDePiste();
});
['tdp-montee', 'tdp-traversier', 'tdp-finale', 'tdp-altitude'].forEach((id) => {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); validerTourDePiste(); }
    else if (e.key === 'Escape') { e.preventDefault(); fermerModaleTourDePiste(); }
  });
});

// La carte existe déjà : renderer.js appelle initMap() avant de charger les
// fonctionnalités.
initTourDePiste();
