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
    $('rec-banner').hidden = true;   // plus de flux → on masque l'enregistrement
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
});

window.bc.onStatus((s) => {
  if (s.state) setStatus(s.state, s.app || s.error || s.warn);
});
window.bc.onScan((f) => majScan(f));

// ============================================================
// Jalon 2 — relevé du poser : bandeau d'enregistrement + modales.
// ============================================================
const FT_PER_M = 3.280839895;
let currentReleve = null;   // payload assemblé par la FSM, en attente de décision
let currentUid = null;

function showRecBanner(samples, distM) {
  $('rec-banner-text').textContent = t('recBanner')
    .replace('{n}', samples ?? 0)
    .replace('{d}', distM ?? 0);
  $('rec-banner').hidden = false;
}

// Construit la liste des champs du relevé dans la modale (libellés traduits).
function renderSaveFields(uid, r) {
  const ft = (m) => (m == null ? '—' : Math.round(m * FT_PER_M) + ' ft');
  const rows = [
    [t('fldId'), uid.slice(0, 8)],
    [t('fldDate'), r.date_releve || '—'],
    [t('lblLat'), r.latitude],
    [t('lblLon'), r.longitude],
    [t('fldAvgAlt'), ft(r.altitude_m)],
    [t('fldType'), r.type_surface || '—'],
    [t('fldCond'), r.etat_surface || '—'],
    [t('fldHeading'), r.cap_moyen_deg == null ? '—' : r.cap_moyen_deg + ' °'],
    [t('fldElev'), ft(r.denivele_m)],
    [t('fldSlope'), (r.pente_max_pct ?? 0) + ' %'],
    [t('fldSamples'), (r.profil_relief || []).length],
  ];
  $('save-fields').innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
}

function openSaveModal() {
  const st = $('save-status');
  st.hidden = true;
  st.className = 'modal-status';
  $('btn-save-yes').disabled = false;
  $('btn-save-no').disabled = false;
  $('confirm-overlay').hidden = true;
  $('save-overlay').hidden = false;
}

function closeAllModals() {
  $('save-overlay').hidden = true;
  $('confirm-overlay').hidden = true;
  currentReleve = null;
  currentUid = null;
}

// --- Événements FSM (main → renderer) ---
window.bc.onTouchdown(() => showRecBanner(0, 0));
window.bc.onProgress((p) => showRecBanner(p.samples, p.distM));
window.bc.onAwaitingDecision(({ uid, releve }) => {
  currentReleve = releve;
  currentUid = uid;
  $('rec-banner').hidden = true;
  renderSaveFields(uid, releve);
  openSaveModal();
});

// --- Boutons de la modale ---
$('btn-save-yes').addEventListener('click', async () => {
  if (!currentReleve) return;
  const st = $('save-status');
  $('btn-save-yes').disabled = true;
  $('btn-save-no').disabled = true;
  st.className = 'modal-status';
  st.textContent = t('sending');
  st.hidden = false;

  const res = await window.bc.envoyerReleve(currentReleve);
  if (res.ok) {
    const idLieu = res.body && res.body.id_lieu;
    const nouveau = res.body && res.body.nouveau_lieu ? t('sendNewPlace') : '';
    st.className = 'modal-status is-ok';
    st.textContent = t('sendOk').replace('{id}', idLieu ?? '?').replace('{new}', nouveau);
    setTimeout(closeAllModals, 2200);   // la FSM est déjà reset côté main
  } else {
    const err = (res.body && (res.body.erreur || res.body.brut)) || ('HTTP ' + res.status);
    st.className = 'modal-status is-error';
    st.textContent = t('sendErr').replace('{err}', err);
    $('btn-save-yes').disabled = false;
    $('btn-save-no').disabled = false;
  }
});

// « Ne pas enregistrer » → demande de confirmation
$('btn-save-no').addEventListener('click', () => {
  $('save-overlay').hidden = true;
  $('confirm-overlay').hidden = false;
});
$('btn-confirm-cancel').addEventListener('click', () => {
  $('confirm-overlay').hidden = true;
  $('save-overlay').hidden = false;
});
$('btn-confirm-discard').addEventListener('click', async () => {
  await window.bc.effacerReleve();
  closeAllModals();
});

// Initialisation : applique la langue courante, puis l'état initial.
initI18n();
setStatus('disconnected');
window.bc.getConfig().then((cfg) => {
  lastConfig = cfg;
  renderApiHint();
});
