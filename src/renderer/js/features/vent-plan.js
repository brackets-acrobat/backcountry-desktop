/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// vent-plan.js — vent prévu, vitesse propre, et temps par leg.
//
// Repris de Clear Sky VFR (features/vent-plan.js). Paramètres de NAVIGATION du
// plan, à ne pas confondre avec l'indicateur de vent LIVE de la carte : ici, une
// vitesse propre (Vp) et un vent uniques pour tout le plan, saisis dans le
// bandeau du panneau « Plan de vol ». De là se déduit, leg par leg, le triangle
// des vitesses — dérive, cap à suivre, vitesse sol — et donc la durée.
//
// LE VENT EST EN VRAI, comme la colonne « Route ». C'est le référentiel de MSFS
// (AMBIENT WIND DIRECTION) et celui d'un METAR écrit : le vent du simulateur
// tombe donc directement dans les cases, sans conversion. (L'indicateur de vent
// de la carte, lui, reste affiché en magnétique — c'est ce que l'ATIS annonce.)
//
// Le passage en magnétique se fait une seule fois, au bout de la chaîne : la
// colonne « Cap » retranche la déclinaison LOCALE du leg.
// ============================================================

let _planVp = null;        // vitesse propre (kt) — null = non renseignée
let _planVentDir = null;   // direction D'OÙ VIENT le vent (°, VRAIS) — null = non renseignée
let _planVentKt = null;    // force du vent (kt) — null = non renseignée

const VP_MAX = 500;        // garde-fous de saisie
const VP_MPH_MAX = Math.round(VP_MAX * MPH_PAR_KT);   // même plafond, dans l'autre unité
const VENT_KT_MAX = 200;

// Triangle des vitesses d'un leg, tout en VRAI. Vent absent ou nul → air calme,
// la vitesse sol vaut la vitesse propre.
// Renvoie null quand le problème n'a pas de solution :
//   • pas de vitesse propre renseignée ;
//   • composante de travers du vent supérieure à la Vp (aucune dérive ne
//     rattrape la route) ;
//   • vitesse sol nulle ou négative (vent debout plus fort que la Vp).
function triangleVitesses(routeVraie) {
  if (!(_planVp > 0)) return null;
  const w = (Number.isFinite(_planVentKt) && _planVentKt > 0) ? _planVentKt : 0;
  const dir = (w > 0 && Number.isFinite(_planVentDir)) ? _planVentDir : 0;
  const RAD = Math.PI / 180;
  const beta = (dir - routeVraie) * RAD;         // écart entre le lit du vent et la route
  const sinDerive = (w / _planVp) * Math.sin(beta);
  if (Math.abs(sinDerive) > 1) return null;      // travers plus fort que la Vp
  const derive = Math.asin(sinDerive);           // > 0 = correction vers la droite
  const vs = _planVp * Math.cos(derive) - w * Math.cos(beta);
  if (!(vs > 0)) return null;                    // sur place, ou repoussé en arrière
  return {
    vs,                                          // vitesse sol (kt)
    derive: derive / RAD,                        // angle de dérive signé (°)
    capVrai: ((routeVraie + derive / RAD) % 360 + 360) % 360,   // cap VRAI à suivre
  };
}

// Triangle + durée du leg, en secondes. null si le triangle est insoluble.
function legAvecTemps(routeVraie, distNm) {
  const tri = triangleVitesses(routeVraie);
  if (!tri) return null;
  return { ...tri, secondes: (distNm / tri.vs) * 3600 };
}

// Durée en h:mm:ss dès l'heure atteinte, mm:ss en deçà : compact, en chasse
// fixe, et sans unité à deviner.
function formatDuree(s) {
  if (!Number.isFinite(s) || s < 0) return '—';
  const tot = Math.round(s);
  const h = Math.floor(tot / 3600);
  const mm = String(Math.floor((tot % 3600) / 60)).padStart(2, '0');
  const ss = String(tot % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Raison pour laquelle un leg n'a ni vitesse sol ni durée.
function indiceSansTemps() {
  return _planVp > 0 ? t('legsTimeImpossible') : t('legsTimeNoVp');
}

// --- Saisie des paramètres ---------------------------------------------------

// Entier positif borné, saisie nettoyée en place. Chaîne vide → null.
function lireEntierChamp(el, max) {
  const v = el.value.replace(/[^\d]/g, '');
  if (el.value !== v) el.value = v;
  if (v === '') return null;
  return Math.min(max, parseInt(v, 10));
}

function relireParamsNav() {
  _planVp = lireEntierChamp($('nav-vp'), VP_MAX);
  const dir = lireEntierChamp($('nav-vent-dir'), 360);
  _planVentDir = dir == null ? null : dir % 360;   // 360 saisi = 000
  _planVentKt = lireEntierChamp($('nav-vent-kt'), VENT_KT_MAX);
  rafraichirTableauLegs();   // calcul local et instantané : pas de redessin de carte
}

// --- Vp : deux cases, une seule grandeur -------------------------------------
//
// Le NŒUD reste la valeur de référence : tout le triangle des vitesses, la
// vitesse sol et les durées sont en nœuds, et c'est lui qui part dans le
// .bcpfc. Le mile par heure n'est qu'une seconde porte d'entrée — celle des
// manuels de vol américains, où la Vp se lit en mph.
//
// On ne réécrit JAMAIS la case en cours de frappe, seulement l'autre. Le nœud
// étant la plus grosse unité, l'aller-retour mph → kt → mph n'est pas stable :
// 88 mph donne 76 kt, qui redonne 87 mph. Réécrire la case frappée ferait donc
// reculer d'une unité, sous les doigts du pilote, une valeur sur huit. (Dans
// l'autre sens, kt → mph → kt retombe toujours juste — le mile par heure est
// assez fin pour cela — mais la règle vaut pour les deux cases.)
function majVpMph() {   // kt → mph
  const kt = lireEntierChamp($('nav-vp'), VP_MAX);
  $('nav-vp-mph').value = kt == null ? '' : String(Math.round(kt * MPH_PAR_KT));
}
function majVpKt() {    // mph → kt
  const mph = lireEntierChamp($('nav-vp-mph'), VP_MPH_MAX);
  $('nav-vp').value = mph == null ? '' : String(Math.round(mph / MPH_PAR_KT));
}

$('nav-vp').addEventListener('input', () => { majVpMph(); relireParamsNav(); });
$('nav-vp-mph').addEventListener('input', () => { majVpKt(); relireParamsNav(); });

['nav-vp', 'nav-vp-mph', 'nav-vent-dir', 'nav-vent-kt'].forEach((id) => {
  // Les champs vivent dans le panneau : Entrée n'a rien à valider, mais elle ne
  // doit pas remonter aux raccourcis globaux non plus.
  $(id).addEventListener('keydown', (e) => e.stopPropagation());
});
['nav-vent-dir', 'nav-vent-kt'].forEach((id) => {
  $(id).addEventListener('input', relireParamsNav);
});

// Applique des paramètres venus d'un plan chargé (valeurs absentes → champs
// vidés). Le vent injecté par le simulateur prime : un plan ne rouvre pas la
// météo d'un autre jour par-dessus celle qu'on est en train de voler.
function appliquerParamsNav({ vp, ventDir, ventKt } = {}) {
  $('nav-vp').value = Number.isFinite(vp) ? String(vp) : '';
  majVpMph();   // la case mph suit celle des nœuds, plan chargé compris
  if (!_ventSimActif) {
    $('nav-vent-dir').value = Number.isFinite(ventDir) ? String(ventDir) : '';
    $('nav-vent-kt').value = Number.isFinite(ventKt) ? String(ventKt) : '';
  }
  relireParamsNav();
}

// Ce qui part dans le .bcpfc, pour retrouver le plan tel qu'il a été préparé.
function paramsNavEnregistrables() {
  return {
    vitessePropre: Number.isFinite(_planVp) ? _planVp : null,
    ventDir: Number.isFinite(_planVentDir) ? _planVentDir : null,
    ventKt: Number.isFinite(_planVentKt) ? _planVentKt : null,
  };
}

// --- Vent injecté par le simulateur ------------------------------------------
// MSFS connecté : le vent du simulateur remplit les deux cases, qui passent en
// lecture seule — sinon la frappe du pilote serait effacée sous ses doigts au
// rafraîchissement suivant. Le flux de scan arrive ~2×/s ; on n'en retient
// qu'une trame toutes les 30 s, la première étant prise sans attendre.
const VENT_SIM_PERIODE_MS = 30000;
let _ventSimDernier = 0;    // horodatage de la dernière injection (0 = aucune)
let _ventSimActif = false;  // les cases sont sous la coupe du simulateur

function verrouillerCasesVent(verrou) {
  ['nav-vent-dir', 'nav-vent-kt'].forEach((id) => { $(id).readOnly = verrou; });
  $('nav-vent-src').hidden = !verrou;
}

function majVentPlanDepuisSim(f) {
  if (!f || !Number.isFinite(f.windDir) || !Number.isFinite(f.windKt)) return;
  const now = Date.now();
  if (_ventSimDernier && now - _ventSimDernier < VENT_SIM_PERIODE_MS) return;
  _ventSimDernier = now;
  if (!_ventSimActif) { _ventSimActif = true; verrouillerCasesVent(true); }
  // MSFS donne la direction D'OÙ VIENT le vent, en VRAI : c'est déjà le
  // référentiel des cases — rien à convertir.
  $('nav-vent-dir').value = String(((Math.round(f.windDir) % 360) + 360) % 360);
  $('nav-vent-kt').value = String(Math.min(VENT_KT_MAX, Math.max(0, Math.round(f.windKt))));
  relireParamsNav();
}

// Déconnexion : les cases redeviennent saisissables et GARDENT la dernière
// valeur injectée — point de départ honnête pour la suite de la préparation.
function libererCasesVent() {
  _ventSimDernier = 0;
  if (!_ventSimActif) return;
  _ventSimActif = false;
  verrouillerCasesVent(false);
}
