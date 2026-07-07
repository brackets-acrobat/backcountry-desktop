/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// renderer.js — UI du jalon 1 : connexion + affichage du scan live.
// Communique avec le main via window.bc (exposé par preload.js).
// Bilingue : utilise t() / setLanguage() de i18n.js (chargé avant).
// ============================================================

const $ = (id) => document.getElementById(id);

let connecte = false;
let lastStatusState = 'disconnected';   // dernier état connu (pour re-rendu à la bascule de langue)
let lastStatusDetail = '';
let lastConfig = null;                   // dernière config API (pour re-rendu de l'indice)

// (Re)dessine le bouton de connexion : sa COULEUR porte l'état (rouge/orange/
// vert), son libellé et son infobulle de détail sont dans la langue courante.
function renderStatus() {
  const btn = $('btn-connect');
  btn.classList.remove('btn-state-off', 'btn-state-wait', 'btn-state-on');
  const detail = lastStatusDetail ? ` · ${lastStatusDetail}` : '';

  if (lastStatusState === 'connected') {
    btn.classList.add('btn-state-on');
    btn.innerHTML = '<i class="ph-light ph-plugs-connected"></i> ' + t('btnDisconnect');
    btn.title = t('statusConnected') + detail;
    connecte = true;
  } else if (lastStatusState === 'connecting') {
    btn.classList.add('btn-state-wait');
    btn.innerHTML = '<i class="ph-light ph-plugs"></i> ' + t('statusConnecting');
    btn.title = t('statusConnecting');
  } else {
    btn.classList.add('btn-state-off');
    btn.innerHTML = '<i class="ph-light ph-plugs"></i> ' + t('btnConnect');
    btn.title = t('statusDisconnected') + detail;
    connecte = false;
    viderScan();
    setCaptureEnabled(false);   // plus de flux → bouton capture désactivé
  }
}

function setStatus(state, detail) {
  lastStatusState = state;
  lastStatusDetail = detail || '';
  renderStatus();
}

// (Re)dessine l'indice de configuration API dans la langue courante.
function renderApiHint() {
  if (!lastConfig) return;
  const key = lastConfig.cleConfiguree ? 'apiConfigured' : 'apiMissing';
  $('api-hint').textContent = t(key).replace('{url}', lastConfig.apiBaseUrl);
}

function fmt(n, dec = 0) {
  return (typeof n === 'number' && isFinite(n)) ? n.toFixed(dec) : '—';
}

// --- Carte (fond OpenTopoMap) ---
let map = null;
let planeMarker = null;
let planeTrack = null;    // tracé (polyline) accumulant les positions de l'avion
// Mode « suivi de l'avion » (bouton). Quand actif, l'avion reste au centre ;
// si l'utilisateur déplace la carte, on la laisse et on recentre 5 s plus tard.
let suiviActif = localStorage.getItem('bc-follow') === '1';
let suiviPause = false;      // déplacement utilisateur en cours → centrage suspendu
let _suiviTimer = null;      // minuteur de recentrage (5 s après déplacement)
let suiviBtnEl = null;       // bouton (pour l'état visuel actif)
const SUIVI_RECENTRE_MS = 5000;
let rotationAvion = 0;    // rotation CUMULÉE appliquée à l'icône (degrés, non bornée)
let capPrecedent = null;  // dernier cap brut reçu (pour calculer le plus court delta)

// Fond de carte (OpenTopoMap par défaut)
let baseLayer = null;
const BASE_LAYERS = {
  opentopomap: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', options: { maxZoom: 17, attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap' } },
  openstreetmap: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', options: { maxZoom: 19, attribution: '© OpenStreetMap' } },
  // Fond satellite identique à NavXpressVFR (Esri World Imagery).
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', options: { maxZoom: 19, attribution: 'Tiles &copy; Esri' } },
};

// Couches de données MSFS (aéroports / héliports / hydrobases / navaids)
// + lieux de poser des utilisateurs (depuis la base du site).
let airportsLayer = null, heliportsLayer = null, seaplanesLayer = null, navaidsLayer = null;
let lieuxLayer = null;
let _couchesTimer = null, _airReqId = 0, _navReqId = 0;
const ZOOM_MIN_COUCHES = 8;
const TAILLES_AEROPORT = { large_airport: 9, medium_airport: 7, small_airport: 5, heliport: 6, seaplane_base: 6 };
// États des couches, persistés (off par défaut → on les fait apparaître via le menu)
const layerState = {
  airports:  localStorage.getItem('bc-layer-airports')  === '1',
  heliports: localStorage.getItem('bc-layer-heliports') === '1',
  seaplanes: localStorage.getItem('bc-layer-seaplanes') === '1',
  navaids:   localStorage.getItem('bc-layer-navaids')   === '1',
  lieux:     localStorage.getItem('bc-layer-lieux')     === '1',
};

// Icône avion (vue de dessus, pointe vers le nord à 0°). Une <img> dans un
// divIcon : on la fait pivoter en CSS selon le cap (la rotation du marqueur
// lui-même entrerait en conflit avec le translate de positionnement de Leaflet).
const planeIcon = L.divIcon({
  className: 'plane-marker',
  html: '<img src="../img/icone40x40.png" alt="">',
  iconSize: [40, 40],
  iconAnchor: [20, 20],   // centre de l'image sur la position
});

// Barre d'échelle à trois unités (km, miles, NM). Leaflet ne fournit que le
// métrique et l'impérial : on étend L.Control.Scale pour ajouter une ligne NM
// (1 NM = 1852 m). Indépendante du fond : valable sur satellite, CARTO, OSM, topo.
const ScaleTriple = L.Control.Scale.extend({
  options: { metric: true, imperial: true, nautical: true },
  _addScales(options, className, container) {
    L.Control.Scale.prototype._addScales.call(this, options, className, container);
    if (options.nautical) { this._nScale = L.DomUtil.create('div', className, container); }
  },
  _updateScales(maxMeters) {
    L.Control.Scale.prototype._updateScales.call(this, maxMeters);
    if (this.options.nautical && maxMeters) { this._updateNautical(maxMeters); }
  },
  _updateNautical(maxMeters) {
    const maxNm = maxMeters / 1852;
    if (maxNm < 1) { this._updateScale(this._nScale, '', 0); return; }  // trop zoomé : pas de NM
    const nm = this._getRoundNum(maxNm);
    this._updateScale(this._nScale, nm + ' NM', nm / maxNm);
  },
});

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([46.8, 2.5], 5);  // vue par défaut (France)
  appliquerFond(localStorage.getItem('bc-basemap') || 'opentopomap');  // OpenTopoMap par défaut
  new ScaleTriple({ position: 'bottomleft', maxWidth: 120 }).addTo(map);  // échelle km / mi / NM
  // Suivi : pendant un déplacement utilisateur, on suspend le centrage ; 5 s
  // après la fin du déplacement, on recentre sur l'avion. En mode libre, rien.
  map.on('dragstart', () => {
    if (!suiviActif) return;
    suiviPause = true;
    if (_suiviTimer) { clearTimeout(_suiviTimer); _suiviTimer = null; }
  });
  map.on('dragend', () => {
    if (!suiviActif) return;
    if (_suiviTimer) clearTimeout(_suiviTimer);
    _suiviTimer = setTimeout(() => { suiviPause = false; recentrerAvion(); }, SUIVI_RECENTRE_MS);
  });

  // Couches de données + contrôles déroulants (haut-droite)
  airportsLayer  = L.layerGroup().addTo(map);
  heliportsLayer = L.layerGroup().addTo(map);
  seaplanesLayer = L.layerGroup().addTo(map);
  navaidsLayer   = L.layerGroup().addTo(map);
  lieuxLayer     = L.layerGroup().addTo(map);
  _rangeLayer    = L.layerGroup().addTo(map);   // cercles de portée (magenta)
  routeLayer     = L.layerGroup().addTo(map);   // ligne de route départ → arrivée
  ajouterBoutonSuivi();
  ajouterControlesCarte();
  map.on('moveend', planifierRafraichirCouches);
  map.on('zoomend', planifierRafraichirCouches);
  // Clic droit sur le fond de carte (hors marqueur) → départ (ZZZY) / arrivée (ZZZZ).
  map.on('contextmenu', ouvrirMenuFondCarte);
  map.on('movestart zoomstart', fermerMenuContextuel);
  // Au zoom, on ré-évalue l'affichage des étiquettes de leg (seuil de longueur).
  map.on('zoomend', () => dessinerRoute());
  rafraichirCouches();
  rafraichirLieux();   // lieux : liste globale, chargée une fois (indépendante du zoom/bbox)
}

// Applique (et persiste) le fond de carte. Le tileLayer va dans le tilePane,
// donc toujours SOUS les marqueurs.
function appliquerFond(key) {
  const def = BASE_LAYERS[key] || BASE_LAYERS.opentopomap;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(def.url, def.options).addTo(map);
  baseLayer.bringToBack();
  localStorage.setItem('bc-basemap', BASE_LAYERS[key] ? key : 'opentopomap');
}

// Recentre la carte sur l'avion (zoom inchangé).
function recentrerAvion() {
  if (map && planeMarker) map.panTo(planeMarker.getLatLng());
}

// Active/désactive le suivi (persisté). À l'activation, recentre tout de suite.
function setSuivi(on) {
  suiviActif = on;
  localStorage.setItem('bc-follow', on ? '1' : '0');
  suiviPause = false;
  if (_suiviTimer) { clearTimeout(_suiviTimer); _suiviTimer = null; }
  if (suiviBtnEl) suiviBtnEl.classList.toggle('active', on);
  if (on) recentrerAvion();
}

// Bouton de suivi de l'avion (haut-gauche, sous le contrôle de zoom).
function ajouterBoutonSuivi() {
  const ctl = L.control({ position: 'topleft' });
  ctl.onAdd = function () {
    const div = L.DomUtil.create('div', 'map-follow');
    div.innerHTML = `<button class="map-follow-btn" type="button" data-i18n-title="followTitle" title="${t('followTitle')}"><i class="ph-light ph-crosshair"></i></button>`;
    L.DomEvent.disableClickPropagation(div);
    suiviBtnEl = div.querySelector('.map-follow-btn');
    suiviBtnEl.classList.toggle('active', suiviActif);
    suiviBtnEl.addEventListener('click', () => setSuivi(!suiviActif));
    return div;
  };
  ctl.addTo(map);
}

// ============================================================
// Couches MSFS : aéroports / héliports / hydrobases / navaids.
// Icônes et code couleur REPRIS À L'IDENTIQUE de NavXpressVFR.
// ============================================================
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Décale une longitude [-180,180] vers la copie du monde visible (scroll infini).
function lonVersVue(lon, west) { return west + ((((lon - west) % 360) + 360) % 360); }

// Couleur du marqueur aéroport selon la surface de la piste principale (NavXpress).
function surfaceMarkerColors(surface) {
  const s = String(surface || '').toLowerCase();
  if (/grass/.test(s)) return { fill: '#00d700', stroke: '#0a5e0a', line: '#0a5e0a' };
  if (/dirt|gravel|sand|shale|coral|turf|earth|mud/.test(s)) return { fill: '#c07a00', stroke: '#5e3c00', line: '#5e3c00' };
  if (/water/.test(s)) return { fill: '#2970ff', stroke: '#0a2a66', line: '#0d4d6e' };
  if (/snow|ice/.test(s)) return { fill: '#33fff3', stroke: '#0a5e58', line: '#0a5e58' };
  if (/unknown/.test(s)) return { fill: '#9aa0a8', stroke: '#4b4f55', line: '#4b4f55' };
  return { fill: '#fff', stroke: '#000', line: '#000' };
}

function makeAirportIcon(airport) {
  if (airport.type === 'heliport') {
    const rh = TAILLES_AEROPORT.heliport, sizeH = rh * 2 + 12, fs = Math.round(rh * 1.7);
    const svgH = `<svg viewBox="-${sizeH / 2} -${sizeH / 2} ${sizeH} ${sizeH}" width="${sizeH}" height="${sizeH}" style="overflow:visible;">`
      + `<circle cx="0" cy="0" r="${rh}" fill="#fff" stroke="#000" stroke-width="1.6"/>`
      + `<text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#000">H</text></svg>`;
    return L.divIcon({ className: 'airport-marker', html: svgH, iconSize: [sizeH, sizeH], iconAnchor: [sizeH / 2, sizeH / 2] });
  }
  if (airport.type === 'seaplane_base') {
    const rs = TAILLES_AEROPORT.seaplane_base, sizeS = rs * 2 + 12, extS = rs + 4;
    const headingS = airport.runway ? airport.runway.headingDegT : 0, hasRwyS = !!airport.runway;
    const svgS = `<svg viewBox="-${sizeS / 2} -${sizeS / 2} ${sizeS} ${sizeS}" width="${sizeS}" height="${sizeS}" style="overflow:visible;">`
      + (hasRwyS ? `<line x1="-${extS}" y1="0" x2="${extS}" y2="0" stroke="#0d4d6e" stroke-width="2.2" stroke-linecap="round" transform="rotate(${headingS - 90})"/>` : '')
      + `<circle cx="0" cy="0" r="${rs}" fill="#2970ff" stroke="#0a2a66" stroke-width="1.6"/></svg>`;
    return L.divIcon({ className: 'airport-marker', html: svgS, iconSize: [sizeS, sizeS], iconAnchor: [sizeS / 2, sizeS / 2] });
  }
  const r = TAILLES_AEROPORT[airport.type] || 5, size = r * 2 + 12;
  const heading = airport.runway ? airport.runway.headingDegT : 0, hasRunway = !!airport.runway;
  const lineExtent = r + 4, rotation = heading - 90;
  const sc = surfaceMarkerColors(airport.runway && airport.runway.surface);
  const svg = `<svg viewBox="-${size / 2} -${size / 2} ${size} ${size}" width="${size}" height="${size}" style="overflow:visible;">`
    + (hasRunway ? `<line x1="-${lineExtent}" y1="0" x2="${lineExtent}" y2="0" stroke="${sc.line}" stroke-width="2.2" stroke-linecap="round" transform="rotate(${rotation})"/>` : '')
    + `<circle cx="0" cy="0" r="${r}" fill="${sc.fill}" stroke="${sc.stroke}" stroke-width="1.6"/></svg>`;
  return L.divIcon({ className: 'airport-marker', html: svg, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function makeAirportTooltipHtml(a) {
  const fr = currentLang === 'fr';
  const code = a.code || a.ident || '';
  const lignes = [];
  if (Number.isFinite(a.elevation_ft)) {
    lignes.push(`<div class="ap-tt-rwy">${fr ? 'Altitude' : 'Elevation'} : ${a.elevation_ft} ft</div>`);
  }
  if (a.runway) {
    const r = a.runway;
    // Numéros de piste (le_ident/he_ident, ex. « 08/26 »).
    lignes.push(`<div class="ap-tt-rwy">${fr ? 'Piste' : 'Runway'} ${escapeHtml(r.name)}</div>`);
    if (Number.isFinite(r.length_ft)) {
      const ft = Math.round(r.length_ft);
      const m = Math.round(ft * 0.3048);
      lignes.push(`<div class="ap-tt-rwy">${fr ? 'Longueur' : 'Length'} : ${ft} ft / ${m} m</div>`);
    }
    if (r.surface) {
      lignes.push(`<div class="ap-tt-rwy">${fr ? 'Surface' : 'Surface'} : ${escapeHtml(r.surface)}</div>`);
    }
  }
  return `<div class="ap-tt-icao">${escapeHtml(code)}</div><div class="ap-tt-name">${escapeHtml(a.name)}</div>${lignes.join('')}`;
}

function formatNavaidFreq(type, freqKhz) {
  if (!freqKhz || !Number.isFinite(freqKhz) || freqKhz <= 0) return '—';
  if (type === 'NDB' || type === 'NDB-DME') return Math.round(freqKhz) + ' kHz';
  return (freqKhz / 1000).toFixed(2) + ' MHz';
}

function makeNavaidIcon(navaid) {
  const C = '#1565c0', size = 22, sw = 1.6;
  const hexPts = '-7,4 -7,-4 0,-8 7,-4 7,4 0,8';
  const hexInsidePts = '-5,2.9 -5,-2.9 0,-5.8 5,-2.9 5,2.9 0,5.8';
  let inner = '';
  switch (navaid.type) {
    case 'VOR':
      inner = `<polygon points="${hexPts}" fill="#fff" stroke="${C}" stroke-width="${sw}"/><circle cx="0" cy="0" r="1.6" fill="${C}"/>`; break;
    case 'VOR-DME':
      inner = `<rect x="-9" y="-9" width="18" height="18" fill="#fff" stroke="${C}" stroke-width="${sw}"/><polygon points="${hexInsidePts}" fill="#fff" stroke="${C}" stroke-width="1.3"/><circle cx="0" cy="0" r="1.4" fill="${C}"/>`; break;
    case 'VORTAC':
      inner = `<rect x="-2.6" y="-11" width="5.2" height="3" fill="${C}"/><rect x="-2.6" y="-1.5" width="5.2" height="3" fill="${C}" transform="rotate(120 0 0) translate(0 9.5)"/><rect x="-2.6" y="-1.5" width="5.2" height="3" fill="${C}" transform="rotate(-120 0 0) translate(0 9.5)"/><polygon points="${hexPts}" fill="#fff" stroke="${C}" stroke-width="${sw}"/><circle cx="0" cy="0" r="1.6" fill="${C}"/>`; break;
    case 'TACAN':
      inner = `<polygon points="0,-8 7,5 -7,5" fill="#fff" stroke="${C}" stroke-width="${sw}"/><circle cx="0" cy="1" r="1.4" fill="${C}"/>`; break;
    case 'NDB':
      inner = `<circle cx="0" cy="0" r="7" fill="#fff" stroke="${C}" stroke-width="1.5" stroke-dasharray="1.8 1.8"/><circle cx="0" cy="0" r="1.8" fill="${C}"/>`; break;
    case 'NDB-DME':
      inner = `<rect x="-9" y="-9" width="18" height="18" fill="#fff" stroke="${C}" stroke-width="${sw}"/><circle cx="0" cy="0" r="5.5" fill="#fff" stroke="${C}" stroke-width="1.4" stroke-dasharray="1.6 1.6"/><circle cx="0" cy="0" r="1.6" fill="${C}"/>`; break;
    default: // DME
      inner = `<rect x="-7" y="-7" width="14" height="14" fill="#fff" stroke="${C}" stroke-width="${sw}"/><text x="0" y="3.5" text-anchor="middle" fill="${C}" font-size="8" font-weight="bold" font-family="Arial, sans-serif">D</text>`; break;
  }
  const svg = `<svg viewBox="-12 -12 24 24" width="${size}" height="${size}" style="overflow:visible;">${inner}</svg>`;
  return L.divIcon({ className: 'navaid-marker', html: svg, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function makeNavaidTooltipHtml(n) {
  const freq = formatNavaidFreq(n.type, n.freqKhz);
  const range = Number.isFinite(n.rangeNm) ? `<div class="nv-tt-range">${n.rangeNm} NM</div>` : '';
  return `<div class="nv-tt-ident">${escapeHtml(n.ident)}</div><div class="nv-tt-type">${escapeHtml(n.type)}</div><div class="nv-tt-freq">${freq}</div>${range}`;
}

function planifierRafraichirCouches() {
  if (_couchesTimer) clearTimeout(_couchesTimer);
  _couchesTimer = setTimeout(rafraichirCouches, 200);
}

function rafraichirCouches() {
  rafraichirAeroports();
  rafraichirNavaids();
}

async function rafraichirAeroports() {
  if (!map) return;
  if (!layerState.airports && !layerState.heliports && !layerState.seaplanes) {
    airportsLayer.clearLayers(); heliportsLayer.clearLayers(); seaplanesLayer.clearLayers(); return;
  }
  if (map.getZoom() < ZOOM_MIN_COUCHES) {
    airportsLayer.clearLayers(); heliportsLayer.clearLayers(); seaplanesLayer.clearLayers(); return;
  }
  const b = map.getBounds();
  const bbox = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  const reqId = ++_airReqId;
  let res;
  try { res = await window.bc.aeroportsDansBbox(bbox); } catch (_) { return; }
  if (reqId !== _airReqId) return;
  airportsLayer.clearLayers(); heliportsLayer.clearLayers(); seaplanesLayer.clearLayers();
  if (!res || !res.ok) return;
  for (const a of res.airports) {
    const isHeli = a.type === 'heliport', isSea = a.type === 'seaplane_base';
    const enabled = isHeli ? layerState.heliports : isSea ? layerState.seaplanes : layerState.airports;
    if (!enabled) continue;
    const marker = L.marker([a.lat, lonVersVue(a.lon, bbox.west)], { icon: makeAirportIcon(a), interactive: true, keyboard: false });
    marker.bindTooltip(makeAirportTooltipHtml(a), { direction: 'top', offset: [0, -8], className: 'airport-tooltip', opacity: 1 });
    marker.on('contextmenu', (ev) => ouvrirMenuAeroport(a, ev));   // clic droit → départ/arrivée
    // Clic gauche sur un aéroport qui EST un point tournant (aimanté) → le déplacer
    // comme les autres (l'icône d'aéroport recouvre sinon le marqueur du point).
    marker.on('mousedown', (ev) => {
      if (ev.originalEvent && ev.originalEvent.button !== 0) return;
      const code = (a.code || a.ident || '').toUpperCase();
      const k = routeWaypoints.findIndex((w) => (w.code || '').toUpperCase() === code);
      if (k < 0) return;   // pas un point tournant → comportement normal
      L.DomEvent.stopPropagation(ev);
      L.DomEvent.preventDefault(ev);
      demarrerDeplacementPoint(k);
    });
    marker.addTo(isHeli ? heliportsLayer : isSea ? seaplanesLayer : airportsLayer);
  }
}

async function rafraichirNavaids() {
  if (!map) return;
  if (!layerState.navaids) { navaidsLayer.clearLayers(); return; }
  if (map.getZoom() < ZOOM_MIN_COUCHES) { navaidsLayer.clearLayers(); return; }
  const b = map.getBounds();
  const bbox = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  const reqId = ++_navReqId;
  let res;
  try { res = await window.bc.navaidsDansBbox(bbox); } catch (_) { return; }
  if (reqId !== _navReqId) return;
  navaidsLayer.clearLayers();
  if (!res || !res.ok) return;
  for (const n of res.navaids) {
    const marker = L.marker([n.lat, lonVersVue(n.lon, bbox.west)], { icon: makeNavaidIcon(n), interactive: true, keyboard: false });
    marker.bindTooltip(makeNavaidTooltipHtml(n), { direction: 'top', offset: [0, -8], className: 'navaid-tooltip', opacity: 1 });
    marker.on('contextmenu', (e) => ouvrirMenuNavaid(e, n));   // arrivée ZZZZ + cercle de portée
    marker.addTo(navaidsLayer);
  }
}

// ============================================================
// Lieux de poser des utilisateurs (couche « Lieux de poser »).
// Liste GLOBALE (pas de bbox) : on la charge une fois et on la garde en cache
// pour la session. Visible à tous les zooms (≠ aéroports/navaids). Code couleur
// et popup repris du site (public/assets/js/carte.js) pour la cohérence visuelle.
// ============================================================
let _lieuxData = null;        // cache des lieux (null = pas encore chargé)
let _lieuxChargement = false; // garde anti-requêtes concurrentes

// Couleur du marqueur selon la surface dominante (palette identique au site).
function couleurSurfaceLieu(surface) {
  const s = String(surface || '').toLowerCase();
  if (s.includes('grass')) return '#5fbf52';
  if (s.includes('dirt') || s.includes('sand')) return '#b07a3c';
  if (s.includes('water')) return '#3d8fd1';
  if (s.includes('snow') || s.includes('ice')) return '#7fd0e0';
  if (s.includes('concrete') || s.includes('asphalt')) return '#9aa0a6';
  return '#c9c9c9';
}

function popupLieuHtml(lieu) {
  const nom = lieu.nom ? escapeHtml(lieu.nom) : `${t('lieuUntitled')} #${lieu.id}`;
  const lignes = [];
  if (lieu.pays) lignes.push(`${t('lieuCountry')} : ${escapeHtml(lieu.pays)}`);
  if (lieu.surface) lignes.push(`${t('lieuSurface')} : ${escapeHtml(lieu.surface)}`);
  if (Number.isFinite(lieu.altitude_m)) {
    lignes.push(`${t('lieuAltitude')} : ${Math.round(lieu.altitude_m * 3.280839895)} ft`);
  }
  lignes.push(`${t('lieuSurveys')} : ${Number.isFinite(lieu.nb_releves) ? lieu.nb_releves : 0}`);
  if (Number.isFinite(lieu.note_moyenne)) {
    lignes.push(`${t('lieuRating')} : ${lieu.note_moyenne.toFixed(1)}/5 <i class="ph-fill ph-star"></i>`);
  }
  if (Number.isFinite(lieu.difficulte_moyenne)) {
    lignes.push(`${t('lieuDifficulty')} : ${lieu.difficulte_moyenne.toFixed(1)}/5`);
  }
  const base = (lastConfig && lastConfig.apiBaseUrl ? lastConfig.apiBaseUrl : '').replace(/\/+$/, '');
  const lien = base
    ? `<a class="lieu-popup-link" href="${base}/lieu/${lieu.id}" target="_blank" rel="noopener">${t('lieuDetail')} <i class="ph-bold ph-arrow-right"></i></a>`
    : '';
  return `<div class="lieu-popup"><strong>${nom}</strong>`
    + `<div class="lieu-popup-lines">${lignes.join('<br>')}</div>${lien}</div>`;
}

// Dessine les marqueurs des lieux depuis le cache (appelé après chargement et
// à chaque bascule de la couche).
function dessinerLieux() {
  if (!lieuxLayer) return;
  lieuxLayer.clearLayers();
  if (!layerState.lieux || !Array.isArray(_lieuxData)) return;
  for (const lieu of _lieuxData) {
    if (!Number.isFinite(lieu.lat) || !Number.isFinite(lieu.lon)) continue;
    const m = L.circleMarker([lieu.lat, lieu.lon], {
      radius: 5, color: '#000', weight: 1,
      fillColor: couleurSurfaceLieu(lieu.surface), fillOpacity: 0.9,
    });
    m.bindPopup(() => popupLieuHtml(lieu));   // contenu généré à l'ouverture (config/langue à jour)
    m.on('contextmenu', ouvrirMenuFondCarte);   // lieu de poser = ni aéroport ni navaid → départ/arrivée
    m.addTo(lieuxLayer);
  }
  // Les lieux et les points tournants sont dans le même pane SVG : on redessine
  // la route APRÈS pour qu'un point tournant posé sur un lieu reste au-dessus
  // (donc cliquable / déplaçable) plutôt que masqué par la pastille du lieu.
  if (routeLayer) dessinerRoute();
}

// (Re)charge et dessine les lieux. Le chargement réseau n'a lieu qu'une fois ;
// `forcer` invalide le cache (rechargement explicite). En cas d'échec réseau le
// cache reste vide → on retentera au prochain affichage de la couche.
async function rafraichirLieux(forcer = false) {
  if (!lieuxLayer) return;
  if (!layerState.lieux) { lieuxLayer.clearLayers(); return; }
  if (forcer) _lieuxData = null;
  if (_lieuxData === null && !_lieuxChargement) {
    _lieuxChargement = true;
    let res;
    try { res = await window.bc.lieux(); } catch (_) { res = null; }
    _lieuxChargement = false;
    if (!layerState.lieux) return;            // couche coupée pendant la requête
    if (res && res.ok) _lieuxData = res.lieux || [];
    else { lieuxLayer.clearLayers(); return; } // échec → on retentera plus tard
  }
  dessinerLieux();
}

// ============================================================
// Menu contextuel (clic droit sur la carte) + champs ICAO du bandeau.
//   • Aéroport / héliport / hydrobase → « Définir comme aéroport de départ /
//     d'arrivée » : inscrit l'ICAO de l'aéroport dans le champ correspondant.
//   • Ailleurs (fond de carte, navaid, lieu de poser) → « Définir comme lieu
//     d'arrivée » : inscrit le code ZZZZ dans le champ ICAO arrivée.
// Le menu est un simple <div> positionné au curseur, reconstruit à chaque
// ouverture (libellés dans la langue courante).
// ============================================================
let _ctxMenuEl = null;

// Réduit une chaîne à un ICAO valide : 6 caractères alphanumériques majuscules.
function nettoyerIcao(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

// Inscrit un code dans le champ ICAO départ ('dep') ou arrivée ('arr'),
// puis (re)trace la ligne de route.
function definirIcao(champ, code) {
  const el = $(champ === 'dep' ? 'icao-dep' : 'icao-arr');
  if (el) { el.value = nettoyerIcao(code); planifierLigneRoute(); majBoutonsPlan(); }
}

function fermerMenuContextuel() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
}

// Ouvre le menu au point (pageX, pageY) avec une liste d'items {label, action}.
function ouvrirMenuContextuel(pageX, pageY, items) {
  fermerMenuContextuel();
  if (!items || !items.length) return;
  const menu = document.createElement('div');
  menu.className = 'map-ctx-menu';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'map-ctx-item';
    b.textContent = it.label;
    b.addEventListener('click', () => { fermerMenuContextuel(); it.action(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  // Positionne au curseur, en rabattant le menu s'il déborde du viewport.
  menu.style.left = pageX + 'px';
  menu.style.top = pageY + 'px';
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(0, pageX - r.width) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(0, pageY - r.height) + 'px';
  _ctxMenuEl = menu;
}

// Coordonnées page (curseur) depuis un événement Leaflet.
function ctxPageXY(e) {
  const oe = e.originalEvent || e;
  return { x: oe.pageX || 0, y: oe.pageY || 0 };
}

// Menu pour un aéroport (ou héliport / hydrobase) : définir comme départ/arrivée.
// Si cet aéroport est aussi un point tournant (aimanté), propose sa suppression.
function ouvrirMenuAeroport(airport, e) {
  if (e.originalEvent) e.originalEvent.preventDefault();
  const code = nettoyerIcao(airport.code || airport.ident);
  const p = ctxPageXY(e);
  const items = [
    { label: t('ctxSetDep'), action: () => definirIcao('dep', code) },
    { label: t('ctxSetArr'), action: () => definirIcao('arr', code) },
  ];
  // Correspondance avec un point tournant aimanté : code brut (même base que le
  // mousedown de l'aéroport et que le code stocké via featureProche).
  const rawCode = (airport.code || airport.ident || '').toUpperCase();
  const k = routeWaypoints.findIndex((w) => (w.code || '').toUpperCase() === rawCode);
  if (k >= 0) items.push({ label: t('ctxDeleteWp'), action: () => supprimerPointTournant(k) });
  // Cercle de portée centré sur l'aéroport (rayon saisi dans la modale).
  items.push({ label: t('ctxRangeCircle'), action: () => ouvrirModaleCercle(L.latLng(airport.lat, airport.lon)) });
  if (aDesCercles()) items.push({ label: t('ctxRangeClear'), action: effacerCercles });
  ouvrirMenuContextuel(p.x, p.y, items);
}

// Menu sur le FOND de carte (ni aéroport ni navaid) ou un lieu de poser : définir
// le départ (ZZZY) / l'arrivée (ZZZZ) à partir de ce point, + cercle de portée.
// Items communs du menu « fond de carte » (départ/arrivée/cercle + effacer tous).
function itemsFondCarte(latlng) {
  const items = [
    { label: t('ctxSetDepPoint'), action: () => { _lieuDepartLatLng = latlng; definirIcao('dep', 'ZZZY'); } },
    { label: t('ctxSetArrPoint'), action: () => { _lieuArriveeLatLng = latlng; definirIcao('arr', 'ZZZZ'); } },
    { label: t('ctxRangeCircle'), action: () => ouvrirModaleCercle(latlng) },
  ];
  if (aDesCercles()) items.push({ label: t('ctxRangeClear'), action: effacerCercles });
  return items;
}
function ouvrirMenuFondCarte(e) {
  if (e.originalEvent) e.originalEvent.preventDefault();
  const p = ctxPageXY(e);
  ouvrirMenuContextuel(p.x, p.y, itemsFondCarte(e.latlng));
}

// Menu d'un cercle de portée (clic droit sur son tracé) : options du fond de
// carte + suppression de CE cercle.
function ouvrirMenuCercle(e, supprimerCeCercle) {
  if (e.originalEvent) e.originalEvent.preventDefault();
  L.DomEvent.stopPropagation(e);
  const p = ctxPageXY(e);
  const items = itemsFondCarte(e.latlng);
  items.push({ label: t('ctxRangeDeleteOne'), action: supprimerCeCercle });
  ouvrirMenuContextuel(p.x, p.y, items);
}

// Menu sur un navaid : arrivée ZZZZ + cercle de portée du navaid (rayon publié).
function ouvrirMenuNavaid(e, navaid) {
  if (e.originalEvent) e.originalEvent.preventDefault();
  const p = ctxPageXY(e);
  const latlng = e.latlng;
  const items = [
    { label: t('ctxSetArrPoint'), action: () => { _lieuArriveeLatLng = latlng; definirIcao('arr', 'ZZZZ'); } },
  ];
  if (navaid && Number.isFinite(navaid.rangeNm) && navaid.rangeNm > 0) {
    items.push({ label: t('ctxRangeCircleNavaid'), action: () => tracerCercleNavaid(navaid) });
  }
  if (aDesCercles()) items.push({ label: t('ctxRangeClear'), action: effacerCercles });
  ouvrirMenuContextuel(p.x, p.y, items);
}

// ============================================================
// Cercles de portée (repris de NavXpressVFR). Anneau magenta #FF00FF (ép.2, sans
// remplissage) ; le cercle MANUEL ajoute un point central plein (8px). Le cercle
// NAVAID utilise sa portée publiée (rangeNm), centré sur le navaid (pas de point,
// son icône marque déjà le centre). Les cercles s'accumulent ; effacés par le menu
// ou par « Nouveau plan ».
// ============================================================
const MAGENTA = '#ff00ff';
let _rangeLayer = null;          // créé dans initMap
let _rangePendingLatLng = null;  // centre en attente (modale de saisie ouverte)

function tracerCercle(lat, lon, nm, avecPoint) {
  if (!_rangeLayer || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(nm) || nm <= 0) return;
  const rayonM = nm * 1852;
  // Trait visible (non interactif).
  const visible = L.circle([lat, lon], { radius: rayonM, color: MAGENTA, weight: 2, opacity: 1, fill: false, interactive: false }).addTo(_rangeLayer);
  // Bande de clic invisible centrée sur le trait : ép. 4 = trait (2px) + 1px de
  // chaque côté (magnétisme). Trait « transparent » (≠ none) → cliquable même
  // invisible. Porte le menu contextuel du cercle.
  const hit = L.circle([lat, lon], { radius: rayonM, color: 'transparent', weight: 4, opacity: 1, fill: false, interactive: true }).addTo(_rangeLayer);
  let dot = null;
  if (avecPoint) {
    dot = L.circleMarker([lat, lon], { radius: 4, stroke: false, fill: true, fillColor: MAGENTA, fillOpacity: 1, interactive: false }).addTo(_rangeLayer);
  }
  const supprimer = () => {
    _rangeLayer.removeLayer(visible);
    _rangeLayer.removeLayer(hit);
    if (dot) _rangeLayer.removeLayer(dot);
  };
  hit.on('contextmenu', (e) => ouvrirMenuCercle(e, supprimer));
  hit.on('mouseover', () => { if (!_routeDragging) map.getContainer().style.cursor = 'pointer'; });
  hit.on('mouseout', () => { if (!_routeDragging) map.getContainer().style.cursor = ''; });
}

function tracerCercleNavaid(navaid) {
  if (navaid) tracerCercle(navaid.lat, navaid.lon, navaid.rangeNm, false);
}

function aDesCercles() { return !!_rangeLayer && _rangeLayer.getLayers().length > 0; }
function effacerCercles() { if (_rangeLayer) _rangeLayer.clearLayers(); }

function ouvrirModaleCercle(latlng) {
  _rangePendingLatLng = latlng;
  $('range-radius').value = '';
  $('range-error').textContent = '';
  $('range-overlay').hidden = false;
  setTimeout(() => { try { $('range-radius').focus(); } catch (_) {} }, 50);
}
function fermerModaleCercle() { $('range-overlay').hidden = true; _rangePendingLatLng = null; }
function validerCercle() {
  if (!_rangePendingLatLng) return;
  const nm = parseFloat(String($('range-radius').value || '').trim().replace(',', '.'));
  if (!Number.isFinite(nm) || nm <= 0) { $('range-error').textContent = t('rangeInvalid'); return; }
  tracerCercle(_rangePendingLatLng.lat, _rangePendingLatLng.lng, nm, true);
  fermerModaleCercle();
}

$('btn-range-ok').addEventListener('click', validerCercle);
$('btn-range-cancel').addEventListener('click', fermerModaleCercle);
$('range-radius').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); validerCercle(); }
  else if (e.key === 'Escape') { e.preventDefault(); fermerModaleCercle(); }
});

// ============================================================
// Ligne de route : trait droit ICAO départ → ICAO arrivée.
// Rouge épaisseur 3, bordé de blanc (1 px de chaque côté) — deux polylignes
// superposées (blanche ép.5 dessous, rouge ép.3 dessus). Les points sont résolus
// depuis la base aéroports (par code) ; 'ZZZZ' utilise le dernier point cliqué.
// ============================================================
let routeLayer = null;
let _lieuDepartLatLng = null;    // point de départ hors-aéroport (ZZZY)
let _lieuArriveeLatLng = null;   // point d'arrivée hors-aéroport (ZZZZ)
// Points tournants entre départ et arrivée, dans l'ordre de parcours. C'est le
// stockage EN MÉMOIRE du plan : [{lat, lon}] en coordonnées canoniques
// [-180,180]. (La sauvegarde du plan de vol s'appuiera dessus.)
let routeWaypoints = [];
let _routeTimer = null;
let _routeReqId = 0;
let _routeDragging = false;   // drag de création/déplacement d'un point en cours

function planifierLigneRoute() {
  if (_routeTimer) clearTimeout(_routeTimer);
  _routeTimer = setTimeout(majLigneRoute, 150);
}

// Résout une valeur de champ ICAO en {lat, lon} (ou null si introuvable).
// ZZZY = point de départ cliqué, ZZZZ = point d'arrivée cliqué.
async function resoudrePointIcao(valeur) {
  const code = nettoyerIcao(valeur);
  if (!code) return null;
  if (code === 'ZZZY') {
    return _lieuDepartLatLng ? { lat: _lieuDepartLatLng.lat, lon: _lieuDepartLatLng.lng } : null;
  }
  if (code === 'ZZZZ') {
    return _lieuArriveeLatLng ? { lat: _lieuArriveeLatLng.lat, lon: _lieuArriveeLatLng.lng } : null;
  }
  let res;
  try { res = await window.bc.aeroportParCode(code); } catch (_) { return null; }
  return (res && res.ok && res.airport) ? { lat: res.airport.lat, lon: res.airport.lon } : null;
}

// Ramène une longitude (éventuellement déroulée hors plage) dans [-180, 180].
function wrapLon(lon) { return ((lon + 180) % 360 + 360) % 360 - 180; }

// Déroule les longitudes d'une suite de points pour l'AFFICHAGE (antiméridien) :
// chaque point reste dans la même copie du monde que le précédent (écart ≤ 180°),
// pour que la ligne emprunte toujours le plus court chemin. Coordonnées stockées
// inchangées. Renvoie le tableau des longitudes d'affichage.
function deroulerLons(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0) { out.push(points[0].lon); continue; }
    let d = points[i].lon - points[i - 1].lon;
    d = ((d + 180) % 360 + 360) % 360 - 180;
    out.push(out[i - 1] + d);
  }
  return out;
}

// Extrémités résolues (cache), pour redessiner la route de façon SYNCHRONE
// pendant un drag sans relancer la résolution ICAO (asynchrone) à chaque mouvement.
let _routeDep = null, _routeArr = null;

// Altitude planifiée par leg (ft). Ancrée sur le point SOURCE du leg : sur le
// point tournant qui débute le leg (wp.alt), et pour le tout premier leg (au
// départ) sur cette variable dédiée. Suit donc les insertions/déplacements de
// points comme le nom. null = non renseignée.
let _legAltDep = null;
const DEFAULT_LEG_ALT = 2500;   // altitude par défaut d'un leg (ft) tant que non renseignée
function getLegAlt(i) {
  if (i === 0) return Number.isFinite(_legAltDep) ? _legAltDep : DEFAULT_LEG_ALT;
  const wp = routeWaypoints[i - 1];
  return wp && Number.isFinite(wp.alt) ? wp.alt : DEFAULT_LEG_ALT;
}
function setLegAlt(i, v) {
  const val = Number.isFinite(v) ? v : null;
  if (i === 0) { _legAltDep = val; return; }
  const wp = routeWaypoints[i - 1];
  if (!wp) return;
  if (val == null) delete wp.alt; else wp.alt = val;
}

// Leg actif (0-based). Suit l'avion par séquencement (avance quand l'avion
// franchit le travers du waypoint de fin, ou la bissectrice du virage suivant),
// ou forcé au clic droit dans le tableau. Couleurs carte : actif = rouge,
// suivants = magenta, faits = gris.
let _legActif = 0;
const LEG_COL_ACTIVE = '#ff0000';   // leg actif
const LEG_COL_NEXT   = '#ff00ff';   // legs à venir (magenta)
const LEG_COL_PAST   = '#9e9e9e';   // legs déjà parcourus (gris)

function nbLegs() {
  if (!_routeDep || !_routeArr) return 0;
  return routeWaypoints.length + 1;
}
// Leg actif ramené dans [0, nbLegs-1] (−1 si pas de route).
function legActifClamp() {
  const n = nbLegs();
  return n <= 0 ? -1 : Math.max(0, Math.min(_legActif, n - 1));
}
// Forçage manuel (clic droit) : rend le leg i actif, recolore carte + tableau.
function forcerLegActif(i) {
  if (!(i >= 0)) return;
  _legActif = i;
  dessinerRoute();
}
// Séquencement auto, portage FIDÈLE de Little Navmap (Route::updateActiveLegAndPos).
// Le leg actif « cur » (A→B) bascule sur le suivant (B→C) quand :
//   • l'avion a franchi le TRAVERS de B  → statut du leg actif == AFTER_END ; OU
//   • le leg suivant est devenu plus proche que le leg actif
//     (isSmaller, marge 10 m) ET le cap RÉEL de l'avion s'écarte de moins de 90°
//     du cap du leg suivant (courseDiff).
// La distance comparée par isSmaller est, hors segment, la distance au point
// d'extrémité le plus proche (cf. distanceVersLeg) : tant que l'avion n'a pas
// atteint B, il est BEFORE_START du leg suivant → distance = distance à B
// (grande) → aucune bascule anticipée, même en s'écartant latéralement.
// Aucun cercle de proximité. Monotone (n'avance jamais en arrière) ; le forçage
// manuel (clic droit) tient jusqu'au prochain franchissement.
const _SEQ_EPS_NM = 10 / 1852;   // marge isSmaller de LNM : 10 mètres, en NM

function majLegActifDepuisAvion(f) {
  if (!f || typeof f.lat !== 'number' || typeof f.lon !== 'number' || !isFinite(f.lat) || !isFinite(f.lon)) return;
  const n = nbLegs();
  if (n <= 0) return;
  const cur = legActifClamp();
  if (cur < 0 || cur >= n - 1) return;   // dernier leg → rien à séquencer
  const pts = [_routeDep, ...routeWaypoints, _routeArr];
  const A = pts[cur];        // départ du leg actif
  const B = pts[cur + 1];    // arrivée du leg actif (waypoint à franchir)
  const C = pts[cur + 2];    // arrivée du leg suivant (absent sur l'avant-dernier)

  const resActif = distanceVersLeg(f.lat, f.lon, A.lat, A.lon, B.lat, B.lon);

  // 1) Travers de B franchi.
  let basculer = (resActif.status === 'AFTER_END');

  // 2) Leg suivant plus proche + cap avion cohérent avec le leg suivant.
  if (!basculer && C) {
    const resSuivant = distanceVersLeg(f.lat, f.lon, B.lat, B.lon, C.lat, C.lon);
    const capSuivant = capVraiInitial(B.lat, B.lon, C.lat, C.lon);
    // Cap RÉEL de l'avion (vrai) — pos.course de LNM. Repli : cap du leg actif.
    const capAvion = Number.isFinite(f.headingTrue) ? f.headingTrue : capVraiInitial(A.lat, A.lon, B.lat, B.lon);
    let courseDiff = Math.abs(((capAvion - capSuivant) % 360 + 360) % 360);
    if (courseDiff > 180) courseDiff = 360 - courseDiff;
    // isSmaller(resSuivant, resActif, 10 m) && courseDiff < 90°
    if (Math.abs(resSuivant.distance) < Math.abs(resActif.distance) + _SEQ_EPS_NM && courseDiff < 90) {
      basculer = true;
    }
  }

  if (basculer) {
    _legActif = cur + 1;
    dessinerRoute();
  }
}

// --- Géométrie pour les étiquettes de leg (cap magnétique + distance) ---
const _RAYON_TERRE_NM = 3440.065;

// Cap vrai initial (grand cercle) de A vers B, en degrés [0,360).
// On passe des longitudes d'affichage (déroulées) → l'écart est déjà le plus
// court chemin, l'antiméridien est donc géré.
function capVraiInitial(latA, lonA, latB, lonB) {
  const f1 = latA * Math.PI / 180, f2 = latB * Math.PI / 180;
  const dl = (lonB - lonA) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Distance grand cercle A→B en milles nautiques.
function distanceNM(latA, lonA, latB, lonB) {
  const f1 = latA * Math.PI / 180, f2 = latB * Math.PI / 180;
  const df = (latB - latA) * Math.PI / 180, dl = (lonB - lonA) * Math.PI / 180;
  const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * _RAYON_TERRE_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Portage fidèle de atools::geo::Pos::distanceMeterToLine (Little Navmap) :
// projette P sur la droite grand-cercle A→B. Toutes distances en NM.
//   status        : 'ALONG_TRACK' (pied entre A et B), 'BEFORE_START' (avant A),
//                   'AFTER_END' (après B) ou 'INVALID'.
//   distance      : si ALONG_TRACK → écart latéral SIGNÉ (+ = à droite de la
//                   route) ; sinon → distance au point d'extrémité le plus proche
//                   (A ou B). C'est ce basculement de sens qui empêche toute
//                   bascule anticipée quand l'avion n'a pas encore atteint B.
//   distanceFrom1 : distance le long de la route de A au pied de la perpendiculaire.
//   distanceFrom2 : idem depuis B.
// Antiméridien géré (caps via atan2(sin, cos), périodiques).
function distanceVersLeg(latP, lonP, latA, lonA, latB, lonB) {
  const R = _RAYON_TERRE_NM;
  const res = { distance: NaN, distanceFrom1: NaN, distanceFrom2: NaN, status: 'INVALID' };
  if (![latP, lonP, latA, lonA, latB, lonB].every(Number.isFinite)) return res;

  const dist1To2 = distanceNM(latA, lonA, latB, lonB) / R;   // distance angulaire A→B (rad)
  if (dist1To2 === 0) {                                       // leg dégénéré A == B
    res.status = 'ALONG_TRACK';
    res.distance = distanceNM(latP, lonP, latA, lonA);
    res.distanceFrom1 = res.distanceFrom2 = 0;
    return res;
  }

  const distFrom1 = distanceNM(latA, lonA, latP, lonP) / R;   // rad
  const distFrom2 = distanceNM(latB, lonB, latP, lonP) / R;   // rad
  const courseFrom1 = capVraiInitial(latA, lonA, latP, lonP) * Math.PI / 180;  // cap A→P
  const course1To2  = capVraiInitial(latA, lonA, latB, lonB) * Math.PI / 180;  // cap A→B

  // Écart latéral (+ = à droite du cap) puis distances le long de la route.
  const crossTrack = Math.asin(Math.max(-1, Math.min(1, Math.sin(distFrom1) * Math.sin(courseFrom1 - course1To2))));
  const distAlongFrom1 = Math.acos(Math.max(-1, Math.min(1, Math.cos(distFrom1) / Math.cos(crossTrack))));
  const distAlongFrom2 = Math.acos(Math.max(-1, Math.min(1, Math.cos(distFrom2) / Math.cos(crossTrack))));

  if (distAlongFrom1 <= dist1To2 && distAlongFrom2 <= dist1To2) {
    res.status = 'ALONG_TRACK';
    res.distance = crossTrack * R;
  } else {
    res.status = (distFrom1 < distFrom2) ? 'BEFORE_START' : 'AFTER_END';
    res.distance = (distFrom1 < distFrom2 ? distFrom1 : distFrom2) * R;
  }
  res.distanceFrom1 = distAlongFrom1 * R;
  res.distanceFrom2 = distAlongFrom2 * R;
  return res;
}

// Mesure la largeur d'un texte au gabarit de l'étiquette (canvas hors-écran).
let _badgeCtx = null;
function mesurerLargeurTexte(txt) {
  if (!_badgeCtx) {
    _badgeCtx = document.createElement('canvas').getContext('2d');
    _badgeCtx.font = "11px 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
  }
  return _badgeCtx.measureText(txt).width;
}

// Déclinaison magnétique locale par leg (degrés, + = Est), via le modèle WMM du
// main. Le tracé est SYNCHRONE (drag) alors que le modèle est ASYNCHRONE (IPC) :
// on mémorise donc les valeurs dans un cache indexé par position arrondie, que
// `dessinerEtiquetteLeg` lit au milieu de son segment (repli : moyenne de route).
// Indexer par position (et non par index de leg) reste correct pendant un drag,
// où le nombre de legs change à la volée.
const _DECL_GRID = 0.5;          // pas de la grille de cache (~30 NM)
const _declCache = new Map();    // clé "lat,lon" arrondie → déclinaison (°, +E)
let _routeDeclinaison = 0;       // repli : moyenne des legs (segments pas en cache)

function _cleDecl(lat, lon) {
  const rl = Math.round(lat / _DECL_GRID) * _DECL_GRID;
  const ro = Math.round(wrapLon(lon) / _DECL_GRID) * _DECL_GRID;
  return rl + ',' + ro;
}

// Déclinaison connue la plus proche d'un point (repli : moyenne de route).
function declinaisonEn(lat, lon) {
  const v = _declCache.get(_cleDecl(lat, lon));
  return Number.isFinite(v) ? v : _routeDeclinaison;
}

async function rafraichirDeclinaison() {
  if (!_routeDep || !_routeArr) return;
  const pts = [_routeDep, ...routeWaypoints, _routeArr];
  const disp = deroulerLons(pts);   // évite l'artefact antiméridien sur les milieux

  // Une requête WMM par leg : déclinaison au milieu de chaque segment, mémorisée
  // dans le cache de position. Leur moyenne sert de repli pour les segments pas
  // encore en cache (ex. aperçu d'un drag).
  let somme = 0, n = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const midLat = (pts[i].lat + pts[i + 1].lat) / 2;
    const midLon = wrapLon((disp[i] + disp[i + 1]) / 2);
    let res;
    try { res = await window.bc.declinaison(midLat, midLon); } catch (_) { res = null; }
    if (res && res.ok && Number.isFinite(res.decl)) {
      _declCache.set(_cleDecl(midLat, midLon), res.decl);
      somme += res.decl; n += 1;
    }
  }
  _routeDeclinaison = n ? somme / n : 0;
  dessinerRoute();   // ré-étiquette avec les déclinaisons à jour
}

// --- Aimantation d'un point tournant sur un aéroport / navaid proche ---
const SNAP_RAYON_NM = 0.2;
let _snapIndex = -1;        // index (dans routeWaypoints) du point concerné
let _snapFeature = null;    // feature proposé (aéroport/navaid)

// Lieu de poser le plus proche d'un point (depuis le cache renderer _lieuxData).
// Le nom du lieu sert d'identifiant du point tournant (pas d'ICAO pour un lieu).
function lieuProche(lat, lon, rayonNm) {
  if (!Array.isArray(_lieuxData)) return null;
  let best = null;
  for (const l of _lieuxData) {
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon)) continue;
    if (Math.abs(l.lat - lat) > 0.05) continue;   // gate grossier (~3 NM)
    const d = distanceNM(lat, lon, l.lat, l.lon);
    if (d <= rayonNm && (!best || d < best.distNm)) {
      const nom = l.nom || `${t('lieuUntitled')} #${l.id}`;
      best = { kind: 'lieu', code: nom, name: nom, lat: l.lat, lon: l.lon, distNm: d };
    }
  }
  return best;
}

// Après création/déplacement d'un point tournant : si un aéroport, un navaid OU
// un lieu de poser est à moins de SNAP_RAYON_NM, propose de l'aimanter (modale).
async function verifierProximitePointTournant(index) {
  if (index < 0 || index >= routeWaypoints.length) return;
  const pt = routeWaypoints[index];
  let best = null;
  let res;
  try { res = await window.bc.featureProche(pt.lat, pt.lon, SNAP_RAYON_NM); } catch (_) { res = null; }
  if (res && res.ok && res.found && res.feature) best = res.feature;
  const lieu = lieuProche(pt.lat, pt.lon, SNAP_RAYON_NM);   // lieux = côté renderer
  if (lieu && (!best || lieu.distNm < best.distNm)) best = lieu;
  if (!best) return;
  _snapIndex = index;
  _snapFeature = best;
  const kindKey = best.kind === 'airport' ? 'snapAirport' : best.kind === 'lieu' ? 'snapLieu' : 'snapNavaid';
  const label = (best.code && best.code !== best.name) ? `${best.name} (${best.code})` : best.name;
  const dist = best.distNm < 0.1 ? best.distNm.toFixed(2) : best.distNm.toFixed(1);
  $('snap-text').textContent = t('snapText')
    .replace('{kind}', t(kindKey)).replace('{dist}', dist).replace('{feature}', label);
  $('snap-overlay').hidden = false;
}

function fermerModaleSnap() {
  $('snap-overlay').hidden = true;
  _snapIndex = -1; _snapFeature = null;
}

// Validation : place le point tournant sur les coordonnées du feature.
$('btn-snap-ok').addEventListener('click', () => {
  if (_snapIndex >= 0 && _snapIndex < routeWaypoints.length && _snapFeature) {
    // Point aimanté : on garde le code (ICAO/ident) → il servira de nom du point.
    routeWaypoints[_snapIndex] = { lat: _snapFeature.lat, lon: wrapLon(_snapFeature.lon), code: _snapFeature.code || null };
    dessinerRoute();
    rafraichirDeclinaison();
  }
  fermerModaleSnap();
});
$('btn-snap-cancel').addEventListener('click', fermerModaleSnap);   // garde la position posée

// --- Nommage des points tournants ---
// Nom d'un point tournant : nom personnalisé (renommé dans le tableau) en
// priorité, sinon code aimanté (ICAO/ident), sinon « WPn » numéroté
// séquentiellement — n ne s'incrémente que sur les points NON nommés.
function nomsPointsTournants(wps) {
  let n = 0;
  return wps.map((p) => {
    if (p.nom) return p.nom;
    if (p.code) return p.code;
    n += 1;
    return 'WP' + n;
  });
}

// --- Sauvegarde du plan de vol (.bcpfc) ---
// Construit l'objet plan à partir de l'état courant (ICAO + points tournants).
function construirePlan() {
  const dep = nettoyerIcao($('icao-dep').value);
  const arr = nettoyerIcao($('icao-arr').value);
  const noms = nomsPointsTournants(routeWaypoints);
  return {
    format: 'bcpfc',
    version: 1,
    depart: dep || null,
    arrivee: arr || null,
    // Départ / arrivée hors-aéroport (ZZZY / ZZZZ) : on conserve les coordonnées.
    departPoint: (dep === 'ZZZY' && _lieuDepartLatLng)
      ? { lat: _lieuDepartLatLng.lat, lon: wrapLon(_lieuDepartLatLng.lng) } : null,
    arriveePoint: (arr === 'ZZZZ' && _lieuArriveeLatLng)
      ? { lat: _lieuArriveeLatLng.lat, lon: wrapLon(_lieuArriveeLatLng.lng) } : null,
    // Altitude planifiée du premier leg (au départ) ; celles des autres legs
    // sont portées par les points tournants ci-dessous.
    departAlt: Number.isFinite(_legAltDep) ? _legAltDep : null,
    // code = ICAO/ident si aimanté (sinon null) ; nom = code ou « WPn » ; alt = altitude du leg partant de ce point.
    pointsTournants: routeWaypoints.map((p, i) => ({
      lat: p.lat, lon: p.lon, code: p.code || null, nom: noms[i],
      alt: Number.isFinite(p.alt) ? p.alt : null,
    })),
    cree: new Date().toISOString(),
  };
}

// Le plan n'est enregistrable que s'il a au moins un ICAO départ ET arrivée.
function planEnregistrable() {
  return !!nettoyerIcao($('icao-dep').value) && !!nettoyerIcao($('icao-arr').value);
}
function majBoutonsPlan() {
  $('btn-save-plan').disabled = !planEnregistrable();
}

$('btn-save-plan').addEventListener('click', async () => {
  if (!planEnregistrable()) return;   // garde-fou (le bouton est aussi désactivé)
  const dep = nettoyerIcao($('icao-dep').value);
  const arr = nettoyerIcao($('icao-arr').value);
  let res;
  try {
    res = await window.bc.sauverPlan({ nomSuggere: `${dep} - ${arr}`, titre: t('savePlanTitle'), plan: construirePlan() });
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) };
  }
  if (res && !res.ok && !res.canceled) {
    console.error(t('savePlanErr').replace('{err}', res.error || '?'));
  }
});

// --- Chargement d'un plan de vol (.bcpfc) ---
// Restaure l'état (ICAO, point d'arrivée ZZZZ, points tournants avec leurs codes)
// puis redessine la route.
function appliquerPlan(plan) {
  if (!plan || typeof plan !== 'object') return;
  $('icao-dep').value = nettoyerIcao(plan.depart || '');
  $('icao-arr').value = nettoyerIcao(plan.arrivee || '');
  const dp = plan.departPoint, ap = plan.arriveePoint;
  _lieuDepartLatLng = (dp && Number.isFinite(dp.lat) && Number.isFinite(dp.lon))
    ? L.latLng(dp.lat, dp.lon) : null;
  _lieuArriveeLatLng = (ap && Number.isFinite(ap.lat) && Number.isFinite(ap.lon))
    ? L.latLng(ap.lat, ap.lon) : null;
  routeWaypoints = Array.isArray(plan.pointsTournants)
    ? plan.pointsTournants
        .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map((p) => {
          const wp = { lat: p.lat, lon: p.lon, code: p.code || null };
          // Nom vraiment personnalisé (ni WPn auto, ni simple recopie du code) → restauré.
          if (p.nom && p.nom !== (p.code || '') && !/^WP\d+$/.test(p.nom)) wp.nom = p.nom;
          if (Number.isFinite(p.alt)) wp.alt = p.alt;   // altitude du leg partant de ce point
          return wp;
        })
    : [];
  _legAltDep = Number.isFinite(plan.departAlt) ? plan.departAlt : null;
  _legActif = 0;   // nouveau plan chargé → leg actif = premier
  majBoutonsPlan();
  majLigneRoute({ fit: true });   // re-résout les ICAO, redessine, recalcule la déclinaison, recadre sur le tracé
}

// Nouveau plan : réinitialise tout l'état (ICAO, points de dép./arr. cliqués,
// points tournants) et efface la route.
function reinitialiserPlan() {
  $('icao-dep').value = '';
  $('icao-arr').value = '';
  _lieuDepartLatLng = null;
  _lieuArriveeLatLng = null;
  routeWaypoints = [];
  _legAltDep = null;
  _legActif = 0;
  effacerCercles();   // comme NavXpressVFR : « Nouveau plan » efface aussi les cercles
  majBoutonsPlan();
  majLigneRoute();   // dép./arr. vides → la route est effacée
}

// Y a-t-il un plan en cours (qui mérite une confirmation avant d'être abandonné) ?
function planEnCours() {
  return !!nettoyerIcao($('icao-dep').value) || !!nettoyerIcao($('icao-arr').value)
    || routeWaypoints.length > 0;
}

$('btn-new-plan').addEventListener('click', () => {
  if (!planEnCours()) { reinitialiserPlan(); return; }   // rien à perdre → pas de confirmation
  $('newplan-overlay').hidden = false;
});
$('btn-newplan-cancel').addEventListener('click', () => { $('newplan-overlay').hidden = true; });
$('btn-newplan-ok').addEventListener('click', () => {
  $('newplan-overlay').hidden = true;
  reinitialiserPlan();
});

$('btn-open-plan').addEventListener('click', async () => {
  let res;
  try { res = await window.bc.ouvrirPlan({ titre: t('openPlanTitle') }); }
  catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
  if (!res || res.canceled) return;
  if (!res.ok || !res.plan) { console.error(t('openPlanErr').replace('{err}', (res && res.error) || '?')); return; }
  appliquerPlan(res.plan);
});

// Drag manuel (events DOM natifs). `appliquer(latlng)` est appelé à chaque
// déplacement (prévisualisation temps réel), `valider(latlng)` au relâcher.
function dragPointTournant(appliquer, valider) {
  if (_routeDragging) return;
  _routeDragging = true;
  map.dragging.disable();
  map.getContainer().style.cursor = 'grabbing';
  function latlngFromEvent(ev) {
    const rect = map.getContainer().getBoundingClientRect();
    const pt = L.point(ev.clientX - rect.left, ev.clientY - rect.top);
    return map.containerPointToLatLng(pt);
  }
  function onMove(ev) { appliquer(latlngFromEvent(ev)); }
  function onUp(ev) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    map.dragging.enable();
    map.getContainer().style.cursor = '';
    _routeDragging = false;
    valider(latlngFromEvent(ev));
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Étiquette d'un leg : carré rouge (bord blanc 1 px, texte blanc 11 px) au
// milieu du segment, orienté le long de la ligne. Affiche le cap MAGNÉTIQUE
// (cap vrai − déclinaison) et la distance en NM. N'apparaît que si le segment à
// l'écran est assez long pour contenir le carré + 20 px de ligne de chaque côté
// (sinon il faut zoomer davantage).
function dessinerEtiquetteLeg(a, lonA, b, lonB) {
  if (!map) return;
  const capVrai = capVraiInitial(a.lat, lonA, b.lat, lonB);
  const decl = declinaisonEn((a.lat + b.lat) / 2, (lonA + lonB) / 2);
  const capMag = Math.round(((capVrai - decl) % 360 + 360) % 360);
  const dNM = distanceNM(a.lat, lonA, b.lat, lonB);
  const distTxt = dNM >= 10 ? String(Math.round(dNM)) : dNM.toFixed(1);
  const label = `${String(capMag).padStart(3, '0')}°  ${distTxt} NM`;

  // Largeur du carré (texte + padding 5px×2 + bord 1px×2), hauteur fixe.
  const w = Math.ceil(mesurerLargeurTexte(label)) + 12;
  const h = 19;

  // Longueur du segment à l'écran : on n'affiche que s'il reste ≥ 20 px de ligne
  // de chaque côté du carré.
  const pA = map.latLngToContainerPoint([a.lat, lonA]);
  const pB = map.latLngToContainerPoint([b.lat, lonB]);
  if (pA.distanceTo(pB) < w + 40) return;

  // Orientation le long de la ligne, texte gardé lisible (jamais à l'envers).
  let ang = Math.atan2(pB.y - pA.y, pB.x - pA.x) * 180 / Math.PI;
  if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;

  const icon = L.divIcon({
    className: 'leg-badge-wrap',
    html: `<div class="leg-badge" style="transform:rotate(${ang}deg)">${escapeHtml(label)}</div>`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h / 2],
  });
  L.marker([(a.lat + b.lat) / 2, (lonA + lonB) / 2], { icon, interactive: false, keyboard: false }).addTo(routeLayer);
}

// --- Labels permanents des points tournants (rouge, contour blanc) ---------
// Mesure la largeur d'un nom au gabarit du label (police en gras, canvas caché).
let _labelCtx = null;
function mesurerLargeurLabel(txt) {
  if (!_labelCtx) {
    _labelCtx = document.createElement('canvas').getContext('2d');
    _labelCtx.font = "700 12px 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
  }
  return _labelCtx.measureText(txt).width;
}

// Intersection de deux segments (coordonnées écran).
function segmentsSecants(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (d === 0) return false;   // parallèles
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
function pointDansRect(x, y, r) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
// Un segment [1,2] coupe-t-il le rectangle r (bord ou intérieur) ?
function segmentCoupeRect(x1, y1, x2, y2, r) {
  if (pointDansRect(x1, y1, r) || pointDansRect(x2, y2, r)) return true;
  const rx = r.x + r.w, ry = r.y + r.h;
  return segmentsSecants(x1, y1, x2, y2, r.x, r.y, rx, r.y)     // haut
      || segmentsSecants(x1, y1, x2, y2, rx, r.y, rx, ry)       // droite
      || segmentsSecants(x1, y1, x2, y2, rx, ry, r.x, ry)       // bas
      || segmentsSecants(x1, y1, x2, y2, r.x, ry, r.x, r.y);    // gauche
}
function rectsSeChevauchent(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Place un label rouge (contour blanc) à côté de chaque point tournant, MAIS
// seulement si une position candidate autour du point ne chevauche ni une ligne
// de leg ni un label déjà posé (sinon le nom est masqué : zoom insuffisant).
const WP_LABEL_ZOOM_MIN = 10;   // zoom en deçà duquel les noms de points ne sont pas affichés
function dessinerLabelsPoints(points, disp, wps, noms) {
  if (!map || !wps.length) return;
  if (map.getZoom() < WP_LABEL_ZOOM_MIN) return;   // trop dézoomé → pas de labels
  // Legs en pixels-écran (mêmes points que le tracé).
  const px = points.map((p, i) => map.latLngToContainerPoint([p.lat, disp[i]]));
  const segs = [];
  for (let i = 0; i < px.length - 1; i++) segs.push([px[i], px[i + 1]]);

  const H = 16, GAP = 9, MARGE = 3;   // hauteur label, écart au point, marge anti-frôlement des lignes
  const placés = [];                   // rectangles des labels déjà posés (anti-chevauchement)

  for (let k = 0; k < wps.length; k++) {
    const P = px[k + 1];               // le point tournant occupe l'index k+1 dans la suite
    const nom = noms[k];
    const W = Math.ceil(mesurerLargeurLabel(nom)) + 4;
    // Positions candidates (coin haut-gauche du rectangle), par ordre de préférence.
    const cands = [
      { x: P.x + GAP,     y: P.y - H / 2 },       // E
      { x: P.x + GAP,     y: P.y - GAP - H },      // NE
      { x: P.x + GAP,     y: P.y + GAP },          // SE
      { x: P.x - GAP - W, y: P.y - H / 2 },        // O
      { x: P.x - GAP - W, y: P.y - GAP - H },      // NO
      { x: P.x - GAP - W, y: P.y + GAP },          // SO
      { x: P.x - W / 2,   y: P.y - GAP - H },      // N
      { x: P.x - W / 2,   y: P.y + GAP },          // S
    ];
    let choisi = null;
    for (const c of cands) {
      const r = { x: c.x, y: c.y, w: W, h: H };
      // Test lignes de legs : rectangle élargi de MARGE (les traits font ~5 px).
      const rt = { x: r.x - MARGE, y: r.y - MARGE, w: r.w + 2 * MARGE, h: r.h + 2 * MARGE };
      const heurteLeg = segs.some(([A, B]) => segmentCoupeRect(A.x, A.y, B.x, B.y, rt));
      if (heurteLeg) continue;
      if (placés.some((pr) => rectsSeChevauchent(r, pr))) continue;   // chevauche un autre label
      choisi = r; break;
    }
    if (!choisi) continue;             // aucune position propre → on n'affiche pas ce nom
    placés.push(choisi);
    const icon = L.divIcon({
      className: 'wp-label-wrap',
      html: `<div class="wp-label">${escapeHtml(nom)}</div>`,
      iconSize: [W, H],
      iconAnchor: [P.x - choisi.x, P.y - choisi.y],   // aligne le coin du label sur la position choisie
    });
    L.marker([wps[k].lat, disp[k + 1]], { icon, interactive: false, keyboard: false }).addTo(routeLayer);
  }
}

// Résout les ICAO (asynchrone) puis dessine la route. Garde anti-concurrence.
async function majLigneRoute(opts) {
  if (!routeLayer) return;
  const reqId = ++_routeReqId;
  const dep = await resoudrePointIcao($('icao-dep').value);
  const arr = await resoudrePointIcao($('icao-arr').value);
  if (reqId !== _routeReqId) return;   // une saisie plus récente a pris le relais
  _routeDep = dep; _routeArr = arr;
  dessinerRoute();
  rafraichirDeclinaison();   // recalcule la déclinaison puis ré-étiquette
  if (opts && opts.fit) centrerSurRoute();   // ex. ouverture d'un plan → recadre sur tout le tracé
}

// Recadre la carte pour englober l'entièreté du tracé (dép. + points tournants +
// arr.), longitudes déroulées (antiméridien géré comme pour le tracé). Compense
// le panneau « Plan de vol » s'il couvre le tiers droit.
function centrerSurRoute() {
  if (!map || !_routeDep || !_routeArr) return;
  const pts = [_routeDep, ...routeWaypoints, _routeArr];
  const disp = deroulerLons(pts);
  const bounds = L.latLngBounds(pts.map((p, i) => [p.lat, disp[i]]));
  if (!bounds.isValid()) return;
  const panW = legsPanelVisible() ? $('legs-panel').getBoundingClientRect().width : 0;
  map.fitBounds(bounds, {
    paddingTopLeft: [40, 40],
    paddingBottomRight: [40 + panW, 40],
    maxZoom: 12,
  });
}

// Démarre le déplacement (clic-glisser) du point tournant d'index k. Réutilisé
// par le marqueur du point ET par le clic gauche sur un aéroport qui est ce point.
function demarrerDeplacementPoint(k) {
  if (k < 0 || k >= routeWaypoints.length) return;
  const nom = routeWaypoints[k].nom;   // nom personnalisé : conservé au déplacement (contrairement au code aimanté)
  const alt = routeWaypoints[k].alt;   // altitude de leg : conservée elle aussi
  dragPointTournant(
    (ll) => {   // temps réel : déplace le point dans l'aperçu
      const w = routeWaypoints.slice();
      w[k] = { lat: ll.lat, lon: wrapLon(ll.lng), nom, alt };
      dessinerRoute({ wps: w, activeIdx: k + 1 });
    },
    (ll) => {   // relâcher : enregistre la nouvelle position (perd le code aimanté, garde le nom et l'altitude)
      routeWaypoints[k] = { lat: ll.lat, lon: wrapLon(ll.lng), nom, alt };
      dessinerRoute();
      rafraichirDeclinaison();
      verifierProximitePointTournant(k);   // aimantation aéroport/navaid proche
    }
  );
}

// Supprime le point tournant d'index k.
function supprimerPointTournant(k) {
  if (k < 0 || k >= routeWaypoints.length) return;
  routeWaypoints.splice(k, 1);
  dessinerRoute();
  rafraichirDeclinaison();
}

// Petit point rouge (rayon 6, contour blanc 1px) sur une extrémité hors-aéroport
// (départ ZZZY / arrivée ZZZZ) — il n'y a pas d'icône d'aéroport à cet endroit.
function dessinerPointExtremite(lat, lonDisp) {
  L.circleMarker([lat, lonDisp], {
    radius: 6, color: '#ffffff', weight: 1,
    fillColor: '#ff0000', fillOpacity: 1, opacity: 1, interactive: false,
  }).addTo(routeLayer);
}

// Dessine la route à partir des extrémités en cache (synchrone). `opts.wps`
// remplace les points tournants (prévisualisation pendant un drag) ; `opts.activeIdx`
// est l'index, dans la suite complète, du point en cours de déplacement.
function dessinerRoute(opts) {
  if (!routeLayer) return;
  routeLayer.clearLayers();
  const dep = _routeDep, arr = _routeArr;
  if (!dep || !arr) { if (!opts) { rafraichirTableauLegs(); mettreAJourProfilVertical(); } return; }   // route effacée → vide tableau + profil
  const wps = (opts && opts.wps) ? opts.wps : routeWaypoints;
  const activeIdx = (opts && Number.isFinite(opts.activeIdx)) ? opts.activeIdx : -1;

  // Suite complète : départ → points tournants → arrivée, longitudes d'affichage
  // déroulées (antiméridien).
  const points = [dep, ...wps, arr];
  const disp = deroulerLons(points);

  // Un segment par leg : bordure blanche (dessous) + trait coloré selon l'état du
  // leg (actif rouge / à venir magenta / fait gris). Clic-glisser → insertion d'un point.
  const nLeg = points.length - 1;
  const actLeg = nLeg > 0 ? Math.max(0, Math.min(_legActif, nLeg - 1)) : -1;
  for (let i = 0; i < points.length - 1; i++) {
    const latlngs = [[points[i].lat, disp[i]], [points[i + 1].lat, disp[i + 1]]];
    const legCol = i === actLeg ? LEG_COL_ACTIVE : (i < actLeg ? LEG_COL_PAST : LEG_COL_NEXT);
    L.polyline(latlngs, { color: '#ffffff', weight: 5, opacity: 1 }).addTo(routeLayer);
    const seg = L.polyline(latlngs, { color: legCol, weight: 3, opacity: 1 }).addTo(routeLayer);
    dessinerEtiquetteLeg(points[i], disp[i], points[i + 1], disp[i + 1]);
    const segIndex = i;
    seg.on('mouseover', () => { if (!_routeDragging) { seg.setStyle({ weight: 4 }); map.getContainer().style.cursor = 'crosshair'; } });
    seg.on('mouseout', () => { if (!_routeDragging) { seg.setStyle({ weight: 3 }); map.getContainer().style.cursor = ''; } });
    seg.on('mousedown', (e) => {
      if (e.originalEvent && e.originalEvent.button !== 0) return;   // clic gauche seulement
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      // Le point est inséré à segIndex ; il occupe l'index segIndex+1 dans la suite.
      dragPointTournant(
        (ll) => {   // temps réel : aperçu avec le point inséré sous le curseur
          const w = routeWaypoints.slice();
          w.splice(segIndex, 0, { lat: ll.lat, lon: wrapLon(ll.lng) });
          dessinerRoute({ wps: w, activeIdx: segIndex + 1 });
        },
        (ll) => {   // relâcher : enregistre le point tournant
          routeWaypoints.splice(segIndex, 0, { lat: ll.lat, lon: wrapLon(ll.lng) });
          dessinerRoute();
          rafraichirDeclinaison();
          verifierProximitePointTournant(segIndex);   // aimantation aéroport/navaid proche
        }
      );
    });
  }

  // Marqueurs des points tournants (déplaçables par clic-glisser).
  const noms = nomsPointsTournants(wps);
  for (let k = 0; k < wps.length; k++) {
    const ptIdx = k + 1;
    const actif = ptIdx === activeIdx;
    const m = L.circleMarker([wps[k].lat, disp[ptIdx]], {
      radius: actif ? 7 : 6, color: '#ffffff', weight: 2,
      fillColor: '#ff7043', fillOpacity: 0.95, opacity: 1,
    }).addTo(routeLayer);
    const idx = k;
    m.on('mouseover', () => { if (!_routeDragging) map.getContainer().style.cursor = 'grab'; });
    m.on('mouseout', () => { if (!_routeDragging) map.getContainer().style.cursor = ''; });
    m.on('mousedown', (e) => {
      if (e.originalEvent && e.originalEvent.button !== 0) return;   // clic gauche → déplacement
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      demarrerDeplacementPoint(idx);
    });
    m.on('contextmenu', (e) => {   // clic droit → suppression du point tournant
      if (e.originalEvent) e.originalEvent.preventDefault();
      L.DomEvent.stopPropagation(e);
      const p = ctxPageXY(e);
      ouvrirMenuContextuel(p.x, p.y, [
        { label: t('ctxDeleteWp'), action: () => supprimerPointTournant(idx) },
      ]);
    });
  }

  // Points d'extrémité hors-aéroport (ZZZY départ / ZZZZ arrivée) : point rouge.
  const depCode = nettoyerIcao($('icao-dep').value);
  const arrCode = nettoyerIcao($('icao-arr').value);
  if (depCode === 'ZZZY') dessinerPointExtremite(dep.lat, disp[0]);
  if (arrCode === 'ZZZZ') dessinerPointExtremite(arr.lat, disp[points.length - 1]);

  dessinerLabelsPoints(points, disp, wps, noms);   // noms rouges à côté des points (si place nette)

  if (!opts) { rafraichirTableauLegs(); mettreAJourProfilVertical(); }   // aperçu de drag → pas de reconstruction
}

// Câblage global : ferme le menu sur clic ailleurs / Échap. (Le clic droit
// d'ouverture ne déclenche pas de 'click', donc n'auto-ferme pas le menu.)
document.addEventListener('click', (e) => {
  if (_ctxMenuEl && !e.target.closest('.map-ctx-menu')) fermerMenuContextuel();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerMenuContextuel(); });

// Saisie ICAO : majuscules, alphanumérique seulement, 6 caractères max.
['icao-dep', 'icao-arr'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input', () => {
    const v = nettoyerIcao(el.value);
    if (el.value !== v) el.value = v;
    planifierLigneRoute();
    majBoutonsPlan();
  });
});

// Contrôles déroulants (haut-droite) : couches MSFS + fond de carte, côte à côte.
function ajouterControlesCarte() {
  const ctl = L.control({ position: 'topright' });
  ctl.onAdd = function () {
    const div = L.DomUtil.create('div', 'map-controls');
    div.innerHTML =
      // Widget 1 — couches (cases à cocher)
      `<div class="map-dropdown" id="ctl-couches">` +
        `<button class="map-dd-btn" type="button" data-i18n-title="layersTitle" title="${t('layersTitle')}" aria-haspopup="true" aria-expanded="false"><i class="ph-light ph-stack"></i></button>` +
        `<div class="map-dd-panel" hidden>` +
          `<label><input type="checkbox" data-layer="airports"> <span data-i18n="layerAirports">${t('layerAirports')}</span></label>` +
          `<label><input type="checkbox" data-layer="heliports"> <span data-i18n="layerHeliports">${t('layerHeliports')}</span></label>` +
          `<label><input type="checkbox" data-layer="seaplanes"> <span data-i18n="layerSeaplanes">${t('layerSeaplanes')}</span></label>` +
          `<label><input type="checkbox" data-layer="navaids"> <span data-i18n="layerNavaids">${t('layerNavaids')}</span></label>` +
          `<label><input type="checkbox" data-layer="lieux"> <span data-i18n="layerLieux">${t('layerLieux')}</span></label>` +
        `</div>` +
      `</div>` +
      // Widget 2 — fond de carte (boutons radio)
      `<div class="map-dropdown" id="ctl-fond">` +
        `<button class="map-dd-btn" type="button" data-i18n-title="basemapTitle" title="${t('basemapTitle')}" aria-haspopup="true" aria-expanded="false"><i class="ph-light ph-map-trifold"></i></button>` +
        `<div class="map-dd-panel" hidden>` +
          `<label><input type="radio" name="basemap" data-base="opentopomap"> OpenTopoMap</label>` +
          `<label><input type="radio" name="basemap" data-base="openstreetmap"> OpenStreetMap</label>` +
          `<label><input type="radio" name="basemap" data-base="satellite"> Satellite</label>` +
        `</div>` +
      `</div>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    // Ouverture/fermeture des deux menus (un seul ouvert à la fois)
    const dropdowns = [...div.querySelectorAll('.map-dropdown')];
    dropdowns.forEach((dd) => {
      const btn = dd.querySelector('.map-dd-btn');
      const panel = dd.querySelector('.map-dd-panel');
      btn.addEventListener('click', () => {
        const open = panel.hidden;
        dropdowns.forEach((o) => { o.querySelector('.map-dd-panel').hidden = true; o.querySelector('.map-dd-btn').setAttribute('aria-expanded', 'false'); });
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
      });
    });

    // Couches
    div.querySelectorAll('input[data-layer]').forEach((cb) => {
      cb.checked = !!layerState[cb.dataset.layer];
      cb.addEventListener('change', () => {
        layerState[cb.dataset.layer] = cb.checked;
        localStorage.setItem('bc-layer-' + cb.dataset.layer, cb.checked ? '1' : '0');
        if (cb.dataset.layer === 'lieux') rafraichirLieux();   // liste globale, hors bbox
        else rafraichirCouches();
      });
    });

    // Fond de carte
    const fondActuel = localStorage.getItem('bc-basemap') || 'opentopomap';
    div.querySelectorAll('input[data-base]').forEach((rb) => {
      rb.checked = (rb.dataset.base === fondActuel);
      rb.addEventListener('change', () => { if (rb.checked) appliquerFond(rb.dataset.base); });
    });
    return div;
  };
  ctl.addTo(map);
}

// Oriente l'image de l'avion selon le cap (degrés, sens horaire = nord 0°).
// On accumule une rotation NON bornée : à chaque image on n'ajoute que le plus
// court écart angulaire (±180°), pour que la transition CSS tourne toujours du
// bon côté et ne fasse pas un tour complet au passage 359°↔0°.
function orienterAvion(capDeg) {
  if (!planeMarker) return;
  const el = planeMarker.getElement();
  const img = el && el.firstElementChild;
  if (!img) return;
  const cap = Number.isFinite(capDeg) ? capDeg : 0;
  if (capPrecedent === null) {
    rotationAvion = cap;
  } else {
    let delta = cap - capPrecedent;
    delta = ((delta + 180) % 360 + 360) % 360 - 180;   // ramène à (-180°, +180°]
    rotationAvion += delta;
  }
  capPrecedent = cap;
  img.style.transform = `rotate(${rotationAvion}deg)`;
}

function majCarte(f) {
  if (!map || typeof f.lat !== 'number' || typeof f.lon !== 'number'
      || !isFinite(f.lat) || !isFinite(f.lon)) return;
  const ll = [f.lat, f.lon];
  if (!planeMarker) {
    planeMarker = L.marker(ll, { icon: planeIcon }).addTo(map);
    capPrecedent = null;   // nouveau marqueur → repart d'une orientation absolue
    map.setView(ll, 13);   // premier point : on cadre sur l'avion
  } else {
    planeMarker.setLatLng(ll);
    if (suiviActif && !suiviPause) map.panTo(ll);   // recentre (zoom inchangé)
  }
  // Tracé continu magenta, 3 px, qui suit l'avion.
  if (!planeTrack) {
    planeTrack = L.polyline([ll], { color: '#ff00ff', weight: 3 }).addTo(map);
  } else {
    planeTrack.addLatLng(ll);
  }
  orienterAvion(f.headingTrue);   // carte nord-VRAI → orienter l'avion en cap vrai (pas magnétique)
}

// Indicateur de vent. Le TEXTE donne la direction d'où vient le vent, en
// MAGNÉTIQUE : la variation locale est dérivée des deux caps avion
// (mag = vrai + magvar, donc magvar = headingMag − headingTrue). La FLÈCHE,
// elle, reste orientée en VRAI (la carte est nord-vrai) et pointe vers où VA
// le vent (= direction d'où il vient + 180°).
// Rafraîchi au plus toutes les 5 s (le flux scan arrive ~2×/s).
let _ventLastUpdate = 0;
const VENT_THROTTLE_MS = 5000;
function majVent(f) {
  const ind = $('wind-indicator');
  if (!Number.isFinite(f.windDir) || !Number.isFinite(f.windKt)) { ind.hidden = true; _ventLastUpdate = 0; return; }
  const now = Date.now();
  if (_ventLastUpdate && now - _ventLastUpdate < VENT_THROTTLE_MS) return;
  _ventLastUpdate = now;
  const norm360 = (x) => ((Math.round(x) % 360) + 360) % 360;
  const norm180 = (x) => { const v = ((x % 360) + 360) % 360; return v > 180 ? v - 360 : v; };
  const magvar = (Number.isFinite(f.headingTrue) && Number.isFinite(f.headingMag))
    ? norm180(f.headingMag - f.headingTrue) : 0;
  const dirTrue = norm360(f.windDir);
  const dirMag = norm360(f.windDir + magvar);
  $('wind-text').textContent = `${String(dirMag).padStart(3, '0')}° ${Math.round(f.windKt)} kt`;
  $('wind-arrow').style.transform = `rotate(${dirTrue + 180}deg)`;
  ind.hidden = false;
}

function viderScan() {
  ['b-lat','b-lon','b-amsl'].forEach((id) => { $(id).textContent = '—'; });
  if (map && planeMarker) { map.removeLayer(planeMarker); planeMarker = null; }
  if (map && planeTrack) { map.removeLayer(planeTrack); planeTrack = null; }
  $('wind-indicator').hidden = true;
  _ventLastUpdate = 0;
  suiviPause = false;
  if (_suiviTimer) { clearTimeout(_suiviTimer); _suiviTimer = null; }
  capPrecedent = null;
  rotationAvion = 0;
}

function majScan(f) {
  $('b-lat').textContent = fmt(f.lat, 5);
  $('b-lon').textContent = fmt(f.lon, 5);
  $('b-amsl').textContent = fmt(f.amslFt);
  majCarte(f);
  majVent(f);
  majLegActifDepuisAvion(f);   // séquencement du leg actif selon la position avion
}

// --- Câblage ---
$('btn-connect').addEventListener('click', async () => {
  if (connecte) {
    await window.bc.disconnect();
  } else {
    setStatus('connecting');
    const res = await window.bc.connect();
    if (!res.ok && res.error) setStatus('disconnected', res.error);
  }
});

// ============================================================
// Modale « À propos » (bouton « ? » du header). Liens externes ouverts
// dans le navigateur par défaut via setWindowOpenHandler (main.js).
// ============================================================
$('btn-about').addEventListener('click', () => {
  const v = lastConfig && lastConfig.version;
  $('about-version').textContent = v ? 'v' + v : '';
  $('about-overlay').hidden = false;
});
$('btn-about-close').addEventListener('click', () => { $('about-overlay').hidden = true; });
$('about-overlay').addEventListener('click', (e) => {
  if (e.target === $('about-overlay')) $('about-overlay').hidden = true;   // clic sur le fond
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('about-overlay').hidden) $('about-overlay').hidden = true;
});

// Toggle FR / EN : change la langue puis ré-applique les textes dynamiques
// (les libellés statiques sont gérés par applyTranslations() dans setLanguage).
$('btn-lang-toggle').addEventListener('click', () => {
  setLanguage(currentLang === 'fr' ? 'en' : 'fr');
  renderStatus();
  renderApiHint();
  setQueueBadge(lastQueueCount);
  renderUpdateBanner();
});

// ============================================================
// Bannière de mise à jour automatique (electron-updater).
// On ne dérange l'utilisateur que pour le téléchargement en cours et la MAJ
// prête (les états checking/available/none/error restent silencieux).
// ============================================================
let updateState = null;   // dernier état reçu du main (pour re-rendu à la bascule de langue)

function renderUpdateBanner() {
  const banner = $('update-banner');
  const text = $('update-banner-text');
  const action = $('update-banner-action');
  const st = updateState && updateState.state;

  if (st === 'downloading') {
    text.textContent = t('updateDownloading').replace('{percent}', updateState.percent ?? 0);
    action.hidden = true;
    banner.hidden = false;
  } else if (st === 'ready') {
    text.textContent = t('updateReady').replace('{version}', updateState.version || '');
    action.innerHTML = '<i class="ph-light ph-arrow-clockwise"></i> ' + t('updateRestart');
    action.hidden = false;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

$('update-banner-action').addEventListener('click', () => window.bc.installUpdate());
window.bc.onUpdateStatus((p) => { updateState = p; renderUpdateBanner(); });
// Rejeu : rattrape un état de MAJ émis avant que l'écouteur ci-dessus soit posé
// (course au démarrage / rechargement de la fenêtre).
if (typeof window.bc.getUpdateState === 'function') {
  Promise.resolve(window.bc.getUpdateState())
    .then((s) => { if (s) { updateState = s; renderUpdateBanner(); } })
    .catch(() => {});
}

window.bc.onStatus((s) => {
  if (s.state) setStatus(s.state, s.app || s.error || s.warn);
});
window.bc.onScan((f) => majScan(f));

// Config rafraîchie par le main (après enregistrement de la clé) → MAJ de l'indice.
window.bc.onConfig((cfg) => { lastConfig = cfg; renderApiHint(); });

// ============================================================
// Clé API — saisie dynamique (bouton + modale).
// ============================================================
$('btn-api-key').addEventListener('click', () => {
  const st = $('apikey-status');
  st.hidden = true; st.className = 'modal-status';
  $('apikey-input').value = '';   // on ne ré-affiche jamais le secret stocké
  $('apiurl-input').value = (lastConfig && lastConfig.apiBaseUrl) || '';
  $('btn-apikey-save').disabled = false;
  $('apikey-overlay').hidden = false;
  $('apikey-input').focus();
});

$('btn-apikey-cancel').addEventListener('click', () => { $('apikey-overlay').hidden = true; });

$('btn-apikey-save').addEventListener('click', async () => {
  const key = $('apikey-input').value.trim();
  const url = $('apiurl-input').value.trim();
  const st = $('apikey-status');
  $('btn-apikey-save').disabled = true;
  const res = await window.bc.setApiKey(key, url);
  if (res.ok) {
    lastConfig = { apiBaseUrl: res.apiBaseUrl, cleConfiguree: res.cleConfiguree, source: res.source };
    renderApiHint();
    st.className = 'modal-status is-ok';
    st.textContent = res.cleConfiguree ? t('apiKeySaved') : t('apiKeyCleared');
    st.hidden = false;
    setTimeout(() => { $('apikey-overlay').hidden = true; }, 1400);
  } else {
    st.className = 'modal-status is-error';
    st.textContent = t('apiKeyErr').replace('{err}', res.error || '?');
    st.hidden = false;
    $('btn-apikey-save').disabled = false;
  }
});

// ============================================================
// Jalon 4 — capture manuelle (bouton gated) + envoi groupé en fin de vol.
// ============================================================
const FT_PER_M = 3.280839895;
let captureUid = null;       // uid du poser courant (cible du bouton capture)
let flightLandings = [];     // posers du vol (reçus à la fin)
let flightMeta = null;       // méta du vol (temps bloc, aéronef…) envoyées avec le vol

function setCaptureEnabled(on) {
  $('btn-capture').disabled = !on;
}

// --- Bouton flottant « Capture d'écran » ---
$('btn-capture').addEventListener('click', () => {
  if ($('btn-capture').disabled) return;
  const st = $('capture-status');
  st.hidden = true; st.className = 'modal-status';
  $('capture-thumb').removeAttribute('src');
  $('btn-capture-do').disabled = false;
  $('capture-overlay').hidden = false;
});

$('btn-capture-cancel').addEventListener('click', () => { $('capture-overlay').hidden = true; });

$('btn-capture-do').addEventListener('click', async () => {
  if (!captureUid) return;
  const st = $('capture-status');
  $('btn-capture-do').disabled = true;
  const res = await window.bc.captureNow(captureUid);
  if (res.ok) {
    $('capture-thumb').src = res.thumbDataUrl;
    st.className = 'modal-status is-ok'; st.textContent = t('captureSaved'); st.hidden = false;
    const l = flightLandings.find((x) => x.uid === captureUid);
    if (l) l.hasCapture = true;
    if (!$('send-overlay').hidden) { renderSendList(); majSendModal(); }   // si modale d'envoi ouverte
    $('btn-capture-do').disabled = false;   // on autorise un re-cadrage
  } else {
    st.className = 'modal-status is-error';
    st.textContent = t('captureErr').replace('{err}', res.error || '?');
    st.hidden = false;
    $('btn-capture-do').disabled = false;
  }
});

// --- Événements FSM (main → renderer) ---
window.bc.onCaptureState(({ canCapture, uid }) => {
  if (uid) captureUid = uid;
  setCaptureEnabled(!!canCapture);
});
window.bc.onLandingRecorded(() => { /* listé en fin de vol */ });
window.bc.onFlightEnded(({ landings, flight }) => {
  flightLandings = (landings || []).map((l) => ({ ...l }));
  flightMeta = flight || null;
  renderSendList();
  renderFlightSummary();
  majSendModal();
  $('btn-send-no').disabled = false;
  $('discard-overlay').hidden = true;
  $('send-overlay').hidden = false;
});

// Bandeau récap du vol dans la modale d'envoi : temps de vol + nombre de posers.
function renderFlightSummary() {
  const el = $('send-flight-summary');
  if (!el) return;
  let temps = '—';
  const sec = flightMeta && flightMeta.durationSec;
  if (sec != null && Number.isFinite(sec) && sec >= 0) {
    const m = Math.round(sec / 60);
    temps = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  }
  el.textContent = t('sendFlightSummary')
    .replace('{time}', temps)
    .replace('{n}', flightLandings.length);
}

// Liste des posers dans la modale d'envoi (sans photo = non valide, non envoyé).
function renderSendList() {
  const list = $('send-list');
  list.innerHTML = flightLandings.map((l) => {
    const r = l.releve;
    const photo = l.hasCapture
      ? `<span class="sl-photo has">${t('listPhotoYes')}</span>`
      : `<span class="sl-photo invalid">${t('listNoSend')}</span>`;
    const cls = l.hasCapture ? '' : ' class="sl-invalid"';
    return `<li${cls}><span class="sl-coords">${r.latitude}, ${r.longitude}</span>`
      + `<span class="sl-surface">${r.type_surface || '—'}</span>${photo}</li>`;
  }).join('');
}

// Active/désactive l'envoi : seuls les posers AVEC photo sont valides.
function majSendModal() {
  const anyValid = flightLandings.some((l) => l.hasCapture);
  const st = $('send-status');
  st.className = 'modal-status';
  if (anyValid) { st.hidden = true; } else { st.textContent = t('sendNothing'); st.hidden = false; }
  $('btn-send-yes').disabled = !anyValid;
}

function closeSendModals() {
  $('send-overlay').hidden = true;
  $('discard-overlay').hidden = true;
  flightLandings = [];
  flightMeta = null;
}

// --- Boutons de la modale d'envoi ---
$('btn-send-yes').addEventListener('click', async () => {
  const st = $('send-status');
  $('btn-send-yes').disabled = true; $('btn-send-no').disabled = true;
  st.className = 'modal-status'; st.textContent = t('sending'); st.hidden = false;
  const res = await window.bc.envoyerTout({
    landings: flightLandings,
    flight: flightMeta,
    depIcao: ($('icao-dep') && $('icao-dep').value) || '',
    arrIcao: ($('icao-arr') && $('icao-arr').value) || '',
  });
  st.className = 'modal-status ' + (res.ok ? 'is-ok' : 'is-error');
  st.textContent = t('sendResult')
    .replace('{n}', res.envoyes ?? 0)
    .replace('{q}', res.enfiles ?? 0)
    .replace('{e}', res.echecs ?? 0);
  setTimeout(closeSendModals, 2800);
});

// « Ne pas envoyer » → confirmation.
$('btn-send-no').addEventListener('click', () => {
  $('send-overlay').hidden = true; $('discard-overlay').hidden = false;
});
$('btn-discard-cancel').addEventListener('click', () => {
  $('discard-overlay').hidden = true; $('send-overlay').hidden = false;
});
$('btn-discard-ok').addEventListener('click', async () => {
  await window.bc.flightDiscard();
  closeSendModals();
});

// --- File d'envoi hors-ligne : badge « en attente » ---
let lastQueueCount = 0;
function setQueueBadge(n) {
  lastQueueCount = n || 0;
  const b = $('queue-badge');
  if (lastQueueCount > 0) {
    b.textContent = t('queuePending').replace('{n}', lastQueueCount);
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}
window.bc.onQueueStatus((p) => setQueueBadge(p.restants));

// Clic sur le badge → relance manuelle de l'envoi de la file hors-ligne.
$('queue-badge').addEventListener('click', async () => {
  if (lastQueueCount <= 0) return;
  const b = $('queue-badge');
  b.classList.add('is-busy');
  try {
    const res = await window.bc.relancerFile();   // le main rediffuse le compte (onQueueStatus)
    if (res && typeof res.restants === 'number') setQueueBadge(res.restants);
  } finally {
    b.classList.remove('is-busy');
  }
});

// ============================================================
// Import des aéroports MSFS 2024 (même processus que NavXpressVFR).
// ============================================================
let _msfsChecking = false;
let _msfsExtracting = false;
let _msfsUnsubProgress = null;

function fmtMsDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function openMsfsConfirm() {
  const st = $('msfs-check-status');
  st.hidden = true; st.className = 'modal-status';
  $('btn-msfs-confirm-ok').disabled = false;
  $('btn-msfs-confirm-cancel').disabled = false;
  $('msfs-confirm-overlay').hidden = false;
}
function closeMsfsConfirm() {
  if (_msfsChecking) return;   // pas de fermeture pendant la vérification
  $('msfs-confirm-overlay').hidden = true;
}

function openMsfsProgress() {
  $('msfs-progress-bar-fill').style.width = '0%';
  $('msfs-progress-count').textContent = '0 / 0';
  $('msfs-progress-stats').textContent = '';
  const sum = $('msfs-progress-summary');
  sum.hidden = true; sum.className = 'modal-status';
  $('msfs-progress-phase').textContent = t('msfsPhaseConnecting');
  $('btn-msfs-progress-close').disabled = true;
  $('msfs-progress-overlay').hidden = false;
}
function closeMsfsProgress() {
  if (_msfsExtracting) return;   // pas de fermeture pendant l'extraction
  $('msfs-progress-overlay').hidden = true;
}

function setMsfsBar(pct) {
  $('msfs-progress-bar-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function handleMsfsProgress(p) {
  if (!p) return;
  if (p.phase === 'connect' || p.phase === 'connected') {
    $('msfs-progress-phase').textContent = t('msfsPhaseConnecting');
  } else if (p.phase === 'enumerate') {
    $('msfs-progress-phase').textContent = t('msfsPhaseEnumerate').replace('{n}', p.enumerated);
    if (p.totalPackets) setMsfsBar(Math.round((p.packet / p.totalPackets) * 100));
    $('msfs-progress-count').textContent = String(p.enumerated);
  } else if (p.phase === 'detail') {
    $('msfs-progress-phase').textContent = p.retry ? t('msfsPhaseRetry') : t('msfsPhaseDetail');
    if (p.target > 0) setMsfsBar(Math.round((p.treated / p.target) * 100));
    $('msfs-progress-count').textContent = `${p.treated} / ${p.target}`;
    $('msfs-progress-stats').textContent = t('msfsProgressStats')
      .replace('{rate}', Math.round(p.ratePerSec || 0))
      .replace('{eta}', fmtMsDuration(p.etaMs))
      .replace('{ok}', p.ok)
      .replace('{failed}', p.failed);
  } else if (p.phase === 'done') {
    setMsfsBar(100);
    $('msfs-progress-count').textContent = `${p.written} / ${p.enumerated}`;
  }
}

async function startMsfsExtraction() {
  if (_msfsExtracting) return;
  _msfsChecking = false;
  $('msfs-confirm-overlay').hidden = true;
  openMsfsProgress();

  _msfsExtracting = true;
  if (_msfsUnsubProgress) { try { _msfsUnsubProgress(); } catch (_) {} _msfsUnsubProgress = null; }
  _msfsUnsubProgress = window.bc.onMsfsExtractProgress(handleMsfsProgress);

  let result;
  try {
    result = await window.bc.msfsExtraireAeroports({ limit: 0 });
  } catch (err) {
    result = { ok: false, error: (err && err.message) || String(err) };
  }

  _msfsExtracting = false;
  if (_msfsUnsubProgress) { try { _msfsUnsubProgress(); } catch (_) {} _msfsUnsubProgress = null; }
  $('btn-msfs-progress-close').disabled = false;

  const sum = $('msfs-progress-summary');
  sum.hidden = false;
  if (result && result.ok && result.summary && result.summary.file) {
    sum.className = 'modal-status is-ok';
    sum.textContent = t('msfsExtractDone').replace('{n}', result.summary.written);
  } else if (result && result.ok && result.summary) {
    sum.className = 'modal-status is-warn';
    sum.textContent = t('msfsExtractEmpty');
  } else {
    sum.className = 'modal-status is-error';
    sum.textContent = t('msfsExtractError').replace('{msg}', (result && result.error) || '?');
  }
}

$('btn-msfs-confirm-cancel').addEventListener('click', closeMsfsConfirm);
$('btn-msfs-progress-close').addEventListener('click', closeMsfsProgress);
$('btn-msfs-confirm-ok').addEventListener('click', async () => {
  if (_msfsChecking) return;
  _msfsChecking = true;
  $('btn-msfs-confirm-ok').disabled = true;
  $('btn-msfs-confirm-cancel').disabled = true;
  const st = $('msfs-check-status');
  st.hidden = false; st.className = 'modal-status'; st.textContent = t('msfsCheckChecking');

  let res = { running: false };
  try { res = await window.bc.msfsVerifierLancement(); }
  catch (err) { res = { running: false, error: (err && err.message) || String(err) }; }

  _msfsChecking = false;
  $('btn-msfs-confirm-ok').disabled = false;
  $('btn-msfs-confirm-cancel').disabled = false;

  if (res && res.running) {
    st.className = 'modal-status is-ok';
    st.textContent = t('msfsCheckRunning').replace('{app}', res.app || 'MSFS');
    startMsfsExtraction();   // MSFS détecté → on enchaîne
  } else {
    st.className = 'modal-status is-error';
    st.textContent = t('msfsCheckNotRunning');
  }
});

// ============================================================
// Import des navaids MSFS 2024 (même processus que NavXpressVFR).
// Réutilise la vérification de lancement MSFS et la phase « connexion ».
// ============================================================
let _navaidsChecking = false;
let _navaidsExtracting = false;
let _navaidsUnsubProgress = null;

function openNavaidsConfirm() {
  const st = $('navaids-check-status');
  st.hidden = true; st.className = 'modal-status';
  $('btn-navaids-confirm-ok').disabled = false;
  $('btn-navaids-confirm-cancel').disabled = false;
  $('navaids-confirm-overlay').hidden = false;
}
function closeNavaidsConfirm() {
  if (_navaidsChecking) return;
  $('navaids-confirm-overlay').hidden = true;
}

function openNavaidsProgress() {
  $('navaids-progress-bar-fill').style.width = '0%';
  $('navaids-progress-count').textContent = '0 / 0';
  $('navaids-progress-stats').textContent = '';
  const sum = $('navaids-progress-summary');
  sum.hidden = true; sum.className = 'modal-status';
  $('navaids-progress-phase').textContent = t('msfsPhaseConnecting');
  $('btn-navaids-progress-close').disabled = true;
  $('navaids-progress-overlay').hidden = false;
}
function closeNavaidsProgress() {
  if (_navaidsExtracting) return;
  $('navaids-progress-overlay').hidden = true;
}

function setNavaidsBar(pct) {
  $('navaids-progress-bar-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function handleNavaidsProgress(p) {
  if (!p) return;
  if (p.phase === 'connect' || p.phase === 'connected') {
    $('navaids-progress-phase').textContent = t('msfsPhaseConnecting');
  } else if (p.phase === 'enumerate') {
    $('navaids-progress-phase').textContent = t('navaidsPhaseEnumerate').replace('{n}', p.enumerated);
    if (p.total) setNavaidsBar(Math.round((p.packet / p.total) * 100));
    $('navaids-progress-count').textContent = String(p.enumerated);
  } else if (['seed', 'bfs', 'vor', 'ndb', 'disco'].includes(p.phase)) {
    const label = { seed: 'navaidsPhaseSeed', bfs: 'navaidsPhaseBfs', vor: 'navaidsPhaseVor', ndb: 'navaidsPhaseNdb', disco: 'navaidsPhaseDisco' }[p.phase];
    $('navaids-progress-phase').textContent = t(label);
    if (p.target > 0) setNavaidsBar(Math.round((p.treated / p.target) * 100));
    $('navaids-progress-count').textContent = `${p.treated} / ${p.target}`;
    $('navaids-progress-stats').textContent = t('navaidsProgressStats')
      .replace('{nav}', p.navaids || 0)
      .replace('{wpt}', p.seeds || 0);
  } else if (p.phase === 'done') {
    setNavaidsBar(100);
  }
}

async function startNavaidsExtraction() {
  if (_navaidsExtracting) return;
  _navaidsChecking = false;
  $('navaids-confirm-overlay').hidden = true;
  openNavaidsProgress();

  _navaidsExtracting = true;
  if (_navaidsUnsubProgress) { try { _navaidsUnsubProgress(); } catch (_) {} _navaidsUnsubProgress = null; }
  _navaidsUnsubProgress = window.bc.onMsfsNavaidsProgress(handleNavaidsProgress);

  let result;
  try {
    result = await window.bc.msfsExtraireNavaids();
  } catch (err) {
    result = { ok: false, error: (err && err.message) || String(err) };
  }

  _navaidsExtracting = false;
  if (_navaidsUnsubProgress) { try { _navaidsUnsubProgress(); } catch (_) {} _navaidsUnsubProgress = null; }
  $('btn-navaids-progress-close').disabled = false;

  const sum = $('navaids-progress-summary');
  sum.hidden = false;
  if (result && result.ok && result.summary && result.summary.file) {
    sum.className = 'modal-status is-ok';
    sum.textContent = t('navaidsExtractDone').replace('{n}', result.summary.navaids);
  } else if (result && result.ok && result.summary) {
    sum.className = 'modal-status is-warn';
    sum.textContent = t('navaidsExtractEmpty');
  } else {
    sum.className = 'modal-status is-error';
    sum.textContent = t('navaidsExtractError').replace('{msg}', (result && result.error) || '?');
  }
}

$('btn-navaids-confirm-cancel').addEventListener('click', closeNavaidsConfirm);
$('btn-navaids-progress-close').addEventListener('click', closeNavaidsProgress);
$('btn-navaids-confirm-ok').addEventListener('click', async () => {
  if (_navaidsChecking) return;
  _navaidsChecking = true;
  $('btn-navaids-confirm-ok').disabled = true;
  $('btn-navaids-confirm-cancel').disabled = true;
  const st = $('navaids-check-status');
  st.hidden = false; st.className = 'modal-status'; st.textContent = t('msfsCheckChecking');

  let res = { running: false };
  try { res = await window.bc.msfsVerifierLancement(); }
  catch (err) { res = { running: false, error: (err && err.message) || String(err) }; }

  _navaidsChecking = false;
  $('btn-navaids-confirm-ok').disabled = false;
  $('btn-navaids-confirm-cancel').disabled = false;

  if (res && res.running) {
    st.className = 'modal-status is-ok';
    st.textContent = t('msfsCheckRunning').replace('{app}', res.app || 'MSFS');
    startNavaidsExtraction();
  } else {
    st.className = 'modal-status is-error';
    st.textContent = t('msfsCheckNotRunning');
  }
});

// ============================================================
// Panneau « Plan de vol » — tableau des legs (tiers droit de la carte).
// Une ligne par leg : départ, arrivée, cap magnétique (déclinaison locale du
// leg déjà appliquée, cf. declinaisonEn), distance. Double-clic sur le nom d'un
// point tournant → renommage en ligne, validé par Entrée puis répercuté sur la
// carte.
// ============================================================
let _legEditing = false;   // une cellule de nom est en cours d'édition

function legsPanelVisible() {
  const p = $('legs-panel');
  return p && !p.hidden;
}

// Distance formatée comme l'étiquette de leg (1 décimale sous 10 NM).
function formatDistNM(dNM) {
  return dNM >= 10 ? String(Math.round(dNM)) : dNM.toFixed(1);
}

// Construit les lignes de leg depuis un état de route (points + longitudes
// déroulées + points tournants). Réutilise exactement la géométrie de la carte.
function construireLegs(points, disp, wps) {
  const noms = nomsPointsTournants(wps);
  const depName = nettoyerIcao($('icao-dep').value) || '—';
  const arrName = nettoyerIcao($('icao-arr').value) || '—';
  const nomDe = (i) => (i === 0 ? depName : (i === points.length - 1 ? arrName : noms[i - 1]));
  // Index dans routeWaypoints (donc éditable) si le point est un point tournant.
  const wpIdxDe = (i) => (i >= 1 && i <= wps.length ? i - 1 : -1);
  const rows = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const capVrai = capVraiInitial(a.lat, disp[i], b.lat, disp[i + 1]);
    const decl = declinaisonEn((a.lat + b.lat) / 2, (disp[i] + disp[i + 1]) / 2);
    const capMag = Math.round(((capVrai - decl) % 360 + 360) % 360);
    rows.push({
      from: nomDe(i), to: nomDe(i + 1),
      fromWp: wpIdxDe(i), toWp: wpIdxDe(i + 1),
      capMag, decl, distNm: distanceNM(a.lat, disp[i], b.lat, disp[i + 1]),
      legIdx: i, alt: getLegAlt(i),
    });
  }
  return rows;
}

// Cellule de nom : éditable (data-wp) si c'est un point tournant, sinon simple.
function celluleNom(nom, wpIdx) {
  const cls = wpIdx >= 0 ? 'legs-name is-editable' : 'legs-name';
  const attr = wpIdx >= 0 ? ` data-wp="${wpIdx}"` : '';
  return `<td class="${cls}"${attr}>${escapeHtml(nom)}</td>`;
}

// (Re)construit le tableau depuis l'état courant validé de la route.
function rafraichirTableauLegs() {
  if (!legsPanelVisible() || _legEditing) return;   // édition en cours → ne pas écraser l'input
  const tbody = $('legs-tbody');
  const empty = $('legs-empty');
  const totalEl = $('legs-total-val');
  if (!tbody) return;
  if (!_routeDep || !_routeArr) {   // pas de dép./arr. résolus → rien à afficher
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
    if (totalEl) totalEl.textContent = '—';
    return;
  }
  const points = [_routeDep, ...routeWaypoints, _routeArr];
  const disp = deroulerLons(points);
  const rows = construireLegs(points, disp, routeWaypoints);
  if (empty) empty.hidden = rows.length > 0;
  if (totalEl) {
    const total = rows.reduce((s, r) => s + r.distNm, 0);
    totalEl.textContent = formatDistNM(total) + ' NM';
  }
  const actLeg = legActifClamp();
  tbody.innerHTML = rows.map((r) => {
    const cap = String(r.capMag).padStart(3, '0');
    const declTxt = (r.decl >= 0 ? '+' : '') + r.decl.toFixed(1);
    const hint = escapeHtml(t('legsDeclHint').replace('{d}', declTxt));
    const altTxt = `${r.alt} ft`;
    const rowCls = r.legIdx === actLeg ? ' class="leg-row-active"' : (r.legIdx < actLeg ? ' class="leg-row-past"' : '');
    return `<tr data-leg="${r.legIdx}"${rowCls}>${celluleNom(r.from, r.fromWp)}${celluleNom(r.to, r.toWp)}`
      + `<td class="legs-num" title="${hint}">${cap}°</td>`
      + `<td class="legs-num legs-alt is-editable" data-leg="${r.legIdx}">${altTxt}</td>`
      + `<td class="legs-num">${formatDistNM(r.distNm)}</td></tr>`;
  }).join('');
}

// Édition en ligne générique d'une cellule du tableau : Entrée valide (via
// onValider), Échap annule, la perte de focus annule. onValider fait la mise à
// jour de l'état ET le redessin approprié.
function editerCelluleTableau(td, { initial, maxLength, numeric, onValider }) {
  if (_legEditing) return;
  _legEditing = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'legs-cell-input';
  input.maxLength = maxLength;
  input.value = initial;
  if (numeric) { input.inputMode = 'numeric'; input.style.textAlign = 'right'; }
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  const finir = (valider) => {
    if (!_legEditing) return;
    _legEditing = false;
    if (valider) onValider(input.value);
    else rafraichirTableauLegs();   // annulation → restaure la cellule
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();   // n'atteint pas les raccourcis globaux (Échap ferme les menus)
    if (e.key === 'Enter') { e.preventDefault(); finir(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finir(false); }
  });
  input.addEventListener('blur', () => finir(false));
}

// Renommage d'un point tournant (met à jour la carte + le tableau).
function demarrerEditionNom(td) {
  const wpIdx = parseInt(td.dataset.wp, 10);
  if (!(wpIdx >= 0) || !routeWaypoints[wpIdx]) return;
  editerCelluleTableau(td, {
    initial: td.textContent, maxLength: 12, numeric: false,
    onValider: (raw) => {
      const v = raw.trim().slice(0, 12);
      const wp = routeWaypoints[wpIdx];
      if (wp) { if (v) wp.nom = v; else delete wp.nom; }   // vide → revient au nom auto (WPn/code)
      dessinerRoute();   // ré-étiquette la carte + reconstruit le tableau
    },
  });
}

// Altitude d'un leg (ft). Sans impact carte → simple rafraîchissement du tableau.
function demarrerEditionAlt(td) {
  const legIdx = parseInt(td.dataset.leg, 10);
  if (!(legIdx >= 0)) return;
  const cur = getLegAlt(legIdx);
  editerCelluleTableau(td, {
    initial: cur != null ? String(cur) : '', maxLength: 6, numeric: true,
    onValider: (raw) => {
      const digits = raw.replace(/[^\d]/g, '');
      setLegAlt(legIdx, digits === '' ? null : Math.min(60000, parseInt(digits, 10)));
      rafraichirTableauLegs();
      mettreAJourProfilVertical();   // l'altitude prévue change → re-échantillonne le profil
    },
  });
}

// Délégation : double-clic sur une cellule éditable (nom de point ou altitude).
$('legs-tbody').addEventListener('dblclick', (e) => {
  const nameTd = e.target.closest('td.legs-name.is-editable');
  if (nameTd) { demarrerEditionNom(nameTd); return; }
  const altTd = e.target.closest('td.legs-alt.is-editable');
  if (altTd) demarrerEditionAlt(altTd);
});

// Clic droit sur une ligne de leg → menu contextuel « rendre ce leg actif ».
$('legs-tbody').addEventListener('contextmenu', (e) => {
  const tr = e.target.closest('tr[data-leg]');
  if (!tr) return;
  e.preventDefault();
  const legIdx = parseInt(tr.dataset.leg, 10);
  if (!(legIdx >= 0)) return;
  ouvrirMenuContextuel(e.pageX, e.pageY, [
    { label: t('ctxSetActiveLeg'), action: () => forcerLegActif(legIdx) },
  ]);
});

// Ouverture / fermeture du panneau.
const legsBtn = $('btn-legs');
function ouvrirFermerLegs(ouvrir) {
  const panel = $('legs-panel');
  panel.hidden = !ouvrir;
  legsBtn.classList.toggle('is-active', ouvrir);
  legsBtn.setAttribute('aria-pressed', String(ouvrir));
  // Décale les contrôles Leaflet (haut-droite) hors du panneau tant qu'il est ouvert.
  document.querySelector('main').classList.toggle('legs-open', ouvrir);
  if (ouvrir) rafraichirTableauLegs();
  mettreAJourProfilVertical();   // la largeur de la bande profil change avec ce panneau
}
legsBtn.addEventListener('click', () => ouvrirFermerLegs($('legs-panel').hidden));
$('legs-close').addEventListener('click', () => ouvrirFermerLegs(false));

// ============================================================
// Profil vertical — relief GLOBE + altitudes prévues le long du plan.
// Adapté de NavXpressVFR : échantillonnage relief côté main (window.bc.profilVertical),
// dessin SVG côté renderer (aire relief + altitude prévue en escalier + altitude
// de sécurité par leg + survol). Se rafraîchit avec le plan et les altitudes.
// ============================================================
let _vpLast = null;   // dernier résultat (re-rendu au resize / basculement legs)
let _vpRender = null; // géométrie du dernier rendu (pour le survol)
let _vpSig = null;    // signature plan+altitudes (anti-recalcul)

function vpPanelVisible() {
  const p = $('vp-panel');
  return p && !p.hidden;
}

// Waypoints (dép. + points tournants + arr.) avec leurs noms, pour l'échantillonnage.
function vpWaypoints() {
  if (!_routeDep || !_routeArr) return [];
  const noms = nomsPointsTournants(routeWaypoints);
  const depName = nettoyerIcao($('icao-dep').value) || '';
  const arrName = nettoyerIcao($('icao-arr').value) || '';
  const pts = [_routeDep, ...routeWaypoints, _routeArr];
  return pts.map((p, i) => ({
    lat: p.lat, lon: p.lon,
    name: i === 0 ? depName : (i === pts.length - 1 ? arrName : noms[i - 1]),
  }));
}

// Altitudes au format du handler : legAlt[i] = altitude du leg wp[i-1] → wp[i].
// (backcountry : getLegAlt est 0-indexé par leg → décalage de 1.)
function vpLegAltitudes(nWps) {
  const arr = [null];
  for (let i = 1; i < nWps; i++) arr.push(getLegAlt(i - 1));
  return arr;
}

async function mettreAJourProfilVertical() {
  const host = $('vertical-profile-graph');
  if (!host || !vpPanelVisible()) return;

  const wps = vpWaypoints();
  if (wps.length < 2) {
    _vpLast = null; _vpSig = null;
    host.innerHTML = `<div class="vp-empty">${escapeHtml(t('vertProfileEmpty'))}</div>`;
    _vpMajHauteur();
    return;
  }
  const legAlt = vpLegAltitudes(wps.length);

  // Anti-recalcul : re-rend depuis le cache tant que plan + altitudes inchangés.
  const sig = JSON.stringify({ w: wps.map((p) => [p.lat, p.lon, p.name]), a: legAlt });
  if (sig === _vpSig && _vpLast) { _renderProfilInto(host, _vpLast); return; }

  let res;
  try { res = await window.bc.profilVertical({ waypoints: wps, legAltitudes: legAlt }); }
  catch (_) { return; }

  if (!res || !res.ok || !Array.isArray(res.dist) || res.dist.length < 2) {
    _vpLast = null; _vpSig = null;
    host.innerHTML = `<div class="vp-empty">${escapeHtml(t('vertProfileNoData'))}</div>`;
    _vpMajHauteur();
    return;
  }
  _vpLast = res; _vpSig = sig;
  _renderProfilInto(host, res);
}

function _renderProfilInto(host, res) {
  host.innerHTML = renderProfileSummary(res) + renderProfileSVG(res);
  _attachProfileHover(host);
  _vpMajHauteur();
}

// Publie la hauteur réelle du panneau profil dans --vp-h (sur <main>), pour que
// les contrôles Leaflet du bas (barre d'échelle) soient remontés juste au-dessus.
function _vpMajHauteur() {
  const panel = $('vp-panel');
  if (panel) document.querySelector('main').style.setProperty('--vp-h', panel.offsetHeight + 'px');
}

// Bandeau texte : point culminant de la route + marge mini réelle ; alerte si un
// leg passe sous son altitude de sécurité.
function renderProfileSummary(res) {
  const s = res && res.summary;
  if (!s) return '';
  let txt = `${t('vertProfileSummit')} ${s.summitFt} ft`;
  if (s.minMargin) txt += ` · ${t('vertProfileMinMargin')} ${s.minMargin.clearanceFt} ft`;
  const cls = s.anyBreach ? 'vp-summary vp-summary-warn' : 'vp-summary';
  return `<div class="${cls}">${escapeHtml(txt)}${s.anyBreach ? ' <i class="ph-light ph-warning" aria-hidden="true"></i>' : ''}</div>`;
}

function renderProfileSVG(res) {
  const host = $('vertical-profile-graph');
  const W = Math.max(320, (host && host.clientWidth) || 600);
  const H = 168;
  const m = { l: 46, r: 12, t: 12, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const dist = res.dist, terr = res.terrain, plan = res.planned;
  const totalNM = res.totalNM || dist[dist.length - 1] || 1;

  let yMax = 0;
  for (const v of terr) if (v > yMax) yMax = v;
  for (const v of plan) if (v > yMax) yMax = v;
  if (Array.isArray(res.legs)) for (const lg of res.legs) if (lg.safeAltFt > yMax) yMax = lg.safeAltFt;
  yMax = Math.max(1000, yMax * 1.12);
  yMax = Math.ceil(yMax / 500) * 500;

  const X = (d) => m.l + (d / totalNM) * iw;
  const Y = (ft) => m.t + ih - (Math.max(0, ft) / yMax) * ih;

  _vpRender = { W, H, m, iw, ih, yMax, totalNM, dist, terr, legs: res.legs };

  let area = `M ${X(dist[0]).toFixed(1)} ${Y(0).toFixed(1)}`;
  for (let i = 0; i < dist.length; i++) area += ` L ${X(dist[i]).toFixed(1)} ${Y(terr[i]).toFixed(1)}`;
  area += ` L ${X(dist[dist.length - 1]).toFixed(1)} ${Y(0).toFixed(1)} Z`;

  let tline = '';
  for (let i = 0; i < dist.length; i++) tline += (i ? ' L ' : 'M ') + X(dist[i]).toFixed(1) + ' ' + Y(terr[i]).toFixed(1);

  let pline = '';
  for (let i = 0; i < dist.length; i++) pline += (i ? ' L ' : 'M ') + X(dist[i]).toFixed(1) + ' ' + Y(plan[i]).toFixed(1);

  let safeLines = '', breachBands = '';
  if (Array.isArray(res.legs)) {
    for (const lg of res.legs) {
      const x0 = X(lg.dStart), x1 = X(lg.dEnd), ys = Y(lg.safeAltFt);
      if (lg.breach) {
        const yp = Y(lg.plannedFt);
        breachBands += `<rect x="${x0.toFixed(1)}" y="${ys.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" `
          + `height="${Math.max(0, yp - ys).toFixed(1)}" fill="#e53935" fill-opacity="0.22"/>`;
      }
      const col = lg.breach ? '#ff5252' : '#e53935';
      safeLines += `<line x1="${x0.toFixed(1)}" y1="${ys.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${ys.toFixed(1)}" stroke="${col}" stroke-width="1.6"/>`;
    }
  }

  let grid = '', ylabels = '';
  for (const yt of [0, yMax / 2, yMax]) {
    const yy = Y(yt).toFixed(1);
    grid += `<line x1="${m.l}" y1="${yy}" x2="${W - m.r}" y2="${yy}" stroke="#333" stroke-width="1"/>`;
    ylabels += `<text x="${m.l - 4}" y="${(Y(yt) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#999">${Math.round(yt)}</text>`;
  }

  let wpLines = '', wpLabels = '';
  const wps = res.waypoints || [];
  for (let i = 0; i < wps.length; i++) {
    const x = X(wps[i].d).toFixed(1);
    wpLines += `<line x1="${x}" y1="${m.t}" x2="${x}" y2="${m.t + ih}" stroke="#555" stroke-width="1" stroke-dasharray="2,3"/>`;
    const anchor = i === 0 ? 'start' : (i === wps.length - 1 ? 'end' : 'middle');
    const name = (wps[i].name || '').slice(0, 8);
    wpLabels += `<text x="${x}" y="${H - 14}" text-anchor="${anchor}" font-size="9" fill="#bbb">${escapeHtml(name)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" `
    + `style="background:#141414;border:1px solid #2d2d2d;border-radius:4px">`
    + grid + breachBands
    + `<path d="${area}" fill="#3f5230" fill-opacity="0.85"/>`
    + `<path d="${tline}" fill="none" stroke="#7d9b53" stroke-width="1.2"/>`
    + wpLines
    + `<path d="${pline}" fill="none" stroke="#ffb300" stroke-width="1.6" stroke-dasharray="6,3"/>`
    + safeLines
    + _vpLegend(W, m)
    + ylabels + wpLabels
    + `<text x="${m.l}" y="${m.t - 3}" font-size="9" fill="#777">ft</text>`
    + `</svg>`;
}

// Légende (relief / altitude prévue / sécurité) en haut à droite du graphe.
function _vpLegend(W, m) {
  const lx = W - m.r - 230, y = m.t + 6;
  return `<line x1="${lx}" y1="${y}" x2="${lx + 14}" y2="${y}" stroke="#7d9b53" stroke-width="2"/>`
    + `<text x="${lx + 18}" y="${y + 3}" font-size="9" fill="#999">${escapeHtml(t('vertProfileTerrain'))}</text>`
    + `<line x1="${lx + 70}" y1="${y}" x2="${lx + 84}" y2="${y}" stroke="#ffb300" stroke-width="2" stroke-dasharray="5,3"/>`
    + `<text x="${lx + 88}" y="${y + 3}" font-size="9" fill="#999">${escapeHtml(t('vertProfilePlanned'))}</text>`
    + `<line x1="${lx + 150}" y1="${y}" x2="${lx + 164}" y2="${y}" stroke="#e53935" stroke-width="2"/>`
    + `<text x="${lx + 168}" y="${y + 3}" font-size="9" fill="#999">${escapeHtml(t('vertProfileSafe'))}</text>`;
}

function _terrainAtDist(d) {
  if (!_vpRender) return null;
  const { dist, terr } = _vpRender;
  if (!dist || !terr || dist.length === 0) return null;
  const n = dist.length;
  if (d <= dist[0]) return terr[0];
  if (d >= dist[n - 1]) return terr[n - 1];
  for (let i = 1; i < n; i++) {
    if (d <= dist[i]) {
      const span = (dist[i] - dist[i - 1]) || 1;
      return terr[i - 1] + (terr[i] - terr[i - 1]) * ((d - dist[i - 1]) / span);
    }
  }
  return terr[n - 1];
}

function _legAtDist(d) {
  if (!_vpRender || !Array.isArray(_vpRender.legs)) return null;
  const legs = _vpRender.legs;
  for (const lg of legs) if (d >= lg.dStart && d <= lg.dEnd) return lg;
  return legs.length ? legs[legs.length - 1] : null;
}

function _attachProfileHover(host) {
  if (!host || !_vpRender) return;
  const svg = host.querySelector('svg');
  if (!svg) return;
  host.style.position = 'relative';

  const tip = document.createElement('div');
  tip.className = 'vp-terrain-tooltip';
  tip.style.cssText = 'position:absolute;display:none;pointer-events:none;z-index:5;'
    + 'background:#1a1a1a;border:1px solid #555;color:#ddd;font-size:11px;line-height:1.35;'
    + 'padding:3px 7px;border-radius:4px;white-space:nowrap;transform:translate(-50%,-130%);';
  host.appendChild(tip);

  const { W, H, m, iw, ih, yMax, totalNM } = _vpRender;
  const Yof = (ft) => m.t + ih - (Math.max(0, ft) / yMax) * ih;

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const sx = (ev.clientX - rect.left) * (W / rect.width);
    const sy = (ev.clientY - rect.top) * (H / rect.height);
    const bottomY = m.t + ih;
    if (sx < m.l || sx > W - m.r || sy < m.t || sy > bottomY + 1) { tip.style.display = 'none'; return; }

    let d = ((sx - m.l) / iw) * totalNM;
    if (d < 0) d = 0; else if (d > totalNM) d = totalNM;

    const lg = _legAtDist(d);
    let html = '';
    if (lg) html += `<span style="color:#ff7b72">${escapeHtml(t('vertProfileSafeFull'))} : ${lg.safeAltFt} ft</span>`;
    if (lg && Math.abs(sy - Yof(lg.plannedFt)) <= 4) {
      html += `${html ? '<br>' : ''}<span style="color:#ffb300">${escapeHtml(t('vertProfilePlannedFull'))} : ${lg.plannedFt} ft</span>`;
    }
    const elev = _terrainAtDist(d);
    if (elev != null && sy >= Yof(elev) - 1) {
      html += `${html ? '<br>' : ''}<span style="color:#cfe0b4">${escapeHtml(t('vertProfileGround'))} ${Math.round(elev)} ft</span>`;
    }
    if (!html) { tip.style.display = 'none'; return; }
    tip.innerHTML = html;
    tip.style.left = ((sx / W) * rect.width) + 'px';
    tip.style.top = ((sy / H) * rect.height) + 'px';
    tip.style.display = 'block';
  }
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

// Re-rendu (depuis le cache) au redimensionnement de la fenêtre.
let _vpResizeTO = null;
window.addEventListener('resize', () => {
  clearTimeout(_vpResizeTO);
  _vpResizeTO = setTimeout(() => {
    const host = $('vertical-profile-graph');
    if (host && vpPanelVisible() && _vpLast) _renderProfilInto(host, _vpLast);
  }, 200);
});

// Ouverture / fermeture du panneau du profil vertical.
const profilBtn = $('btn-profil');
function ouvrirFermerProfil(ouvrir) {
  const panel = $('vp-panel');
  panel.hidden = !ouvrir;
  profilBtn.classList.toggle('is-active', ouvrir);
  profilBtn.setAttribute('aria-pressed', String(ouvrir));
  // Remonte les contrôles Leaflet du bas (barre d'échelle) au-dessus de la bande profil.
  document.querySelector('main').classList.toggle('profil-open', ouvrir);
  if (ouvrir) mettreAJourProfilVertical();
}
profilBtn.addEventListener('click', () => ouvrirFermerProfil($('vp-panel').hidden));
$('vp-close').addEventListener('click', () => ouvrirFermerProfil(false));

// --- Bouton-icône d'import + menu déroulant (aéroports / navaids) ---
const importBtn = $('btn-import');
const importDropdown = $('import-dropdown');
function fermerImportMenu() {
  importDropdown.hidden = true;
  importBtn.setAttribute('aria-expanded', 'false');
}
importBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const ouvrir = importDropdown.hidden;
  importDropdown.hidden = !ouvrir;
  importBtn.setAttribute('aria-expanded', String(ouvrir));
});
importDropdown.addEventListener('click', (e) => e.stopPropagation());   // clic dans le menu ne le ferme pas
document.addEventListener('click', () => { if (!importDropdown.hidden) fermerImportMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerImportMenu(); });
$('menu-import-airports').addEventListener('click', () => { fermerImportMenu(); openMsfsConfirm(); });
$('menu-import-navaids').addEventListener('click', () => { fermerImportMenu(); openNavaidsConfirm(); });
$('menu-import-elevation').addEventListener('click', () => { fermerImportMenu(); onElevImportClick(); });

// ============================================================
// Import des données d'élévation (GLOBE all10g.zip) — repris de NavXpressVFR.
// Téléchargement direct (pas de SimConnect) : clic → confirmation si déjà
// présent, sinon import ; modale de progression (download / extract / flatten).
// ============================================================
let _elevImporting = false;
let _elevUnsubProgress = null;

function fmtMo(bytes) { return (bytes / (1024 * 1024)).toFixed(1) + ' Mo'; }

function openElevProgress() {
  $('elev-progress-bar-fill').style.width = '0%';
  $('elev-progress-size').textContent = '—';
  const sum = $('elev-progress-summary');
  sum.hidden = true; sum.className = 'modal-status'; sum.textContent = '';
  $('elev-progress-phase').textContent = t('elevPhaseStarting');
  $('btn-elev-progress-close').disabled = true;
  $('elev-progress-overlay').hidden = false;
}
function closeElevProgress() {
  if (_elevImporting) return;   // pas de fermeture pendant l'import
  $('elev-progress-overlay').hidden = true;
}

function handleElevProgress(p) {
  if (!p) return;
  const fill = $('elev-progress-bar-fill');
  const size = $('elev-progress-size');
  if (p.type === 'start') {
    $('elev-progress-phase').textContent = t('elevPhaseStarting');
    fill.style.width = '0%';
  } else if (p.type === 'download') {
    $('elev-progress-phase').textContent = t('elevPhaseDownloading');
    if (p.total) {
      const pct = Math.round((p.received / p.total) * 100);
      fill.style.width = pct + '%';
      size.textContent = `${fmtMo(p.received)} / ${fmtMo(p.total)} (${pct} %)`;
    } else {
      fill.style.width = '100%';
      size.textContent = fmtMo(p.received);
    }
  } else if (p.type === 'extract') {
    $('elev-progress-phase').textContent = t('elevPhaseExtracting');
    fill.style.width = '100%';
    size.textContent = '';
  } else if (p.type === 'flatten') {
    $('elev-progress-phase').textContent = t('elevPhaseFlattening');
    fill.style.width = '100%';
  } else if (p.type === 'done') {
    $('elev-progress-phase').textContent = '';
    fill.style.width = '100%';
    const sum = $('elev-progress-summary');
    sum.hidden = false;
    sum.className = 'modal-status ' + (p.ok ? 'is-ok' : 'is-warn');
    sum.textContent = t('elevProgressDone') + ' ' + t('elevProgressDoneDir').replace('{dir}', p.dir || '');
    $('btn-elev-progress-close').disabled = false;
  } else if (p.type === 'error') {
    $('elev-progress-phase').textContent = '';
    const sum = $('elev-progress-summary');
    sum.hidden = false;
    sum.className = 'modal-status is-error';
    sum.textContent = t('elevProgressError') + ' — ' + (p.error || '');
    $('btn-elev-progress-close').disabled = false;
  }
}

async function startElevImport() {
  if (_elevImporting) return;
  _elevImporting = true;
  openElevProgress();
  if (_elevUnsubProgress) { try { _elevUnsubProgress(); } catch (_) {} _elevUnsubProgress = null; }
  _elevUnsubProgress = window.bc.onElevationProgress(handleElevProgress);
  let res;
  try { res = await window.bc.importerElevation(); }
  catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }
  _elevImporting = false;
  if (_elevUnsubProgress) { try { _elevUnsubProgress(); } catch (_) {} _elevUnsubProgress = null; }
  $('btn-elev-progress-close').disabled = false;
  // Filet de sécurité si aucun event 'done'/'error' n'a été reçu.
  const sum = $('elev-progress-summary');
  if (sum.hidden && res && !res.ok) {
    sum.hidden = false; sum.className = 'modal-status is-error';
    sum.textContent = t('elevProgressError') + ' — ' + (res.error || '');
  }
}

async function onElevImportClick() {
  let existe = false;
  try { existe = await window.bc.elevationExiste(); } catch (_) {}
  if (existe) $('elev-confirm-overlay').hidden = false;   // déjà présent → confirmer le ré-import
  else startElevImport();
}

$('btn-elev-confirm-cancel').addEventListener('click', () => { $('elev-confirm-overlay').hidden = true; });
$('btn-elev-confirm-ok').addEventListener('click', () => { $('elev-confirm-overlay').hidden = true; startElevImport(); });
$('btn-elev-progress-close').addEventListener('click', closeElevProgress);

// Initialisation : applique la langue courante, puis l'état initial.
initI18n();
initMap();
setStatus('disconnected');
majBoutonsPlan();   // bouton « sauvegarder » désactivé tant que dép.+arr. absents
window.bc.getConfig().then((cfg) => {
  lastConfig = cfg;
  renderApiHint();
});
window.bc.etatFile().then((p) => setQueueBadge(p.restants));
