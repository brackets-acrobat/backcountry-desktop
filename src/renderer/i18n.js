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
    lblIcaoDep: 'ICAO départ',
    lblIcaoArr: 'ICAO arrivée',
    savePlanTooltip: 'Sauvegarder le plan de vol',
    savePlanTitle: 'Sauvegarder le plan de vol',
    savePlanErr: 'Échec de la sauvegarde : {err}',
    newPlanTooltip: 'Nouveau plan de vol',
    newPlanTitle: 'Nouveau plan de vol',
    newPlanText: 'Le plan de vol en cours sera abandonné. Continuer ?',
    newPlanConfirm: 'Nouveau plan',
    openPlanTooltip: 'Ouvrir un plan de vol',
    openPlanTitle: 'Ouvrir un plan de vol',
    openPlanErr: 'Échec de l\'ouverture : {err}',
    lblLat: 'Latitude',
    lblLon: 'Longitude',
    lblAmsl: 'Altitude MSL',

    // Menu contextuel (clic droit sur la carte)
    ctxSetDep: 'Définir comme aéroport de départ',
    ctxSetArr: 'Définir comme aéroport d\'arrivée',
    ctxSetDepPoint: 'Définir comme lieu de départ',
    ctxSetArrPoint: 'Définir comme lieu d\'arrivée',
    ctxDeleteWp: 'Supprimer ce point tournant',
    ctxSetActiveLeg: 'Rendre ce leg actif',
    ctxRangeCircle: 'Cercle de portée',
    ctxRangeCircleNavaid: 'Cercle de portée du navaid',
    ctxRangeDeleteOne: 'Supprimer ce cercle de portée',
    ctxRangeClear: 'Effacer les cercles de portée',
    rangeTitle: 'Cercle de portée',
    rangeLabel: 'Rayon (NM)',
    rangeDraw: 'Tracer',
    rangeInvalid: 'Rayon invalide.',

    // Modale d'aimantation d'un point tournant sur un aéroport / navaid proche
    snapTitle: 'Point tournant à proximité',
    snapText: 'Un {kind} est à {dist} NM : {feature}. Placer le point tournant dessus ?',
    snapAirport: 'aéroport',
    snapNavaid: 'navaid',
    snapLieu: 'lieu d\'atterrissage',
    snapKeep: 'Garder la position',
    snapPlace: 'Placer dessus',

    // Jalon 2 — relevé de l'atterrissage
    recBanner: 'Atterrissage détecté — enregistrement en cours… ({n} pts · {d} m)',
    fldId: 'Identifiant de l\'atterrissage',
    fldDate: 'Date (heure sim locale)',
    fldAvgAlt: 'Altitude moyenne du terrain',
    fldType: 'Type de sol',
    fldCond: 'État du sol',
    fldTouchSpeed: 'Vitesse au toucher',
    fldRollDist: 'Distance de roulage',
    fldHeading: 'Cap moyen à l\'atterrissage',
    fldElev: 'Dénivelé',
    fldSlope: 'Pente max',
    fldAircraft: 'Aéronef',
    fldCapture: 'Capture',
    fldSamples: 'Échantillons de relief',
    btnRecapture: 'Refaire la photo',
    captureUnavailable: 'Capture indisponible',
    sendQueued: 'Hors-ligne — atterrissage mis en file, renvoi automatique plus tard.',
    queuePending: '{n} vol(s) en attente d\'envoi',
    queueRetryTitle: 'Cliquer pour réessayer l\'envoi maintenant',

    // Jalon 4 — capture manuelle + envoi groupé fin de vol
    btnCapture: 'Capture d\'écran',
    captureTitle: 'Capture d\'écran du spot',
    captureWarn: 'Cadrez l\'image que vous souhaitez capturer dans MSFS 2024. Une fois prêt, cliquez sur le bouton Capture. Attention : si vous ne prenez pas de capture d\'écran, votre atterrissage ne sera pas enregistré sur le site.',
    btnCaptureDo: 'Capture',
    btnClose: 'Fermer',
    captureSaved: 'Capture enregistrée ✓',
    captureErr: 'Échec de la capture : {err}',
    sendTitle: 'Envoyer les atterrissages du vol ?',
    sendIntro: 'Vol terminé. Voici les atterrissages relevés pendant ce vol :',
    sendFlightSummary: 'Temps de vol : {time} · {n} atterrissage(s)',
    btnSend: 'Envoyer',
    btnDontSend: 'Ne pas envoyer',
    discardTitle: 'Ne pas envoyer ?',
    discardText: 'Les atterrissages de ce vol ne seront pas envoyés au site. Les photos restent enregistrées en local.',
    listPhotoYes: 'photo ✓',
    listPhotoNo: 'sans photo',
    listNoSend: 'sans photo — non envoyé',
    sendNothing: 'Aucun atterrissage avec photo : rien à envoyer.',
    sendResult: 'Envoyés : {n} · En file : {q} · Échecs : {e}',
    modalSaveTitle: 'Enregistrer cet atterrissage ?',
    btnSaveYes: 'Enregistrer',
    btnSaveNo: 'Ne pas enregistrer',
    modalConfirmTitle: 'Effacer cet atterrissage ?',
    modalConfirmText: 'Les données relevées seront définitivement effacées et rien ne sera envoyé au site.',
    btnConfirmDiscard: 'Effacer',
    btnCancel: 'Annuler',
    sending: 'Envoi en cours…',
    sendOk: 'Atterrissage enregistré sur le site ✓ (lieu #{id}{new})',
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

    // Import des aéroports MSFS 2024
    menuImportAirports: 'Aéroports MSFS2024',
    msfsImportTitle: 'Importer les aéroports MSFS 2024',
    msfsImportIntro: 'Extrait toute la base d\'aéroports de MSFS 2024 via SimConnect (pistes, fréquences, hélipads). MSFS 2024 doit être lancé avec un vol en cours. L\'opération peut durer plusieurs minutes.',
    btnImport: 'Importer',
    msfsCheckChecking: 'Vérification de MSFS 2024…',
    msfsCheckRunning: 'MSFS 2024 détecté ({app}).',
    msfsCheckNotRunning: 'MSFS 2024 ne répond pas. Lancez le simulateur avec un vol en cours, puis réessayez.',
    msfsProgressTitle: 'Extraction des aéroports MSFS 2024',
    msfsPhaseConnecting: 'Connexion au simulateur…',
    msfsPhaseEnumerate: 'Énumération des aéroports… ({n})',
    msfsPhaseDetail: 'Extraction des détails (pistes, fréquences, hélipads)…',
    msfsPhaseRetry: 'Reprise des aéroports en échec…',
    msfsProgressStats: '{rate}/s · temps restant estimé {eta} · {ok} OK · {failed} échec(s)',
    msfsExtractDone: 'Extraction terminée : {n} aéroports enregistrés.',
    msfsExtractEmpty: 'Aucun aéroport extrait. Vérifiez que MSFS 2024 tourne avec un vol en cours.',
    msfsExtractError: 'Extraction échouée : {msg}',

    // Import des navaids MSFS 2024 (réutilise msfsCheck*/msfsPhaseConnecting/btnImport)
    menuImportNavaids: 'Navaids MSFS2024',
    navaidsImportTitle: 'Importer les navaids MSFS 2024',
    navaidsImportIntro: 'Reconstruit la base mondiale de navaids (VOR/NDB) de MSFS 2024 par traversance du réseau d\'airways. MSFS 2024 doit être lancé avec un vol en cours. L\'opération peut durer plusieurs minutes.',
    navaidsProgressTitle: 'Extraction des navaids MSFS 2024',
    navaidsPhaseEnumerate: 'Énumération des aéroports… ({n})',
    navaidsPhaseSeed: 'Lecture des procédures (amorçage)…',
    navaidsPhaseBfs: 'Parcours du réseau d\'airways…',
    navaidsPhaseVor: 'Détail des VOR/DME/TACAN…',
    navaidsPhaseNdb: 'Détail des NDB…',
    navaidsPhaseDisco: 'Navaids isolés (complément)…',
    navaidsProgressStats: '{nav} navaids · {wpt} waypoints parcourus',
    navaidsExtractDone: 'Extraction terminée : {n} navaids enregistrés.',
    navaidsExtractEmpty: 'Aucun navaid extrait. Vérifiez que MSFS 2024 tourne avec un vol en cours.',
    navaidsExtractError: 'Extraction échouée : {msg}',

    // Import des données d'élévation (GLOBE all10g.zip)
    menuImportElevation: 'Données d\'élévation',
    elevConfirmTitle: 'Re-télécharger les données ?',
    elevConfirmMsg: 'Les données d\'élévation semblent déjà installées (~1,8 Go). Re-télécharger l\'archive (~307 Mo) et remplacer les fichiers existants ?',
    elevConfirmBtn: 'Re-télécharger',
    elevProgressTitle: 'Import des données d\'élévation',
    elevPhaseStarting: 'Préparation…',
    elevPhaseDownloading: 'Téléchargement de all10g.zip…',
    elevPhaseExtracting: 'Extraction des tuiles (~1,8 Go)…',
    elevPhaseFlattening: 'Organisation des fichiers…',
    elevProgressDone: 'Données d\'élévation installées.',
    elevProgressDoneDir: 'Dossier : {dir}',
    elevProgressError: 'Échec de l\'import',

    // Contrôle des couches de la carte
    layersTitle: 'Couches',
    layerAirports: 'Aéroports',
    layerHeliports: 'Héliports',
    layerSeaplanes: 'Hydrobases',
    layerNavaids: 'Navaids',
    layerLieux: 'Lieux d\'atterrissage',
    basemapTitle: 'Fond de carte',
    followTitle: 'Suivre l\'avion',

    // Panneau « Plan de vol » (tableau des legs)
    legsToggle: 'Afficher plan de vol',
    legsClose: 'Masquer le plan de vol',
    legsTitle: 'Plan de vol',
    legsTotal: 'Distance totale',
    legsColFrom: 'Départ',
    legsColTo: 'Arrivée',
    legsColHdg: 'Cap',
    legsColAlt: 'Altitude',
    legsColDist: 'Dist.',
    legsEmpty: 'Aucun plan de vol.',
    legsDeclHint: 'Déclinaison magnétique {d}° (prise en compte dans le cap)',

    // Profil vertical (relief GLOBE le long du plan de vol)
    vertProfileToggle: 'Afficher le profil vertical',
    vertProfileClose: 'Masquer le profil vertical',
    vertProfileTitle: 'Profil vertical',
    vertProfileEmpty: 'Créez un plan de vol (départ + arrivée) pour afficher le profil vertical.',
    vertProfileNoData: 'Relief indisponible. Importez d\'abord les données d\'élévation (menu Importer → Données d\'élévation).',
    vertProfileTerrain: 'Relief',
    vertProfilePlanned: 'Alt. prévue',
    vertProfileGround: 'Sol',
    vertProfilePlannedFull: 'Altitude prévue',
    vertProfileSafe: 'Alt. sécu',
    vertProfileSafeFull: 'Altitude de sécurité',
    vertProfileSummit: 'Sommet route',
    vertProfileMinMargin: 'Marge mini',

    // Popup d'un lieu d'atterrissage (couche « Lieux d'atterrissage »)
    lieuUntitled: 'Lieu',
    lieuCountry: 'Pays',
    lieuSurface: 'Surface',
    lieuAltitude: 'Alt.',
    lieuSurveys: 'Relevés',
    lieuRating: 'Note',
    lieuDifficulty: 'Difficulté',
    lieuDetail: 'Voir le détail',

    // Bannière de mise à jour (electron-updater)
    updateDownloading: 'Téléchargement de la mise à jour… {percent} %',
    updateReady: 'Mise à jour {version} prête à être installée.',
    updateRestart: 'Redémarrer et installer',

    // Modale « À propos » (bouton « ? » du header)
    btnAboutTooltip: 'À propos',
    aboutTitle: 'À propos',
    aboutTagline: 'La communauté des pilotes de brousse sur Microsoft Flight Simulator 2024. Découvrez les derniers lieux de poser relevés et l\'actualité du projet.',
    aboutLicense: 'Ce logiciel est distribué sous licence GPL-3.0 ou ultérieure.',
    aboutSource: 'Le code source de cette application est disponible sur <a href="https://github.com/brackets-acrobat/backcountry-desktop" target="_blank" rel="noopener">GitHub</a>.',
    aboutCopyright: 'Copyright 2026 Cyril MILANI.',
    aboutCreditsMethod: 'L\'extraction des navaids depuis MSFS 2024 (<code>extract-navaids-msfs.js</code>) s\'inspire directement de la méthode du projet atools / Little Navmap d\'Alexander Barthel.',
  },

  en: {
    statusConnected: 'Connected',
    statusConnecting: 'Connecting…',
    statusDisconnected: 'MSFS Disconnected',
    btnConnect: 'Connect MSFS2024',
    btnDisconnect: 'Disconnect MSFS2024',
    toggleTitle: 'Changer de langue / Switch language',

    // Second live-data bar
    lblIcaoDep: 'Departure ICAO',
    lblIcaoArr: 'Arrival ICAO',
    savePlanTooltip: 'Save flight plan',
    savePlanTitle: 'Save flight plan',
    savePlanErr: 'Save failed: {err}',
    newPlanTooltip: 'New flight plan',
    newPlanTitle: 'New flight plan',
    newPlanText: 'The current flight plan will be discarded. Continue?',
    newPlanConfirm: 'New plan',
    openPlanTooltip: 'Open a flight plan',
    openPlanTitle: 'Open a flight plan',
    openPlanErr: 'Open failed: {err}',
    lblLat: 'Latitude',
    lblLon: 'Longitude',
    lblAmsl: 'Altitude MSL',

    // Map context menu (right-click)
    ctxSetDep: 'Set as departure airport',
    ctxSetArr: 'Set as arrival airport',
    ctxSetDepPoint: 'Set as departure point',
    ctxSetArrPoint: 'Set as arrival point',
    ctxDeleteWp: 'Delete this turning point',
    ctxSetActiveLeg: 'Set this leg as active',
    ctxRangeCircle: 'Range ring',
    ctxRangeCircleNavaid: 'Navaid range ring',
    ctxRangeDeleteOne: 'Delete this range ring',
    ctxRangeClear: 'Clear range rings',
    rangeTitle: 'Range ring',
    rangeLabel: 'Radius (NM)',
    rangeDraw: 'Draw',
    rangeInvalid: 'Invalid radius.',

    // Snap a turning point onto a nearby airport / navaid
    snapTitle: 'Turning point nearby',
    snapText: 'A {kind} is {dist} NM away: {feature}. Snap the turning point onto it?',
    snapAirport: 'airport',
    snapNavaid: 'navaid',
    snapLieu: 'landing spot',
    snapKeep: 'Keep position',
    snapPlace: 'Snap onto it',

    // Milestone 2 — landing survey
    recBanner: 'Landing detected — recording… ({n} pts · {d} m)',
    fldId: 'Landing ID',
    fldDate: 'Date (sim local time)',
    fldAvgAlt: 'Average terrain altitude',
    fldType: 'Surface type',
    fldCond: 'Surface condition',
    fldTouchSpeed: 'Touchdown speed',
    fldRollDist: 'Roll-out distance',
    fldHeading: 'Average landing heading',
    fldElev: 'Elevation change',
    fldSlope: 'Max slope',
    fldAircraft: 'Aircraft',
    fldCapture: 'Screenshot',
    fldSamples: 'Relief samples',
    btnRecapture: 'Retake photo',
    captureUnavailable: 'Screenshot unavailable',
    sendQueued: 'Offline — landing queued, will resend automatically later.',
    queuePending: '{n} flight(s) pending upload',
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
    sendFlightSummary: 'Flight time: {time} · {n} landing(s)',
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

    // MSFS 2024 airports import
    menuImportAirports: 'MSFS2024 airports',
    msfsImportTitle: 'Import MSFS 2024 airports',
    msfsImportIntro: 'Extracts the whole MSFS 2024 airport database via SimConnect (runways, frequencies, helipads). MSFS 2024 must be running with a flight loaded. This can take several minutes.',
    btnImport: 'Import',
    msfsCheckChecking: 'Checking MSFS 2024…',
    msfsCheckRunning: 'MSFS 2024 detected ({app}).',
    msfsCheckNotRunning: 'MSFS 2024 is not responding. Launch the simulator with a flight loaded, then try again.',
    msfsProgressTitle: 'MSFS 2024 airports extraction',
    msfsPhaseConnecting: 'Connecting to the simulator…',
    msfsPhaseEnumerate: 'Enumerating airports… ({n})',
    msfsPhaseDetail: 'Extracting details (runways, frequencies, helipads)…',
    msfsPhaseRetry: 'Retrying failed airports…',
    msfsProgressStats: '{rate}/s · est. time remaining {eta} · {ok} OK · {failed} failed',
    msfsExtractDone: 'Extraction complete: {n} airports saved.',
    msfsExtractEmpty: 'No airport extracted. Make sure MSFS 2024 is running with a flight loaded.',
    msfsExtractError: 'Extraction failed: {msg}',

    // MSFS 2024 navaids import (reuses msfsCheck*/msfsPhaseConnecting/btnImport)
    menuImportNavaids: 'MSFS2024 navaids',
    navaidsImportTitle: 'Import MSFS 2024 navaids',
    navaidsImportIntro: 'Rebuilds the worldwide MSFS 2024 navaid database (VOR/NDB) by traversing the airway network. MSFS 2024 must be running with a flight loaded. This can take several minutes.',
    navaidsProgressTitle: 'MSFS 2024 navaids extraction',
    navaidsPhaseEnumerate: 'Enumerating airports… ({n})',
    navaidsPhaseSeed: 'Reading procedures (seeding)…',
    navaidsPhaseBfs: 'Traversing the airway network…',
    navaidsPhaseVor: 'VOR/DME/TACAN details…',
    navaidsPhaseNdb: 'NDB details…',
    navaidsPhaseDisco: 'Isolated navaids (extra)…',
    navaidsProgressStats: '{nav} navaids · {wpt} waypoints visited',
    navaidsExtractDone: 'Extraction complete: {n} navaids saved.',
    navaidsExtractEmpty: 'No navaid extracted. Make sure MSFS 2024 is running with a flight loaded.',
    navaidsExtractError: 'Extraction failed: {msg}',

    // Elevation data import (GLOBE all10g.zip)
    menuImportElevation: 'Elevation data',
    elevConfirmTitle: 'Re-download the data?',
    elevConfirmMsg: 'Elevation data appears to be already installed (~1.8 GB). Re-download the archive (~307 MB) and replace the existing files?',
    elevConfirmBtn: 'Re-download',
    elevProgressTitle: 'Elevation data import',
    elevPhaseStarting: 'Preparing…',
    elevPhaseDownloading: 'Downloading all10g.zip…',
    elevPhaseExtracting: 'Extracting tiles (~1.8 GB)…',
    elevPhaseFlattening: 'Organizing files…',
    elevProgressDone: 'Elevation data installed.',
    elevProgressDoneDir: 'Folder: {dir}',
    elevProgressError: 'Import failed',

    // Map layers control
    layersTitle: 'Layers',
    layerAirports: 'Airports',
    layerHeliports: 'Heliports',
    layerSeaplanes: 'Seaplane bases',
    layerNavaids: 'Navaids',
    layerLieux: 'Landing spots',
    basemapTitle: 'Base map',
    followTitle: 'Follow aircraft',

    // Landing-spot popup ("Landing spots" layer)
    // Flight plan panel (legs table)
    legsToggle: 'Show flight plan',
    legsClose: 'Hide flight plan',
    legsTitle: 'Flight plan',
    legsTotal: 'Total distance',
    legsColFrom: 'From',
    legsColTo: 'To',
    legsColHdg: 'Hdg',
    legsColAlt: 'Altitude',
    legsColDist: 'Dist.',
    legsEmpty: 'No flight plan.',
    legsDeclHint: 'Magnetic declination {d}° (applied to the heading)',

    // Vertical profile (GLOBE terrain along the flight plan)
    vertProfileToggle: 'Show vertical profile',
    vertProfileClose: 'Hide vertical profile',
    vertProfileTitle: 'Vertical profile',
    vertProfileEmpty: 'Create a flight plan (departure + arrival) to display the vertical profile.',
    vertProfileNoData: 'Terrain unavailable. Import the elevation data first (Import menu → Elevation data).',
    vertProfileTerrain: 'Terrain',
    vertProfilePlanned: 'Planned alt.',
    vertProfileGround: 'Ground',
    vertProfilePlannedFull: 'Planned altitude',
    vertProfileSafe: 'Safe alt.',
    vertProfileSafeFull: 'Safe altitude',
    vertProfileSummit: 'Route summit',
    vertProfileMinMargin: 'Min. clearance',

    lieuUntitled: 'Spot',
    lieuCountry: 'Country',
    lieuSurface: 'Surface',
    lieuAltitude: 'Alt.',
    lieuSurveys: 'Surveys',
    lieuRating: 'Rating',
    lieuDifficulty: 'Difficulty',
    lieuDetail: 'View details',

    // Update banner (electron-updater)
    updateDownloading: 'Downloading update… {percent}%',
    updateReady: 'Update {version} ready to install.',
    updateRestart: 'Restart and install',

    // "About" modal (header "?" button)
    btnAboutTooltip: 'About',
    aboutTitle: 'About',
    aboutTagline: 'The community of backcountry pilots on Microsoft Flight Simulator 2024. Discover the latest surveyed landing spots and the project news.',
    aboutLicense: 'This software is distributed under the GPL-3.0 license or later.',
    aboutSource: 'The source code of this application is available on <a href="https://github.com/brackets-acrobat/backcountry-desktop" target="_blank" rel="noopener">GitHub</a>.',
    aboutCopyright: 'Copyright 2026 Cyril MILANI.',
    aboutCreditsMethod: 'The navaid extraction from MSFS 2024 (<code>extract-navaids-msfs.js</code>) draws directly on the method of Alexander Barthel\'s atools / Little Navmap project.',
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
