/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// i18n.js — système de traductions bilingue FR / EN.
// Repris du mécanisme de NavXpressVFR : dictionnaire TRANSLATIONS,
// langue persistée (localStorage), application via attributs data-i18n
// (textContent), data-i18n-html (innerHTML), data-i18n-placeholder, data-i18n-title.
//
// CONVENTION : toute nouvelle chaîne d'UI ajoute sa clé dans fr ET en
// (jamais de texte en dur dans le HTML — sauf noms propres).
// ============================================================

const TRANSLATIONS = {
  fr: {
    statusConnected: 'Connecté',
    statusConnecting: 'Connexion…',
    statusDisconnected: 'MSFS Déconnecté',
    btnConnect: 'Connecter MSFS2024',
    btnDisconnect: 'Déconnecter MSFS2024',
    toggleTitle: 'Changer de langue / Switch language',

    // Second bandeau de données live
    lblLat: 'Latitude',
    lblLon: 'Longitude',
    lblAmsl: 'Altitude MSL',

    // Jalon 2 — relevé du poser
    recBanner: 'Poser détecté — enregistrement en cours… ({n} pts · {d} m)',
    fldId: 'Identifiant du poser',
    fldDate: 'Date (heure sim locale)',
    fldAvgAlt: 'Altitude moyenne du terrain',
    fldType: 'Type de sol',
    fldCond: 'État du sol',
    fldHeading: 'Cap moyen au poser',
    fldElev: 'Dénivelé',
    fldSlope: 'Pente max',
    fldAircraft: 'Aéronef',
    fldCapture: 'Capture',
    fldSamples: 'Échantillons de relief',
    btnRecapture: 'Refaire la photo',
    captureUnavailable: 'Capture indisponible',
    sendQueued: 'Hors-ligne — poser mis en file, renvoi automatique plus tard.',
    queuePending: '{n} poser(s) en attente d\'envoi',
    queueRetryTitle: 'Cliquer pour réessayer l\'envoi maintenant',

    // Jalon 4 — capture manuelle + envoi groupé fin de vol
    btnCapture: 'Capture d\'écran',
    captureTitle: 'Capture d\'écran du spot',
    captureWarn: 'Cadrez l\'image que vous souhaitez capturer dans MSFS 2024. Une fois prêt, cliquez sur le bouton Capture. Attention : si vous ne prenez pas de capture d\'écran, votre atterrissage ne sera pas enregistré sur le site.',
    btnCaptureDo: 'Capture',
    btnClose: 'Fermer',
    captureSaved: 'Capture enregistrée ✓',
    captureErr: 'Échec de la capture : {err}',
    sendTitle: 'Envoyer les posers du vol ?',
    sendIntro: 'Vol terminé. Voici les posers relevés pendant ce vol :',
    btnSend: 'Envoyer',
    btnDontSend: 'Ne pas envoyer',
    discardTitle: 'Ne pas envoyer ?',
    discardText: 'Les posers de ce vol ne seront pas envoyés au site. Les photos restent enregistrées en local.',
    listPhotoYes: 'photo ✓',
    listPhotoNo: 'sans photo',
    listNoSend: 'sans photo — non envoyé',
    sendNothing: 'Aucun poser avec photo : rien à envoyer.',
    sendResult: 'Envoyés : {n} · En file : {q} · Échecs : {e}',
    modalSaveTitle: 'Enregistrer ce poser ?',
    btnSaveYes: 'Enregistrer',
    btnSaveNo: 'Ne pas enregistrer',
    modalConfirmTitle: 'Effacer ce poser ?',
    modalConfirmText: 'Les données relevées seront définitivement effacées et rien ne sera envoyé au site.',
    btnConfirmDiscard: 'Effacer',
    btnCancel: 'Annuler',
    sending: 'Envoi en cours…',
    sendOk: 'Poser enregistré sur le site ✓ (lieu #{id}{new})',
    sendNewPlace: ', nouveau lieu',
    sendErr: 'Échec de l\'envoi : {err}',

    // {url} est remplacé par l'URL de l'API.
    apiConfigured: 'API : {url} — clé configurée ✓',
    apiMissing: 'API : {url} — ⚠ clé non configurée (cliquez sur « Clé API »).',

    // Clé API saisie dans l'UI
    btnApiKey: 'Clé API',
    apiKeyTitle: 'Clé API',
    apiKeyIntro: 'Saisissez la clé API de votre compte Backcountry Pathfinders. Elle est enregistrée localement sur cet ordinateur et envoyée au site à chaque relevé.',
    apiKeyLabel: 'Clé API',
    apiUrlLabel: 'URL de l\'API',
    btnSaveKey: 'Enregistrer',
    apiKeySaved: 'Clé API enregistrée ✓',
    apiKeyCleared: 'Clé API effacée.',
    apiKeyErr: 'Échec de l\'enregistrement : {err}',
  },

  en: {
    statusConnected: 'Connected',
    statusConnecting: 'Connecting…',
    statusDisconnected: 'MSFS Disconnected',
    btnConnect: 'Connect MSFS2024',
    btnDisconnect: 'Disconnect MSFS2024',
    toggleTitle: 'Changer de langue / Switch language',

    // Second live-data bar
    lblLat: 'Latitude',
    lblLon: 'Longitude',
    lblAmsl: 'Altitude MSL',

    // Milestone 2 — landing survey
    recBanner: 'Landing detected — recording… ({n} pts · {d} m)',
    fldId: 'Landing ID',
    fldDate: 'Date (sim local time)',
    fldAvgAlt: 'Average terrain altitude',
    fldType: 'Surface type',
    fldCond: 'Surface condition',
    fldHeading: 'Average landing heading',
    fldElev: 'Elevation change',
    fldSlope: 'Max slope',
    fldAircraft: 'Aircraft',
    fldCapture: 'Screenshot',
    fldSamples: 'Relief samples',
    btnRecapture: 'Retake photo',
    captureUnavailable: 'Screenshot unavailable',
    sendQueued: 'Offline — landing queued, will resend automatically later.',
    queuePending: '{n} landing(s) pending upload',
    queueRetryTitle: 'Click to retry upload now',

    // Milestone 4 — manual capture + batch send at end of flight
    btnCapture: 'Screenshot',
    captureTitle: 'Spot screenshot',
    captureWarn: 'Frame the shot you want to capture in MSFS 2024. When ready, click the Capture button. Warning: if you don\'t take a screenshot, your landing will not be saved on the website.',
    btnCaptureDo: 'Capture',
    btnClose: 'Close',
    captureSaved: 'Screenshot saved ✓',
    captureErr: 'Capture failed: {err}',
    sendTitle: 'Send this flight\'s landings?',
    sendIntro: 'Flight over. Landings recorded during this flight:',
    btnSend: 'Send',
    btnDontSend: 'Don\'t send',
    discardTitle: 'Don\'t send?',
    discardText: 'This flight\'s landings will not be sent to the website. Photos stay saved locally.',
    listPhotoYes: 'photo ✓',
    listPhotoNo: 'no photo',
    listNoSend: 'no photo — not sent',
    sendNothing: 'No landing with a photo: nothing to send.',
    sendResult: 'Sent: {n} · Queued: {q} · Failed: {e}',
    modalSaveTitle: 'Save this landing?',
    btnSaveYes: 'Save',
    btnSaveNo: 'Discard',
    modalConfirmTitle: 'Discard this landing?',
    modalConfirmText: 'The recorded data will be permanently erased and nothing will be sent to the website.',
    btnConfirmDiscard: 'Erase',
    btnCancel: 'Cancel',
    sending: 'Sending…',
    sendOk: 'Landing saved online ✓ (place #{id}{new})',
    sendNewPlace: ', new place',
    sendErr: 'Send failed: {err}',

    apiConfigured: 'API: {url} — key configured ✓',
    apiMissing: 'API: {url} — ⚠ key not configured (click “API key”).',

    // API key entered in the UI
    btnApiKey: 'API key',
    apiKeyTitle: 'API key',
    apiKeyIntro: 'Enter the API key from your Backcountry Pathfinders account. It is stored locally on this computer and sent to the website with each survey.',
    apiKeyLabel: 'API key',
    apiUrlLabel: 'API URL',
    btnSaveKey: 'Save',
    apiKeySaved: 'API key saved ✓',
    apiKeyCleared: 'API key cleared.',
    apiKeyErr: 'Save failed: {err}',
  },
};

// Langue active (depuis localStorage si dispo, sinon FR).
let currentLang = (typeof localStorage !== 'undefined' && localStorage.getItem('backcountry-lang')) || 'fr';

// Traduction d'une clé pour la langue active (repli FR, puis clé brute).
function t(key) {
  return TRANSLATIONS[currentLang][key] ?? TRANSLATIONS.fr[key] ?? key;
}

// Change la langue, persiste, et ré-applique tout le DOM statique.
function setLanguage(lang) {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;
  if (typeof localStorage !== 'undefined') localStorage.setItem('backcountry-lang', lang);
  applyTranslations();
  updateToggleButton();
}

// Applique les traductions aux éléments porteurs d'un attribut data-i18n*.
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
}

// Met à jour l'état visuel du toggle FR | EN.
function updateToggleButton() {
  const btn = document.getElementById('btn-lang-toggle');
  if (!btn) return;
  btn.setAttribute('data-active-lang', currentLang);
  const fr = btn.querySelector('.lang-fr');
  const en = btn.querySelector('.lang-en');
  if (fr) fr.classList.toggle('lang-active', currentLang === 'fr');
  if (en) en.classList.toggle('lang-active', currentLang === 'en');
}

// Initialise au chargement : applique la langue courante.
function initI18n() {
  applyTranslations();
  updateToggleButton();
}
