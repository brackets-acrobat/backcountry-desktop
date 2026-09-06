/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// export-gtn750.js — le plan de vol vers le GTN750 de PMS50.
//
// Repris de Clear Sky VFR (features/export-gtn750.js). Le GTN750 n'accepte qu'un
// format — « Only the PLN format is accepted » —, c'est-à-dire le XML
// SimBase.Document hérité de FSX. Le gabarit suivi ici est celui du fpl.pln
// d'exemple livré avec le paquet, pas une reconstitution.
//
// ── Pourquoi tous les points tournants en « User » ──────────────────────────
// La documentation de PMS50 met en garde : un point associé à un aérodrome, mal
// écrit par une application tierce, fait planter le simulateur (« this may
// result in a CTD »). Or les points tournants d'une navigation de brousse sont
// souvent posés à la main sur un lieu de poser, sans identité d'aérodrome. Un
// point tournant part donc SANS bloc ICAO, avec ses seules coordonnées : le GTN
// affiche un point utilisateur là où l'application le montre, et la géométrie de
// la route est celle de la carte au mètre près. Seuls le départ et l'arrivée
// gardent leur identité d'aérodrome — cas normal, et sûr.
//
// ── L'altitude portée par un point ──────────────────────────────────────────
// L'application planifie une altitude par leg, le PLN en porte une par point. On
// écrit sur un point l'altitude du leg qui y ARRIVE : c'est celle à laquelle on
// le franchit réellement. Départ et arrivée portent, eux, l'altitude du terrain.
// ============================================================

// Version d'application que le simulateur inscrit dans ses propres PLN, reprise
// telle quelle du fichier d'exemple de PMS50.
const PLN_APP_MAJOR = 11;
const PLN_APP_BUILD = 282174;

// Longueur d'un identifiant de point utilisateur dans le GTN750 (doc PMS50 :
// « Up to five characters », majuscules et chiffres, sans espace).
const GTN_IDENT_MAX = 5;

// Départ et arrivée hors aérodrome : identifiants que le simulateur emploie
// lui-même pour un point personnalisé.
const PLN_ID_DEP_LIBRE = 'CUSTD';
const PLN_ID_ARR_LIBRE = 'CUSTA';

const EXPORT_RETOUR_MS = 1200;   // durée de la coche de confirmation

// ------------------------------------------------------------
// Écriture des valeurs au format du simulateur
// ------------------------------------------------------------

function xmlEchappe(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Les identifiants du GTN ne portent ni accent ni signe : « Prés-Salés » y
// deviendrait illisible. On les replie avant de ne garder que A-Z et 0-9.
function sansAccents(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '');
}

// Un angle en degrés-minutes-secondes : N48° 4' 19.00". L'arrondi des secondes
// à deux décimales peut donner 60,00 — on propage alors la retenue, sans quoi le
// simulateur lirait une minute invalide.
function dms(valeur, lettrePos, lettreNeg) {
  const hemi = valeur < 0 ? lettreNeg : lettrePos;
  const v = Math.abs(valeur);
  let d = Math.floor(v);
  let m = Math.floor((v - d) * 60);
  let s = Math.round(((v - d) * 60 - m) * 60 * 100) / 100;
  if (s >= 60) { s -= 60; m += 1; }
  if (m >= 60) { m -= 60; d += 1; }
  return `${hemi}${d}° ${m}' ${s.toFixed(2)}"`;
}

// Altitude au format LLA : signe, six chiffres entiers, deux décimales.
function altitudeLla(ft) {
  const v = Number.isFinite(ft) ? ft : 0;
  const signe = v < 0 ? '-' : '+';
  const [entier, decimales] = Math.abs(v).toFixed(2).split('.');
  return `${signe}${entier.padStart(6, '0')}.${decimales}`;
}

// Position complète : N48° 4' 19.00",W1° 43' 56.00",+000105.25
function positionLla(lat, lon, altFt) {
  return `${dms(lat, 'N', 'S')},${dms(wrapLon(lon), 'E', 'W')},${altitudeLla(altFt)}`;
}

// Identifiant d'un point utilisateur : désaccentué, en majuscules, chiffres et
// lettres seulement, tronqué à la longueur que le GTN sait porter. Les doublons
// sont levés — deux points de même nom se confondraient dans l'instrument.
function identGtn(nom, pris) {
  let base = sansAccents(nom).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!base) base = 'WPT';
  base = base.slice(0, GTN_IDENT_MAX);
  if (!pris.has(base)) { pris.add(base); return base; }
  for (let n = 2; n <= 999; n++) {
    const suffixe = String(n);
    const candidat = base.slice(0, Math.max(1, GTN_IDENT_MAX - suffixe.length)) + suffixe;
    if (!pris.has(candidat)) { pris.add(candidat); return candidat; }
  }
  return base;   // inatteignable en pratique : 999 homonymes dans un plan de vol
}

// ------------------------------------------------------------
// Construction du PLN
// ------------------------------------------------------------

// Un <ATCWaypoint>. `icao` non nul → bloc ICAO d'aérodrome, réservé au départ et
// à l'arrivée (cf. l'en-tête sur le CTD).
function waypointPln(id, type, position, icao) {
  const l = [
    `        <ATCWaypoint id="${xmlEchappe(id)}">`,
    `            <ATCWaypointType>${type}</ATCWaypointType>`,
    `            <WorldPosition>${position}</WorldPosition>`,
    '            <SpeedMaxFP>-1</SpeedMaxFP>',
  ];
  if (icao) {
    l.push('            <ICAO>');
    l.push(`                <ICAOIdent>${xmlEchappe(icao)}</ICAOIdent>`);
    l.push('            </ICAO>');
  }
  l.push('        </ATCWaypoint>');
  return l.join('\n');
}

// Fiche d'un aéroport (altitude terrain, nom) par son code, ou null pour un
// départ / une arrivée hors aérodrome.
async function ficheAeroportPln(code) {
  if (!code || code === 'ZZZY' || code === 'ZZZZ') return null;
  try {
    const res = await window.bc.aeroportParCode(code);
    return (res && res.ok && res.airport) ? res.airport : null;
  } catch (_) { return null; }
}

// Construit le PLN complet. null si la route n'est pas exploitable.
async function construirePln() {
  if (!_routeDep || !_routeArr) return null;
  const dep = nettoyerIcao($('icao-dep').value);
  const arr = nettoyerIcao($('icao-arr').value);
  const [fDep, fArr] = await Promise.all([ficheAeroportPln(dep), ficheAeroportPln(arr)]);

  const noms = nomsPointsTournants(routeWaypoints);
  const nbLeg = routeWaypoints.length + 1;
  const altitudesLegs = Array.from({ length: nbLeg }, (_, i) => getLegAlt(i));

  // Départ et arrivée sont au sol. Faute d'altitude terrain — lieu cliqué hors
  // aérodrome, ou terrain sans élévation dans la base — on retombe sur
  // l'altitude planifiée du leg voisin, seul chiffre dont on dispose.
  const altDep = (fDep && Number.isFinite(fDep.elevation_ft)) ? fDep.elevation_ft : altitudesLegs[0];
  const altArr = (fArr && Number.isFinite(fArr.elevation_ft)) ? fArr.elevation_ft : altitudesLegs[nbLeg - 1];

  const identDep = fDep ? dep : PLN_ID_DEP_LIBRE;
  const identArr = fArr ? arr : PLN_ID_ARR_LIBRE;
  const llaDep = positionLla(_routeDep.lat, _routeDep.lon, altDep);
  const llaArr = positionLla(_routeArr.lat, _routeArr.lon, altArr);
  const titre = `${identDep} to ${identArr}`;

  // Un plan VFR tracé au trait droit : pas d'airways, donc RouteType « Direct ».
  // L'altitude de croisière annoncée est la plus haute des legs.
  const croisiere = Math.max(...altitudesLegs);

  const l = [];
  l.push('<?xml version="1.0" encoding="UTF-8"?>');
  l.push('');
  l.push('<SimBase.Document Type="AceXML" version="1,0">');
  l.push('    <Descr>AceXML Document</Descr>');
  l.push('    <FlightPlan.FlightPlan>');
  l.push(`        <Title>${xmlEchappe(titre)}</Title>`);
  l.push('        <FPType>VFR</FPType>');
  l.push('        <RouteType>Direct</RouteType>');
  l.push(`        <CruisingAlt>${croisiere.toFixed(3)}</CruisingAlt>`);
  l.push(`        <DepartureID>${xmlEchappe(identDep)}</DepartureID>`);
  l.push(`        <DepartureLLA>${llaDep}</DepartureLLA>`);
  l.push(`        <DestinationID>${xmlEchappe(identArr)}</DestinationID>`);
  l.push(`        <DestinationLLA>${llaArr}</DestinationLLA>`);
  l.push(`        <Descr>${xmlEchappe(titre)}</Descr>`);
  l.push(`        <DepartureName>${xmlEchappe((fDep && fDep.name) || identDep)}</DepartureName>`);
  l.push(`        <DestinationName>${xmlEchappe((fArr && fArr.name) || identArr)}</DestinationName>`);
  l.push('        <AppVersion>');
  l.push(`            <AppVersionMajor>${PLN_APP_MAJOR}</AppVersionMajor>`);
  l.push(`            <AppVersionBuild>${PLN_APP_BUILD}</AppVersionBuild>`);
  l.push('        </AppVersion>');

  l.push(waypointPln(identDep, fDep ? 'Airport' : 'User', llaDep, fDep ? dep : null));
  // Les identifiants doivent rester distincts dans tout le plan, extrémités comprises.
  const pris = new Set([identDep, identArr]);
  routeWaypoints.forEach((p, i) => {
    // Altitude du leg qui ARRIVE sur ce point : le leg i.
    l.push(waypointPln(identGtn(noms[i], pris), 'User', positionLla(p.lat, p.lon, altitudesLegs[i]), null));
  });
  l.push(waypointPln(identArr, fArr ? 'Airport' : 'User', llaArr, fArr ? arr : null));

  l.push('    </FlightPlan.FlightPlan>');
  l.push('</SimBase.Document>');
  l.push('');
  return l.join('\n');
}

// ------------------------------------------------------------
// Bouton
// ------------------------------------------------------------

const exportGtnBtn = $('btn-export-gtn750');

// Retour visuel : coche pendant ~1,2 s, puis retour à l'icône. L'écriture est
// silencieuse (aucune boîte de dialogue) — sans ce signe, rien ne dirait qu'elle
// a eu lieu.
function confirmerExportGtn() {
  if (exportGtnBtn._timer) clearTimeout(exportGtnBtn._timer);
  exportGtnBtn.innerHTML = '<i class="ph-light ph-check" aria-hidden="true"></i>';
  exportGtnBtn._timer = setTimeout(() => {
    exportGtnBtn.innerHTML = '<i class="ph-light ph-gps" aria-hidden="true"></i>';
    exportGtnBtn._timer = null;
  }, EXPORT_RETOUR_MS);
}

exportGtnBtn.addEventListener('click', async () => {
  if (!planEnregistrable()) return;   // garde-fou (le bouton est aussi désactivé)

  let pln;
  try { pln = await construirePln(); } catch (_) { pln = null; }
  if (!pln) { messageCarte(t('gtnExportVide'), false); return; }

  let res;
  try { res = await window.bc.exporterGtn750({ pln }); }
  catch (err) { res = { ok: false, raison: 'ecriture', error: (err && err.message) || String(err) }; }

  if (res && res.ok) {
    confirmerExportGtn();
    messageCarte(t('gtnExportOk'), false);
    return;
  }
  const raison = (res && res.raison) || 'ecriture';
  const cles = {
    'plan-vide': 'gtnExportVide',
    'sim-introuvable': 'gtnExportSimIntrouvable',
    'paquet-introuvable': 'gtnExportPaquetIntrouvable',
    ecriture: 'gtnExportErr',
  };
  messageCarte(t(cles[raison] || 'gtnExportErr').replace('{err}', (res && res.error) || '?'), false);
});
