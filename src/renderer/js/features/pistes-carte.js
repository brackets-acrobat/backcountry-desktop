/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// pistes-carte.js — les pistes tracées sur la carte, à l'échelle.
// ============================================================
//
// Repris de Cap CAVVA. Chaque piste est un RECTANGLE GÉOGRAPHIQUE : ses quatre
// coins se déduisent des deux seuils et de la largeur publiée. Il est donc à
// l'échelle de la carte — il grandit avec le zoom comme le terrain qu'il
// représente, au lieu d'être un symbole de taille fixe.
//
// Ce que ça donne aux zooms utiles, à 45° de latitude :
//   zoom 12 → 27 m/px   : une piste de 42 m fait 1,6 px. Un trait, mais un
//                         trait juste, à sa longueur et à son orientation.
//   zoom 14 → 6,8 m/px  : 6 px, la piste devient une forme ; les numéros
//                         apparaissent à ses deux bouts.
//   zoom 16 → 1,7 m/px  : 25 px, elle se lit comme sur une carte VAC.
//
// Le tracé est exact : vérifié dans Cap CAVVA sur 401 pistes françaises, la
// distance entre les deux seuils enregistrés vaut la longueur déclarée à
// 0,003 % près — les seuils MSFS sont bien les extrémités physiques.
//
// COULEURS : celles des marqueurs d'aérodrome (surfaceMarkerColors), pour que
// le rectangle et la pastille qui le désigne parlent la même langue — herbe en
// vert, terre en brun, eau en bleu. Une piste revêtue sort donc en blanc cerné
// de noir, ce qui se trouve être la convention des cartes VAC.
//
// SOUS LES TRACÉS : chaque rectangle est renvoyé au fond du SVG à peine posé.
// Le dernier chemin ajouté étant celui du dessus, un simple panoramique — qui
// redessine les pistes — les ferait sinon passer PAR-DESSUS la route, un
// flanquement ou un tour de piste déjà tracés.
//
// La donnée vient de `pistes-bbox` (main), dont l'index se bâtit au premier
// appel : allumer la couche coûte une fois moins d'une seconde, puis quelques
// millisecondes par déplacement.
//
// UN TERRAIN NE SE RÉDUIT PAS À SON POINT DE RÉFÉRENCE : l'emprise interrogée
// est élargie du rayon propre à chaque terrain (cf. dansBboxElargi côté main),
// faute de quoi une grande plate-forme s'effacerait dès qu'on regarde le bout
// d'une de ses pistes.
// ============================================================

const ZOOM_MIN_PISTES = 12;      // rectangles visibles à partir de ce zoom
const ZOOM_MIN_NUMEROS = 14;     // numéros de piste (QFU) à partir de ce zoom
const PISTE_LARGEUR_DEFAUT_M = 30;   // repli si la base n'annonce pas de largeur
const PISTE_ECART_NUMERO_PX = 13;    // recul du numéro au-delà du seuil

let pistesLayer = null;
let _pistesReqId = 0;            // dernière requête émise (les réponses tardives sont jetées)

// Longueur d'une piste en mètres : la valeur déclarée si elle existe, sinon la
// distance entre les seuils. Les deux concordent — la seconde n'est là que pour
// ne jamais afficher un tiret là où la géométrie sait répondre.
function longueurPisteM(p) {
  if (Number.isFinite(p.longueurFt) && p.longueurFt > 0) return p.longueurFt * 0.3048;
  return distanceNM(p.leLat, p.leLon, p.heLat, p.heLon) * 1852;
}

function largeurPisteM(p) {
  return (Number.isFinite(p.largeurFt) && p.largeurFt > 0)
    ? p.largeurFt * 0.3048 : PISTE_LARGEUR_DEFAUT_M;
}

function makePisteTooltipHtml(terrain, p) {
  const fr = currentLang === 'fr';
  const code = terrain.code || terrain.ident || '';
  const lm = Math.round(longueurPisteM(p));
  const wm = Math.round(largeurPisteM(p));
  const lignes = [`<div class="ap-tt-rwy">${fr ? 'Piste' : 'Runway'} ${escapeHtml(p.le)}/${escapeHtml(p.he)}</div>`];
  lignes.push(`<div class="ap-tt-rwy">${lm} m &times; ${wm} m</div>`);
  if (p.surface) lignes.push(`<div class="ap-tt-rwy">${escapeHtml(p.surface)}</div>`);
  return `<div class="ap-tt-icao">${escapeHtml(code)}</div>`
    + `<div class="ap-tt-name">${escapeHtml(terrain.name || '')}</div>${lignes.join('')}`;
}

// Étiquette d'un numéro de piste, posée JUSTE AU-DELÀ du seuil (et non dessus :
// sur une piste étroite elle la recouvrirait entièrement), alignée sur l'axe et
// jamais à l'envers.
function etiquetteNumeroPiste(lat, lon, capSortant, texte) {
  const dx = Math.sin(capSortant * Math.PI / 180) * PISTE_ECART_NUMERO_PX;
  const dy = -Math.cos(capSortant * Math.PI / 180) * PISTE_ECART_NUMERO_PX;
  const signe = (v) => (v >= 0 ? `+ ${v.toFixed(1)}px` : `- ${Math.abs(v).toFixed(1)}px`);
  const transform = `translate(calc(-50% ${signe(dx)}), calc(-50% ${signe(dy)}))`
    + ` rotate(${angleEcranPourCap(capSortant).toFixed(1)}deg)`;
  return L.marker([lat, lon], {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: 'piste-etiquette',
      html: `<span class="piste-numero" style="transform:${transform};">${escapeHtml(texte)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

// Trace UNE piste : le rectangle, puis ses deux numéros si le zoom les autorise.
//
// Les deux seuils passent par le MÊME convertisseur, ancré sur le premier
// d'entre eux. Les convertir séparément étirerait la piste sur un tour de Terre
// dès que le bord ouest de la vue passe entre eux (cf. projecteurFigure).
function dessinerPiste(terrain, p, bbox, avecNumeros) {
  const versVue = projecteurFigure(p.leLon, bbox);
  const A = { lat: p.leLat, lon: versVue(p.leLon) };
  const B = { lat: p.heLat, lon: versVue(p.heLon) };
  const axe = capVraiInitial(A.lat, A.lon, B.lat, B.lon);
  const demi = largeurPisteM(p) / 2;
  const gauche = (axe + 270) % 360, droite = (axe + 90) % 360;

  // Coins pris dans l'ordre du pourtour : A gauche, B gauche, B droite, A droite.
  const coins = [
    pointADistance(A.lat, A.lon, gauche, demi),
    pointADistance(B.lat, B.lon, gauche, demi),
    pointADistance(B.lat, B.lon, droite, demi),
    pointADistance(A.lat, A.lon, droite, demi),
  ].map((q) => [q.lat, q.lon]);

  const sc = surfaceMarkerColors(p.surface);
  const rect = L.polygon(coins, {
    color: sc.stroke, weight: 1, opacity: 1,
    fillColor: sc.fill, fillOpacity: 0.85,
    interactive: true,
  });
  rect.bindTooltip(makePisteTooltipHtml(terrain, p), {
    direction: 'top', offset: [0, -4], className: 'airport-tooltip', opacity: 1, sticky: true,
  });
  rect.addTo(pistesLayer);
  rect.bringToBack();   // sous la route et les tracés (cf. en-tête)

  if (!avecNumeros) return;
  // Le numéro d'un seuil se lit en s'éloignant de l'autre : il sort donc par
  // l'extérieur, dans le prolongement de l'axe.
  if (p.le) etiquetteNumeroPiste(A.lat, A.lon, (axe + 180) % 360, p.le).addTo(pistesLayer);
  if (p.he) etiquetteNumeroPiste(B.lat, B.lon, axe, p.he).addTo(pistesLayer);
}

async function rafraichirPistes() {
  if (!map || !pistesLayer) return;
  if (!layerState.pistes || map.getZoom() < ZOOM_MIN_PISTES) { pistesLayer.clearLayers(); return; }

  const b = map.getBounds();
  const bbox = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  const reqId = ++_pistesReqId;
  let res;
  try { res = await window.bc.pistesDansBbox(bbox); } catch (_) { return; }
  if (reqId !== _pistesReqId) return;   // un déplacement plus récent a pris la main

  pistesLayer.clearLayers();
  if (!res || !res.ok) return;
  const avecNumeros = map.getZoom() >= ZOOM_MIN_NUMEROS;
  for (const terrain of res.terrains) {
    for (const p of terrain.pistes) dessinerPiste(terrain, p, bbox, avecNumeros);
  }
}

// La carte existe déjà : renderer.js appelle initMap() avant de charger les
// fonctionnalités. La couche se crée donc ici, et se remplit aussitôt si la
// case était restée cochée à la fermeture précédente.
pistesLayer = L.layerGroup().addTo(map);
rafraichirPistes();
