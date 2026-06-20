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
    appSubtitle: 'Évaluateur de pistes de brousse — acquisition MSFS 2024',

    statusConnected: 'Connecté',
    statusConnecting: 'Connexion…',
    statusDisconnected: 'MSFS Déconnecté',
    btnConnect: 'Connecter MSFS2024',
    btnDisconnect: 'Déconnecter MSFS2024',
    toggleTitle: 'Changer de langue / Switch language',

    scanLive: 'Scan live',
    lblLat: 'Latitude',
    lblLon: 'Longitude',
    lblAmsl: 'Altitude MSL',
    lblAgl: 'Hauteur sol (AGL)',
    lblRelief: 'Relief (GROUND ALT)',
    lblGs: 'Vitesse sol',
    lblHdg: 'Cap vrai',
    lblSurf: 'Type de sol',
    lblCond: 'État du sol',
    lblOnGround: 'Au sol',
    lblBrake: 'Frein parking',
    yes: 'Oui',
    no: 'Non',

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
    fldSamples: 'Échantillons de relief',
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

    note: 'Rappel : <strong>type / état de sol</strong> ne sont fiables qu\'<em>au contact</em> du sol. Le <strong>relief</strong> (GROUND ALTITUDE) est lisible en vol — c\'est la donnée centrale du scan.',

    // {url} est remplacé par l'URL de l'API.
    apiConfigured: 'API : {url} — clé configurée ✓',
    apiMissing: 'API : {url} — ⚠ clé non configurée (copie config.example.json → config.json).',
  },

  en: {
    appSubtitle: 'Backcountry runway evaluator — MSFS 2024 acquisition',

    statusConnected: 'Connected',
    statusConnecting: 'Connecting…',
    statusDisconnected: 'MSFS Disconnected',
    btnConnect: 'Connect MSFS2024',
    btnDisconnect: 'Disconnect MSFS2024',
    toggleTitle: 'Changer de langue / Switch language',

    scanLive: 'Live scan',
    lblLat: 'Latitude',
    lblLon: 'Longitude',
    lblAmsl: 'Altitude MSL',
    lblAgl: 'Height AGL',
    lblRelief: 'Terrain (GROUND ALT)',
    lblGs: 'Ground speed',
    lblHdg: 'True heading',
    lblSurf: 'Surface type',
    lblCond: 'Surface condition',
    lblOnGround: 'On ground',
    lblBrake: 'Parking brake',
    yes: 'Yes',
    no: 'No',

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
    fldSamples: 'Relief samples',
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

    note: 'Reminder: <strong>surface type / condition</strong> are only reliable <em>on the ground</em>. <strong>Terrain</strong> (GROUND ALTITUDE) is readable in flight — it\'s the core scan data.',

    apiConfigured: 'API: {url} — key configured ✓',
    apiMissing: 'API: {url} — ⚠ key not configured (copy config.example.json → config.json).',
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
