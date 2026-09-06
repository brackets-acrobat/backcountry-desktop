/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// compas.js — rose des vents magnétique autour de l'appareil.
//
// Portage de Little Navmap (MapPainterMark::paintCompassRose), repris de
// Clear Sky VFR : couronne alignée sur le NORD MAGNÉTIQUE, repère blanc du nord
// vrai, graduations 5/10/45/90°, cercles de distance, route et cap, angle de
// crabe et trait vers le point tournant suivant.
//
// TROIS ÉCARTS ASSUMÉS avec l'original :
//
//  1. LNM dimensionne sa rose en MÈTRES (80 % du plus petit côté de la vue, borné
//     en NM) : elle grandit à l'écran quand on dézoome, et sa couronne est un
//     objet du terrain. Ici le rayon vaut 350 PIXELS, constant à tous les zooms.
//     La rose est donc un dessin d'ÉCRAN — d'où un SVG en pixels posé dans un
//     divIcon, et non des tracés Leaflet en coordonnées. Seuls les cercles de
//     distance restent métriques : leur pas se recalcule à chaque zoom.
//
//  2. LNM masque les graduations fines au-delà d'une certaine distance de vue,
//     parce que sa couronne métrique s'y resserre à l'écran. À rayon fixe en
//     pixels ce resserrement n'existe pas : les 72 graduations sont toujours
//     tracées.
//
//  3. La déclinaison suit LNM : celle DÉCLARÉE PAR LE SIMULATEUR tant qu'il est
//     connecté (decl = cap vrai − cap magnétique, les deux venant de la même
//     trame), le modèle WMM du main sinon. C'est le même arbitrage que
//     l'indicateur de vent, et non celui des étiquettes de leg, qui sont au WMM
//     en toutes circonstances.
//
// Convention partagée avec la déclinaison du socle : decl > 0 = Est, cap vrai =
// cap magnétique + decl. Une graduation `g` se pose donc au relèvement VRAI
// `g + decl`, et comme la carte est nord-vrai, le nord vrai reste à 12 heures.
// ============================================================

const COMPAS_RAYON_PX = 350;                                    // rayon demandé, en pixels d'écran
const COMPAS_MARGE_PX = 70;                                     // place pour l'étiquette TRK, posée à 1,1 R
const COMPAS_C        = COMPAS_RAYON_PX + COMPAS_MARGE_PX;      // centre du SVG
const COMPAS_TAILLE   = 2 * COMPAS_C;                           // côté du SVG

const COMPAS_TRAIT  = '#800000';   // mapcolors::compassRoseColor (Qt::darkRed)
const COMPAS_TEXTE  = '#000000';   // mapcolors::compassRoseTextColor (Qt::black)
const COMPAS_FOND   = 'rgba(255,255,255,0.75)';   // cartouche des libellés (symbolPainter::textBox)
const COMPAS_EP     = 2;           // épaisseur de base (LNM : szF(thicknessCompassRose, 2))
const COMPAS_EP_FIN = COMPAS_EP / 4;              // cercles de distance (LNM : lineWidth / 4)

let _compasActif = localStorage.getItem('bc-compas') === '1';
let _compasMarker = null;

// --- Petites géométries ------------------------------------------------------

function _compasNorm360(v) { return ((v % 360) + 360) % 360; }
function _compasDeg3(v) { return String(Math.round(_compasNorm360(v)) % 360).padStart(3, '0'); }

// Point du repère SVG au relèvement VRAI `capVrai`, à `r` pixels du centre.
// La carte étant nord-vrai et non tournée, l'écran EST le repère des relèvements.
function _compasPt(capVrai, r) {
  const a = capVrai * Math.PI / 180;
  return [COMPAS_C + r * Math.sin(a), COMPAS_C - r * Math.cos(a)];
}

// Portage de atools::calculateSteps : pas « rond » (1, 2 ou 5 × 10ⁿ) donnant
// environ `nbPas` intervalles sur `valeur`. C'est lui qui espace les cercles
// de distance, LNM les voulant au nombre de 6,5 sur le rayon.
function _compasPas(valeur, nbPas) {
  if (!(valeur > 0) || !(nbPas > 0)) return 0;
  const brut = valeur / nbPas;
  const mag = Math.pow(10, Math.floor(Math.log10(brut)));
  const msd = Math.round(brut / mag);
  const m = msd > 5 ? 10 : msd > 2 ? 5 : msd > 1 ? 2 : 1;
  return m * mag;
}

// Échelle locale : combien de NM vaut un pixel autour du centre de la rose.
// Mesurée sur la carte plutôt que calculée depuis le zoom — elle vaut ainsi
// quel que soit le fond et sa projection.
function _compasNmParPx(lat, lon) {
  const p = map.latLngToContainerPoint([lat, lon]);
  const ll = map.containerPointToLatLng([p.x + 100, p.y]);
  return distanceNM(lat, lon, ll.lat, ll.lng) / 100;
}

// --- Libellés ----------------------------------------------------------------

// Mesure au gabarit demandé (canvas hors-écran), pour dimensionner le cartouche.
let _compasCtx = null;
function _compasLargeur(txt, font) {
  if (!_compasCtx) _compasCtx = document.createElement('canvas').getContext('2d');
  _compasCtx.font = font;
  return _compasCtx.measureText(txt).width;
}

// Libellé centré sur (x, y), posé sur un cartouche blanc translucide — c'est le
// textBox de LNM, sans lequel du texte noir se perdrait sur un fond satellite.
function _compasEtiquette(x, y, lignes, px, gras) {
  const font = `${gras ? 'bold ' : ''}${px}px 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`;
  const w = lignes.reduce((m, l) => Math.max(m, _compasLargeur(l, font)), 0);
  const hl = px * 1.15;
  const h = hl * lignes.length;
  const out = [
    `<rect x="${(x - w / 2 - 3).toFixed(1)}" y="${(y - h / 2 - 1).toFixed(1)}"`,
    ` width="${(w + 6).toFixed(1)}" height="${(h + 2).toFixed(1)}" rx="2" fill="${COMPAS_FOND}"/>`,
  ].join('');
  const textes = lignes.map((l, i) => {
    const ty = y - h / 2 + hl * (i + 0.5);
    return `<text x="${x.toFixed(1)}" y="${ty.toFixed(1)}" fill="${COMPAS_TEXTE}" font-family="'Segoe UI', Tahoma, Geneva, Verdana, sans-serif"`
      + ` font-size="${px}"${gras ? ' font-weight="bold"' : ''} text-anchor="middle" dominant-baseline="central">${escapeHtml(l)}</text>`;
  }).join('');
  return out + textes;
}

// --- Angle de crabe ----------------------------------------------------------

// Cap vrai à tenir pour suivre `capVrai` par le vent du simulateur — le
// windCorrectedHeading de LNM. Clear Sky VFR prend la vitesse propre dans la case
// du plan ; ici elle vient de la trame elle-même (AIRSPEED TRUE), lue à côté du
// vent : les deux valeurs sont donc du même instant, et rien n'est à saisir.
// Au sol ou moteur au ralenti la Vp tombe à zéro : pas de crabe à montrer.
function _compasCrabe(capVrai, f) {
  const vp = Number.isFinite(f.tasKt) && f.tasKt > 0 ? f.tasKt : null;
  if (!vp) return null;
  const w = Number.isFinite(f.windKt) ? f.windKt : 0;
  if (!(w > 0) || !Number.isFinite(f.windDir)) return _compasNorm360(capVrai);   // air calme
  const beta = (f.windDir - capVrai) * Math.PI / 180;
  const sinDerive = (w / vp) * Math.sin(beta);
  if (Math.abs(sinDerive) > 1) return null;   // travers plus fort que la Vp
  return _compasNorm360(capVrai + Math.asin(sinDerive) * 180 / Math.PI);
}

// --- Déclinaison hors simulateur ---------------------------------------------

// Rose posée au centre de la carte (pas de simulateur) : la déclinaison vient du
// WMM par IPC. Mémorisée dans le cache de position du socle, partagé avec la
// route. L'appel étant asynchrone et le tracé synchrone, on rend d'abord avec le
// repli, puis on redessine à l'arrivée de la valeur.
let _compasDeclEnCours = false;
function _compasDeclCentre(lat, lon) {
  const cle = _cleDecl(lat, lon);
  const v = _declCache.get(cle);
  if (Number.isFinite(v)) return v;
  if (!_compasDeclEnCours) {
    _compasDeclEnCours = true;
    Promise.resolve(window.bc.declinaison(lat, wrapLon(lon)))
      .then((res) => {
        if (res && res.ok && Number.isFinite(res.decl)) {
          _declCache.set(cle, res.decl);
          dessinerCompas();
        }
      })
      .catch(() => { /* repli conservé */ })
      .finally(() => { _compasDeclEnCours = false; });
  }
  return _routeDeclinaison;
}

// --- Tracé -------------------------------------------------------------------

function _compasSvg(decl, f, nmParPx) {
  const R = COMPAS_RAYON_PX;
  const avion = !!f;
  const s = [];
  const ligne = (x1, y1, x2, y2, ep, extra) =>
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"`
    + ` stroke="${COMPAS_TRAIT}" stroke-width="${ep}" stroke-linecap="round"${extra || ''}/>`;

  // Cercle extérieur, et petite pastille centrale quand la rose n'est pas
  // accrochée à l'avion (LNM : ellipse de 5 px au centre de la vue).
  s.push(`<circle cx="${COMPAS_C}" cy="${COMPAS_C}" r="${R}" fill="none" stroke="${COMPAS_TRAIT}" stroke-width="${COMPAS_EP}"/>`);
  if (!avion) {
    s.push(`<circle cx="${COMPAS_C}" cy="${COMPAS_C}" r="5" fill="none" stroke="${COMPAS_TRAIT}" stroke-width="${COMPAS_EP}"/>`);
  }

  // Cercles de distance : pas rond visant 6,5 cercles sur le rayon. Ils sont les
  // seuls éléments métriques de la rose — leur nombre change donc au zoom.
  const rayonNm = R * nmParPx;
  const pasNm = _compasPas(rayonNm, 6.5);
  if (pasNm > 0) {
    for (let i = 1; i * pasNm < rayonNm; i++) {
      const r = (i * pasNm) / nmParPx;
      s.push(`<circle cx="${COMPAS_C}" cy="${COMPAS_C}" r="${r.toFixed(1)}" fill="none" stroke="${COMPAS_TRAIT}" stroke-width="${COMPAS_EP_FIN}"/>`);
    }
  }

  // Graduations, tous les 5° de la rose MAGNÉTIQUE : longueur croissante à 10,
  // 45 et 90°. Chacune est posée au relèvement vrai `angle + decl`, ce qui fait
  // pivoter la couronne entière de la déclinaison.
  for (let i = 0; i < 72; i++) {
    const capVrai = 5 * i + decl;
    const f0 = (i % 18 === 0) ? 0.80 : (i % 9 === 0) ? 0.84 : (i % 2 === 0) ? 0.92 : 0.95;
    const [x1, y1] = _compasPt(capVrai, R * f0);
    const [x2, y2] = _compasPt(capVrai, R);
    s.push(ligne(x1, y1, x2, y2, COMPAS_EP));
  }

  // Repère du NORD VRAI : triangle blanc posé à l'extérieur de la couronne, au
  // relèvement 0 non corrigé. La carte étant nord-vrai il est toujours à midi ;
  // l'écart entre lui et le 360 de la graduation SE LIT comme la déclinaison.
  const [nx, ny] = _compasPt(0, R);
  s.push(`<polygon points="${nx.toFixed(1)},${ny.toFixed(1)} ${(nx - 10).toFixed(1)},${(ny - 20).toFixed(1)} ${(nx + 10).toFixed(1)},${(ny - 20).toFixed(1)}"`
    + ` fill="#ffffff" stroke="${COMPAS_TRAIT}" stroke-width="${COMPAS_EP}"/>`);

  // Route (trait plein) et cap (pointillés) : tous deux en VRAI, puisqu'ils sont
  // tracés sur la carte et non lus sur la couronne.
  const trackTrue = (avion && Number.isFinite(f.trackTrue)) ? f.trackTrue : 0;
  if (avion) {
    if (Number.isFinite(f.trackTrue)) {
      const [tx, ty] = _compasPt(f.trackTrue, R);
      s.push(ligne(COMPAS_C, COMPAS_C, tx, ty, COMPAS_EP));
    }
    if (Number.isFinite(f.headingTrue)) {
      const [hx, hy] = _compasPt(f.headingTrue, R);
      s.push(ligne(COMPAS_C, COMPAS_C, hx, hy, COMPAS_EP, ' stroke-dasharray="0.5 6"'));
    }
  }

  // Trait vers le point tournant suivant et pastille d'angle de crabe : au vol
  // seulement, et seulement si un plan est en place (LNM : leg actif valide).
  if (avion && !f.onGround) {
    const idx = legActifClamp();
    const pts = (_routeDep && _routeArr) ? [_routeDep, ...routeWaypoints, _routeArr] : null;
    const cible = (pts && idx >= 0) ? pts[idx + 1] : null;
    if (cible) {
      const capWpt = capVraiInitial(f.lat, f.lon, cible.lat, cible.lon);
      const [ax, ay] = _compasPt(capWpt, R * 0.92);
      const [bx, by] = _compasPt(capWpt, R);
      s.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#000000" stroke-width="7" stroke-linecap="round"/>`);
      s.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${LEG_COL_ACTIVE}" stroke-width="4" stroke-linecap="round"/>`);
      const crabe = _compasCrabe(capWpt, f);
      if (crabe !== null) {
        const [cx, cy] = _compasPt(crabe, R);
        s.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${COMPAS_EP * 3}" fill="${LEG_COL_ACTIVE}" stroke="${COMPAS_TRAIT}" stroke-width="${COMPAS_EP}"/>`);
      }
    }
  }

  // Libellés cardinaux, lus sur la couronne : ils marquent donc le nord, l'est,
  // le sud et l'ouest MAGNÉTIQUES.
  const card = { 0: 'N', 18: 'E', 36: 'S', 54: 'W' };
  for (const i of [0, 18, 36, 54]) {
    const [x, y] = _compasPt(5 * i + decl, R);
    s.push(_compasEtiquette(x, y, [card[i]], 15, true));
  }

  // Libellés de degré tous les 15°, hors quadrants (déjà pris par les cardinaux).
  for (let i = 0; i < 72; i += 3) {
    if (i % 18 === 0) continue;
    const [x, y] = _compasPt(5 * i + decl, R);
    s.push(_compasEtiquette(x, y, [String(i * 5)], 10, false));
  }

  // Distances, portées le long de la ligne de route (relèvement 0 sans avion).
  if (pasNm > 0) {
    for (let i = 1; i * pasNm < rayonNm; i++) {
      const [x, y] = _compasPt(trackTrue, (i * pasNm) / nmParPx);
      s.push(_compasEtiquette(x, y, [`${formatDistNM(i * pasNm)} NM`], 10, false));
    }
  }

  // Étiquette de route en bout de trait, en MAGNÉTIQUE — la seule valeur chiffrée
  // de la rose, et donc la seule à convertir.
  if (avion && Number.isFinite(f.trackTrue)) {
    const [x, y] = _compasPt(f.trackTrue, R * 1.1);
    s.push(_compasEtiquette(x, y, [`${_compasDeg3(f.trackTrue - decl)}°M`, 'TRK'], 12, false));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COMPAS_TAILLE}" height="${COMPAS_TAILLE}"`
    + ` viewBox="0 0 ${COMPAS_TAILLE} ${COMPAS_TAILLE}">${s.join('')}</svg>`;
}

// Marqueur porteur, créé une seule fois. Son contenu est réécrit à chaque trame
// plutôt que l'icône reconstruite : Leaflet recréerait sinon le nœud, et avec lui
// le clignotement.
function _compasMarqueur() {
  if (_compasMarker) return _compasMarker;
  if (!map.getPane('compasPane')) {
    // Sous l'avion (markerPane, 600), au-dessus de la route (overlayPane, 400).
    map.createPane('compasPane').style.zIndex = 550;
  }
  _compasMarker = L.marker([0, 0], {
    pane: 'compasPane',
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: 'compas-rose',
      html: '',
      iconSize: [COMPAS_TAILLE, COMPAS_TAILLE],
      iconAnchor: [COMPAS_C, COMPAS_C],
    }),
  }).addTo(map);
  return _compasMarker;
}

function _compasEffacer() {
  if (_compasMarker) { map.removeLayer(_compasMarker); _compasMarker = null; }
}

// Rendu complet. Centre : l'avion tant que le simulateur envoie des trames,
// le centre de la carte sinon (COMPASS_ROSE_ATTACH de LNM).
function dessinerCompas() {
  if (!map) return;
  if (!_compasActif) { _compasEffacer(); return; }

  const f = (derniereTrame && Number.isFinite(derniereTrame.lat) && Number.isFinite(derniereTrame.lon))
    ? derniereTrame : null;
  const centre = f ? { lat: f.lat, lon: f.lon } : (() => {
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  })();

  // Déclinaison : celle du simulateur quand il est là (les deux caps de la MÊME
  // trame), le WMM sinon. decl > 0 = Est, donc cap vrai − cap magnétique.
  let decl;
  if (f && Number.isFinite(f.headingTrue) && Number.isFinite(f.headingMag)) {
    const d = _compasNorm360(f.headingTrue - f.headingMag);
    decl = d > 180 ? d - 360 : d;
  } else {
    decl = _compasDeclCentre(centre.lat, centre.lon);
  }

  const nmParPx = _compasNmParPx(centre.lat, centre.lon);
  if (!(nmParPx > 0)) { _compasEffacer(); return; }

  const m = _compasMarqueur();
  m.setLatLng([centre.lat, centre.lon]);
  const el = m.getElement();
  if (el) el.innerHTML = _compasSvg(decl, f, nmParPx);
}

// Appelée à chaque trame du simulateur (majScan) et à la perte du flux
// (viderScan). Ne coûte rien tant que la rose n'est pas affichée.
function majCompas() {
  if (_compasActif) dessinerCompas();
}

// --- Bouton et branchements --------------------------------------------------

function afficherCompas(on) {
  _compasActif = !!on;
  localStorage.setItem('bc-compas', _compasActif ? '1' : '0');
  const btn = $('btn-compas');
  if (btn) {
    btn.classList.toggle('is-active', _compasActif);
    btn.setAttribute('aria-pressed', String(_compasActif));
  }
  dessinerCompas();
}

function initCompas() {
  if (!map) return;
  // Le pas des cercles de distance dépend du zoom : rendu complet à l'arrivée.
  map.on('zoomend', dessinerCompas);
  // Sans avion, la rose tient le centre de la carte : elle doit suivre le
  // glissement. Repositionnement seul pendant le geste, tracé complet à la fin.
  map.on('move', () => {
    if (_compasActif && !derniereTrame && _compasMarker) {
      _compasMarker.setLatLng(map.getCenter());
    }
  });
  map.on('moveend', () => { if (_compasActif && !derniereTrame) dessinerCompas(); });
  afficherCompas(_compasActif);   // restaure l'état persisté
}

$('btn-compas').addEventListener('click', () => afficherCompas(!_compasActif));

// La carte est déjà en place : renderer.js appelle initMap() avant que ce
// fichier ne soit chargé.
initCompas();
