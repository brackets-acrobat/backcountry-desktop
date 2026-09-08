/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// addons.js — détection des terrains fournis par un paquet add-on.
//
// Une seule modale : elle montre le dossier du dernier scan, laisse en choisir
// un autre, lance l'analyse et affiche son résumé. Pas de barre de progression
// — l'analyse ne parle pas au simulateur, elle lit le disque et tient en
// quelques secondes.
//
// Le marquage lui-même (l'anneau autour du symbole) est posé par
// makeAirportIcon() dans renderer.js à partir du drapeau `addon` que main
// renvoie avec chaque aéroport ; ici on ne fait que déclencher l'analyse et
// rafraîchir la carte.
// ============================================================

let _addonsScanEnCours = false;

function addonsAfficherStatut(cle, classe, remplacements) {
  const el = $('addons-status');
  let texte = t(cle);
  if (remplacements) {
    for (const [k, v] of Object.entries(remplacements)) texte = texte.replace('{' + k + '}', v);
  }
  el.hidden = false;
  el.className = 'modal-status ' + classe;
  el.textContent = texte;
}

function addonsMajBoutons() {
  const racine = $('addons-root').value.trim();
  $('btn-addons-run').disabled = _addonsScanEnCours || !racine;
  $('btn-addons-browse').disabled = _addonsScanEnCours;
  $('btn-addons-close').disabled = _addonsScanEnCours;
}

async function ouvrirAddons() {
  const st = $('addons-status');
  st.hidden = true; st.className = 'modal-status'; st.textContent = '';
  let etat = null;
  try { etat = await window.bc.addonsEtat(); } catch (_) {}
  $('addons-root').value = (etat && etat.racine) || '';
  if (etat && etat.present) {
    addonsAfficherStatut('addonsLastScan', 'is-ok', {
      n: etat.aerodromes,
      date: etat.date ? new Date(etat.date).toLocaleString() : '—',
    });
  }
  addonsMajBoutons();
  $('addons-overlay').hidden = false;
}

function fermerAddons() {
  if (_addonsScanEnCours) return;
  $('addons-overlay').hidden = true;
}

async function addonsParcourir() {
  let res;
  try { res = await window.bc.addonsChoisirDossier(); } catch (_) { return; }
  if (!res || !res.ok) return;   // annulation : on ne touche à rien
  $('addons-root').value = res.racine;
  const st = $('addons-status');
  st.hidden = true; st.textContent = '';
  addonsMajBoutons();
}

async function addonsAnalyser() {
  const racine = $('addons-root').value.trim();
  if (!racine || _addonsScanEnCours) return;
  _addonsScanEnCours = true;
  addonsMajBoutons();
  addonsAfficherStatut('addonsScanning', 'is-ok');

  let res;
  try { res = await window.bc.addonsScanner(racine); }
  catch (err) { res = { ok: false, error: (err && err.message) || String(err) }; }

  _addonsScanEnCours = false;
  addonsMajBoutons();

  if (res && res.ok) {
    addonsAfficherStatut('addonsDone', 'is-ok', {
      n: res.aerodromes, paquets: res.paquets, rattaches: res.rattaches,
    });
    // La base est marquée côté main : il suffit de redemander les couches.
    if (typeof rafraichirCouches === 'function') rafraichirCouches();
  } else {
    const cle = res && res.error === 'root-missing' ? 'addonsErrRoot'
      : res && res.error === 'no-data' ? 'addonsErrNoBase'
      : 'addonsErr';
    addonsAfficherStatut(cle, 'is-error');
  }
}

$('menu-detect-addons').addEventListener('click', () => { fermerImportMenu(); ouvrirAddons(); });
$('btn-addons-close').addEventListener('click', fermerAddons);
$('btn-addons-browse').addEventListener('click', addonsParcourir);
$('btn-addons-run').addEventListener('click', addonsAnalyser);
