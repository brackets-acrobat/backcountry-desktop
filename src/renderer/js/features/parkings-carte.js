/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// parkings-carte.js — les places de stationnement sur la carte.
// ============================================================
//
// Repris de Cap CAVVA. Une pastille par place, À L'ÉCHELLE elle aussi : son
// rayon est celui que MSFS déclare pour l'emplacement (`radius_m`), de sorte
// qu'un poste gros-porteur se distingue d'un plot d'aviation générale sans
// qu'on ait à le dire. L'infobulle porte l'identifiant — « GATE A 12 »,
// « PARKING 3 » — et la nature de la place.
//
// SEUIL DE ZOOM 15. À ce zoom la fenêtre couvre trois kilomètres environ : on
// voit l'aire de stationnement, les pastilles se séparent. Au zoom 12, celui des
// pistes, une grande plate-forme ne serait qu'une bouillie de points.
//
// LES TAXIWAYS SONT IGNORÉS — délibérément. SimConnect livre aussi le réseau de
// roulage (TAXI_POINT, TAXI_PATH, TAXI_NAME) ; il alourdirait la base d'un ordre
// de grandeur pour un usage qui n'est pas celui de l'application.
//
// LA DONNÉE N'EXISTE QU'APRÈS RÉIMPORT. Les places viennent du nœud
// TAXI_PARKING, que l'extraction ne demandait pas jusqu'ici : une base importée
// avant n'en contient aucune. Ce n'est pas la même chose que
// « pas de place ici », et la couche le dit plutôt que de rester muette — sous
// la case « Parkings » elle-même, là où le pilote regarde en l'allumant.
//
// UN TERRAIN NE SE RÉDUIT PAS À SON POINT DE RÉFÉRENCE. Les places d'une grande
// plate-forme s'en écartent de plusieurs kilomètres. Chercher les terrains sur
// leur seule référence éteindrait toutes leurs places dès qu'on s'éloigne du
// centre — c'est-à-dire dès qu'on regarde vraiment quelque chose. L'emprise
// interrogée est donc élargie du rayon MESURÉ de chaque terrain (cf.
// dansBboxElargi côté main).
// ============================================================

const ZOOM_MIN_PARKINGS = 15;        // pastilles visibles à partir de ce zoom
const PARKING_RAYON_DEFAUT_M = 12;   // repli si la base n'annonce pas de rayon
// Bleu : il se détache du vert des pistes en herbe et du brun des pistes en
// terre, les deux surfaces les plus courantes d'un terrain de brousse.
const PARKING_COULEUR = '#2563eb';
const PARKING_COULEUR_CARBURANT = '#f59e0b';   // ambre : l'avitaillement se repère

// Codes TYPE du SDK MSFS retenus ici. Les places de service (13, véhicules)
// sont déjà écartées à l'extraction — ce ne sont pas des emplacements d'avion.
const PARKING_CARBURANT = 12;

// Libellés des natures de place. Le fichier porte le nom brut du SDK
// (RAMP_GA_MEDIUM…) ; ce qui se lit à l'écran doit être une phrase.
const PARKING_LIBELLES = {
  fr: {
    1: 'Aviation générale', 2: 'Aviation générale (petit)', 3: 'Aviation générale (moyen)',
    4: 'Aviation générale (grand)', 5: 'Fret', 6: 'Fret militaire', 7: 'Militaire',
    8: 'Poste (petit)', 9: 'Poste (moyen)', 10: 'Poste (gros-porteur)', 11: 'Ponton',
    12: 'Avitaillement', 14: 'Aviation générale', 15: 'Poste',
  },
  en: {
    1: 'General aviation', 2: 'General aviation (small)', 3: 'General aviation (medium)',
    4: 'General aviation (large)', 5: 'Cargo', 6: 'Military cargo', 7: 'Military',
    8: 'Gate (small)', 9: 'Gate (medium)', 10: 'Gate (heavy)', 11: 'Dock',
    12: 'Fuel', 14: 'General aviation', 15: 'Gate',
  },
};

let parkingsLayer = null;
let _parkingsReqId = 0;

function rayonParkingM(p) {
  return (Number.isFinite(p.radius_m) && p.radius_m > 0) ? p.radius_m : PARKING_RAYON_DEFAUT_M;
}

// Nature de la place dans la langue courante ; à défaut, le nom brut du SDK,
// qui vaut mieux qu'une ligne vide.
function libelleTypeParking(p) {
  const table = PARKING_LIBELLES[currentLang] || PARKING_LIBELLES.fr;
  return table[p.type_code] || p.type || '';
}

function makeParkingTooltipHtml(terrain, p) {
  const code = terrain.code || terrain.ident || '';
  const nature = libelleTypeParking(p);
  const lignes = [];
  if (nature) lignes.push(`<div class="ap-tt-rwy">${escapeHtml(nature)}</div>`);
  const r = Math.round(rayonParkingM(p));
  lignes.push(`<div class="ap-tt-rwy">${currentLang === 'fr' ? 'Rayon' : 'Radius'} ${r} m</div>`);
  return `<div class="ap-tt-icao">${escapeHtml(p.ident || '—')}</div>`
    + `<div class="ap-tt-name">${escapeHtml(code)}</div>${lignes.join('')}`;
}

// `versVue` est le convertisseur de longitudes du TERRAIN, bâti une fois pour
// toute son aire : deux places voisines converties séparément se retrouveraient
// à un tour de Terre l'une de l'autre dès que le bord ouest de la vue passe
// entre elles (cf. projecteurFigure).
function dessinerParking(terrain, p, versVue) {
  if (!Number.isFinite(p.latitude_deg) || !Number.isFinite(p.longitude_deg)) return;
  const carburant = p.type_code === PARKING_CARBURANT;
  const couleur = carburant ? PARKING_COULEUR_CARBURANT : PARKING_COULEUR;
  // L.circle prend un rayon en MÈTRES : la pastille suit donc le zoom, comme le
  // rectangle d'une piste. C'est ce qui la rend comparable à ce qui l'entoure.
  const rond = L.circle([p.latitude_deg, versVue(p.longitude_deg)], {
    radius: rayonParkingM(p),
    color: '#fff', weight: 1, opacity: 1,
    fillColor: couleur, fillOpacity: 0.75,
    interactive: true,
  });
  rond.bindTooltip(makeParkingTooltipHtml(terrain, p), {
    direction: 'top', offset: [0, -4], className: 'airport-tooltip', opacity: 1,
  });
  rond.addTo(parkingsLayer);
  rond.bringToBack();   // sous la route et les tracés, comme les pistes
}

// Avis « base sans places », sous la case de la couche. Masqué dès que la
// couche est éteinte : il ne concerne qu'elle.
function majAvisParkings(visible) {
  const avis = $('hint-parkings');
  if (avis) avis.hidden = !visible;
}

async function rafraichirParkings() {
  if (!map || !parkingsLayer) return;
  if (!layerState.parkings) { parkingsLayer.clearLayers(); majAvisParkings(false); return; }
  if (map.getZoom() < ZOOM_MIN_PARKINGS) { parkingsLayer.clearLayers(); return; }

  const b = map.getBounds();
  const bbox = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  const reqId = ++_parkingsReqId;
  let res;
  try { res = await window.bc.parkingsDansBbox(bbox); } catch (_) { return; }
  if (reqId !== _parkingsReqId) return;

  parkingsLayer.clearLayers();
  if (!res || !res.ok) return;

  // Base antérieure à l'extraction des places : on le dit, sinon la couche
  // allumée resterait vide sans qu'on sache pourquoi.
  majAvisParkings(!!res.baseSansParkings);
  if (res.baseSansParkings) return;

  for (const terrain of (res.terrains || [])) {
    // Ancre au point de référence du terrain, à défaut à sa première place.
    const ancre = Number.isFinite(terrain.lon)
      ? terrain.lon
      : (terrain.parkings[0] && terrain.parkings[0].longitude_deg);
    if (!Number.isFinite(ancre)) continue;
    const versVue = projecteurFigure(ancre, bbox);
    for (const p of terrain.parkings) dessinerParking(terrain, p, versVue);
  }
}

// La carte existe déjà (cf. pistes-carte.js) : la couche se crée ici.
parkingsLayer = L.layerGroup().addTo(map);
rafraichirParkings();
