/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// capture.js — capture d'écran du spot (STUB / contrat).
//
// SimConnect ne capture PAS l'image du sim. Solution retenue (validée) :
// capture desktop programmatique par l'app (façon Greenshot), écrite
// directement dans Mes documents, nommage maîtrisé. Confirmée sans écran
// noir tant que FS2024 est la fenêtre active (cas naturel au poser).
//
// Flux sécurisé prévu :
//   raccourci → capture en staging temporaire → vignette d'aperçu →
//   Valider / Refaire / Annuler → écriture finale seulement après accord.
// Métadonnées (lat/lon/alt/heure sim) figées à l'instant de la capture.
//
// Piste d'implémentation : desktopCapturer d'Electron (screen) ou capture
// native. Réserves : cibler le bon moniteur (multi-écrans) ; KO si MSFS est
// en plein écran EXCLUSIF.
//
// Contrat (à implémenter) :
//   await capturerStaging()  → { fichierTmp, meta }
//   await validerCapture(fichierTmp, destDir) → cheminFinal
// ============================================================

function capturerStaging() {
  // TODO (jalon 3) : Electron desktopCapturer → PNG en staging.
  return Promise.resolve({ fichierTmp: null, meta: null });
}

function validerCapture(/* fichierTmp, destDir */) {
  // TODO (jalon 3) : déplacer du staging vers le dossier final.
  return Promise.resolve(null);
}

module.exports = { capturerStaging, validerCapture };
