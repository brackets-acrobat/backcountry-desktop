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

// (Re)dessine le bloc de statut + le libellé du bouton dans la langue courante.
function renderStatus() {
  const dot = $('status-dot');
  const txt = $('status-text');
  const btn = $('btn-connect');
  dot.className = 'dot';
  const detail = lastStatusDetail ? ` · ${lastStatusDetail}` : '';

  if (lastStatusState === 'connected') {
    dot.classList.add('dot-on');
    txt.textContent = t('statusConnected') + detail;
    btn.innerHTML = '<i class="ph-light ph-plugs-connected"></i> ' + t('btnDisconnect');
    connecte = true;
  } else if (lastStatusState === 'connecting') {
    dot.classList.add('dot-wait');
    txt.textContent = t('statusConnecting');
  } else {
    dot.classList.add('dot-off');
    txt.textContent = t('statusDisconnected') + detail;
    btn.innerHTML = '<i class="ph-light ph-plugs"></i> ' + t('btnConnect');
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
function boolTxt(b) { return b ? t('yes') : t('no'); }

function viderScan() {
  ['v-lat','v-lon','v-amsl','v-agl','v-ground','v-gs','v-hdg','v-surf','v-cond','v-ground-flag','v-brake']
    .forEach((id) => { $(id).textContent = '—'; });
}

function majScan(f) {
  $('v-lat').textContent = fmt(f.lat, 5);
  $('v-lon').textContent = fmt(f.lon, 5);
  $('v-amsl').textContent = fmt(f.amslFt);
  $('v-agl').textContent = fmt(f.aglFt);
  $('v-ground').textContent = fmt(f.groundAltFt);
  $('v-gs').textContent = fmt(f.groundSpeedKt, 1);
  $('v-hdg').textContent = fmt(f.headingTrue);
  $('v-surf').textContent = f.surfaceTypeLabel || '—';
  $('v-cond').textContent = f.surfaceCondLabel || '—';
  $('v-ground-flag').textContent = boolTxt(f.onGround);
  $('v-brake').textContent = boolTxt(f.parkingBrake);
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

// Initialisation : applique la langue courante, puis l'état initial.
initI18n();
setStatus('disconnected');
window.bc.getConfig().then((cfg) => {
  lastConfig = cfg;
  renderApiHint();
});
window.bc.etatFile().then((p) => setQueueBadge(p.restants));
