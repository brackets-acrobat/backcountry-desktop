/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// recherche-lieux.js — trouver un aérodrome ou un navaid, et l'afficher.
//
// Le bouton « Rechercher » (à droite de la connexion MSFS) ouvre une modale : on
// tape un code OACI ou un nom, la liste se met à jour à la frappe, et choisir un
// résultat cadre la carte dessus.
//
// ── Le périmètre est décidé côté main ───────────────────────────────────────
// airports-data.js indexe les bases MSFS extraites en entier, monde compris. Ce
// fichier ne filtre rien : il affiche ce qu'on lui donne, dans la limite du
// nombre de résultats que main lui renvoie.
//
// ── Ce que voir un résultat veut dire ───────────────────────────────────────
// Les couches MSFS ne s'affichent qu'au zoom 8 et seulement si le pilote les a
// allumées : cadrer sans plus poserait le point trouvé au milieu d'une carte où
// rien ne le désigne. On dépose donc un repère vert (la couleur d'accent de
// l'application), effacé au clic suivant sur la carte. Les réglages de couches
// du pilote, eux, ne sont pas touchés — ce sont les siens.
// ============================================================

const RECHERCHE_DELAI_MS = 160;   // frappe → requête (une requête par mot, pas par lettre)
const RECHERCHE_ZOOM = 12;        // au-delà du seuil des couches MSFS (8)

let _rechDelai = null;        // minuteur de la frappe
let _rechReqId = 0;           // n° de requête (les réponses peuvent se croiser)
let _rechListe = [];          // derniers résultats affichés
let _rechIdx = -1;            // résultat sous le curseur clavier
let _rechMarqueur = null;     // repère sur la carte
let _rechEffaceur = null;     // écouteur « le prochain clic efface le repère »

// ------------------------------------------------------------
// Le repère sur la carte
// ------------------------------------------------------------

function effacerRepereRecherche() {
  if (_rechMarqueur) { map.removeLayer(_rechMarqueur); _rechMarqueur = null; }
  if (_rechEffaceur) { map.off('click', _rechEffaceur); _rechEffaceur = null; }
}

// Anneau vert à cœur blanc, dans la couleur d'accent de l'application. Non
// interactif — il ne doit pas avaler le clic destiné à la carte, ni celui qui
// l'efface.
function poserRepereRecherche(lat, lon) {
  effacerRepereRecherche();
  _rechMarqueur = L.circleMarker([lat, lon], {
    radius: 9, color: '#3af24b', weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false,
  }).addTo(map);
  _rechEffaceur = () => effacerRepereRecherche();
  map.on('click', _rechEffaceur);
}

// ------------------------------------------------------------
// Rendu de la liste
// ------------------------------------------------------------

// Libellé du type. Les aérodromes réutilisent les libellés des couches (menu de
// la carte) ; les navaids portent déjà leur type en clair (VOR-DME, NDB…).
function typeLieu(l) {
  if (l.genre === 'navaid') return l.type || '';
  if (l.type === 'heliport') return t('layerHeliports');
  if (l.type === 'seaplane_base') return t('layerSeaplanes');
  return t('layerAirports');
}

// Seconde ligne : ce qui aide à reconnaître le bon terrain parmi trois du même
// nom — la piste et l'altitude pour un aérodrome, la fréquence et la portée pour
// un navaid. formatNavaidFreq vient du socle (renderer.js).
function detailLieu(l) {
  const bouts = [typeLieu(l)];
  if (l.genre === 'navaid') {
    bouts.push(formatNavaidFreq(l.type, l.freqKhz));
    if (Number.isFinite(l.rangeNm)) bouts.push(l.rangeNm + ' NM');
  } else {
    if (l.runway) bouts.push(t('searchRunway') + ' ' + l.runway.name);
    if (Number.isFinite(l.elevation_ft)) bouts.push(l.elevation_ft + ' ft');
  }
  return bouts.filter(Boolean).join(' · ');
}

function rendreListeRecherche() {
  const hote = $('recherche-liste');
  hote.innerHTML = _rechListe.map((l, i) => `
    <button type="button" class="recherche-item${i === _rechIdx ? ' est-vise' : ''}" data-i="${i}" role="option">
      <span class="recherche-code">${escapeHtml(l.code)}</span>
      <span class="recherche-nom">${escapeHtml(l.name)}</span>
      <span class="recherche-detail">${escapeHtml(detailLieu(l))}</span>
    </button>`).join('');
}

// Message au-dessus de la liste : ce que la recherche a trouvé, ou pourquoi elle
// n'a rien à dire. Chaque cas se corrige différemment, donc chacun se dit.
function etatRecherche(cle, remplacements) {
  const el = $('recherche-etat');
  if (!cle) { el.textContent = ''; el.className = 'recherche-etat'; return; }
  let txt = t(cle);
  for (const [k, v] of Object.entries(remplacements || {})) txt = txt.replace('{' + k + '}', v);
  el.textContent = txt;
  el.className = 'recherche-etat' + (cle === 'searchNoData' ? ' est-avert' : '');
}

// ------------------------------------------------------------
// La requête
// ------------------------------------------------------------

async function lancerRecherche() {
  const q = $('recherche-input').value;
  const reqId = ++_rechReqId;

  let res;
  try { res = await window.bc.rechercherLieux(q); } catch (_) { res = { ok: false, reason: 'error' }; }
  if (reqId !== _rechReqId) return;   // une frappe plus récente a déjà répondu

  if (!res || !res.ok) {
    _rechListe = [];
    _rechIdx = -1;
    rendreListeRecherche();
    // « Trop court » n'est pas une erreur : c'est l'état normal au départ.
    etatRecherche(res && res.reason === 'too-short' ? 'searchTooShort'
      : res && res.reason === 'no-data' ? 'searchNoData' : 'searchError');
    return;
  }

  _rechListe = res.lieux;
  _rechIdx = _rechListe.length ? 0 : -1;   // le premier est visé : Entrée y va directement
  rendreListeRecherche();

  if (!_rechListe.length) etatRecherche('searchNone');
  else if (res.tronque) etatRecherche('searchCountTruncated', { n: _rechListe.length, total: res.total });
  else etatRecherche('searchCount', { n: res.total });
}

function planifierRecherche() {
  if (_rechDelai) clearTimeout(_rechDelai);
  _rechDelai = setTimeout(lancerRecherche, RECHERCHE_DELAI_MS);
}

// ------------------------------------------------------------
// Choisir un résultat
// ------------------------------------------------------------

// Centre de carte à viser pour que le point trouvé apparaisse au milieu de la
// partie VISIBLE : le conteneur court sous le panneau « Plan de vol », qui en
// couvre le tiers droit quand il est ouvert. Même compensation que celle de
// centrerSurRoute().
function _rechCentreVisible(latlng) {
  const dx = legsPanelVisible() ? $('legs-panel').getBoundingClientRect().width / 2 : 0;
  if (!dx) return latlng;
  const p = map.latLngToContainerPoint(latlng);
  return map.containerPointToLatLng([p.x + dx, p.y]);
}

function allerAuLieu(l) {
  if (!l || !map) return;
  fermerRecherche();
  // Zoom d'abord, décalage ensuite : la correction du panneau se calcule en
  // pixels, donc au zoom d'arrivée.
  map.setView([l.lat, l.lon], Math.max(map.getZoom(), RECHERCHE_ZOOM));
  map.panTo(_rechCentreVisible(L.latLng(l.lat, l.lon)), { animate: false });
  poserRepereRecherche(l.lat, l.lon);
}

// ------------------------------------------------------------
// Ouverture / fermeture
// ------------------------------------------------------------

function ouvrirRecherche() {
  $('recherche-overlay').hidden = false;
  $('recherche-input').value = '';
  _rechListe = [];
  _rechIdx = -1;
  rendreListeRecherche();
  etatRecherche('searchTooShort');
  $('recherche-input').focus();
}

function fermerRecherche() {
  $('recherche-overlay').hidden = true;
  if (_rechDelai) { clearTimeout(_rechDelai); _rechDelai = null; }
}

// Déplace le curseur clavier et garde la ligne visée dans la fenêtre de la liste.
function viserRecherche(delta) {
  if (!_rechListe.length) return;
  _rechIdx = (_rechIdx + delta + _rechListe.length) % _rechListe.length;
  rendreListeRecherche();
  const vise = $('recherche-liste').querySelector('.recherche-item.est-vise');
  if (vise) vise.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------
// Câblage
// ------------------------------------------------------------

$('btn-recherche').addEventListener('click', ouvrirRecherche);
$('btn-recherche-fermer').addEventListener('click', fermerRecherche);

$('recherche-input').addEventListener('input', planifierRecherche);

$('recherche-input').addEventListener('keydown', (e) => {
  e.stopPropagation();   // n'atteint pas les raccourcis globaux
  if (e.key === 'ArrowDown') { e.preventDefault(); viserRecherche(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); viserRecherche(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); allerAuLieu(_rechListe[_rechIdx]); }
  else if (e.key === 'Escape') { e.preventDefault(); fermerRecherche(); }
});

// Un seul écouteur sur le conteneur : il survit au re-rendu de la liste.
$('recherche-liste').addEventListener('click', (e) => {
  const item = e.target.closest('.recherche-item');
  if (item) allerAuLieu(_rechListe[+item.dataset.i]);
});

// Cliquer le voile (hors de la boîte) ferme — comme on attend d'une modale.
$('recherche-overlay').addEventListener('click', (e) => {
  if (e.target === $('recherche-overlay')) fermerRecherche();
});
