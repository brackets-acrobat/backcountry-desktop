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
let suivreAvion = true;   // recentrage auto tant que l'utilisateur n'a pas déplacé la carte

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([46.8, 2.5], 5);  // vue par défaut (France)
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap',
  }).addTo(map);
  map.on('dragstart', () => { suivreAvion = false; });   // l'utilisateur explore → on cesse de suivre
}

function majCarte(f) {
  if (!map || typeof f.lat !== 'number' || typeof f.lon !== 'number'
      || !isFinite(f.lat) || !isFinite(f.lon)) return;
  const ll = [f.lat, f.lon];
  if (!planeMarker) {
    planeMarker = L.marker(ll).addTo(map);
    map.setView(ll, 13);   // premier point : on cadre sur l'avion
  } else {
    planeMarker.setLatLng(ll);
    if (suivreAvion) map.panTo(ll);
  }
}

function viderScan() {
  ['b-lat','b-lon','b-amsl'].forEach((id) => { $(id).textContent = '—'; });
  if (map && planeMarker) { map.removeLayer(planeMarker); planeMarker = null; }
  suivreAvion = true;
}

function majScan(f) {
  $('b-lat').textContent = fmt(f.lat, 5);
  $('b-lon').textContent = fmt(f.lon, 5);
  $('b-amsl').textContent = fmt(f.amslFt);
  majCarte(f);
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

// Toggle FR / EN : change la langue puis ré-applique les textes dynamiques
// (les libellés statiques sont gérés par applyTranslations() dans setLanguage).
$('btn-lang-toggle').addEventListener('click', () => {
  setLanguage(currentLang === 'fr' ? 'en' : 'fr');
  renderStatus();
  renderApiHint();
  setQueueBadge(lastQueueCount);
});

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
window.bc.onFlightEnded(({ landings }) => {
  flightLandings = (landings || []).map((l) => ({ ...l }));
  renderSendList();
  majSendModal();
  $('btn-send-no').disabled = false;
  $('discard-overlay').hidden = true;
  $('send-overlay').hidden = false;
});

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
}

// --- Boutons de la modale d'envoi ---
$('btn-send-yes').addEventListener('click', async () => {
  const st = $('send-status');
  $('btn-send-yes').disabled = true; $('btn-send-no').disabled = true;
  st.className = 'modal-status'; st.textContent = t('sending'); st.hidden = false;
  const res = await window.bc.envoyerTout(flightLandings);
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

// Initialisation : applique la langue courante, puis l'état initial.
initI18n();
initMap();
setStatus('disconnected');
window.bc.getConfig().then((cfg) => {
  lastConfig = cfg;
  renderApiHint();
});
window.bc.etatFile().then((p) => setQueueBadge(p.restants));
