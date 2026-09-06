/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// chronos.js — chronomètre (MM:SS) et temps de vol (HH:MM:SS).
//
// Repris de Clear Sky VFR (features/chronos.js), lui-même issu de NavXpressVFR.
// Les deux compteurs comptent À LA HAUSSE : le second n'est pas un décompte,
// c'est le même mécanisme en format long, pour le temps de vol.
//
// ── Un seul bouton pour marche et arrêt ─────────────────────────────────────
// L'icône porte l'action à venir : ▶ au repos, ❙❙ en marche. Deux boutons
// séparés obligeraient à en griser un en permanence, pour deux fois la place
// dans une barre qui n'en a pas.
//
// ── Le temps se lit à l'horloge, pas aux battements ─────────────────────────
// Chaque tick recalcule l'écoulé depuis Date.now() au lieu d'additionner des
// intervalles : un setInterval en retard — fenêtre en arrière-plan, machine
// chargée — ferait alors perdre du temps au compteur. Le battement à 250 ms ne
// sert donc qu'à rafraîchir l'affichage, jamais à compter.
//
// Les compteurs sont INDÉPENDANTS de SimConnect : ils ne se figent pas quand le
// simulateur est en pause, et ne démarrent pas tout seuls au décollage. C'est le
// pilote qui les lance, comme le chronomètre d'un tableau de bord. (La FSM du
// poser, elle, mesure déjà le temps bloc du vol pour l'envoi au site : ce sont
// deux mesures différentes, on ne les confond pas.)
// ============================================================

const CHRONO_BATTEMENT_MS = 250;   // rafraîchissement de l'affichage

// MM:SS n'a pas d'heures : passé 99:59, le chronomètre s'y arrête et y reste.
// Ne plafonner QUE les minutes ferait repartir l'affichage à 99:00, 99:01… — un
// compteur qui semble tourner alors qu'il ne veut plus rien dire. Un plafond
// franc se lit pour ce qu'il est : hors d'échelle.
const CHRONO_MMSS_MAX_S = 99 * 60 + 59;

class Chrono {
  // format : 'mmss' (00:00) ou 'hhmmss' (00:00:00)
  constructor(affichage, format, boutonReset) {
    this.affichage = affichage;
    this.format = format;
    this.boutonReset = boutonReset;
    this.ecoule = 0;        // ms cumulées
    this.origine = null;    // Date.now() du dernier démarrage, écoulé déduit
    this.battement = null;
    this.enMarche = false;
    this.rendre();
    this.majBoutons();
  }

  demarrer() {
    if (this.enMarche) return;
    this.enMarche = true;
    this.origine = Date.now() - this.ecoule;   // reprend là où il s'était arrêté
    this.synchroniser();
    this.majBoutons();
  }

  arreter() {
    if (!this.enMarche) return;
    this.ecoule = Date.now() - this.origine;
    this.enMarche = false;
    this.synchroniser();
    this.rendre();
    this.majBoutons();
  }

  remettreAZero() {
    this.enMarche = false;
    this.ecoule = 0;
    this.origine = null;
    this.synchroniser();
    this.rendre();
    this.majBoutons();
  }

  // Met le battement en accord avec l'état, et marque l'affichage en marche.
  synchroniser() {
    if (this.enMarche && this.battement === null) {
      this.battement = setInterval(() => {
        this.ecoule = Date.now() - this.origine;
        this.rendre();
      }, CHRONO_BATTEMENT_MS);
    } else if (!this.enMarche && this.battement !== null) {
      clearInterval(this.battement);
      this.battement = null;
    }
    if (this.affichage) this.affichage.classList.toggle('est-en-marche', this.enMarche);
  }

  rendre() {
    if (!this.affichage) return;
    const deux = (n) => String(n).padStart(2, '0');
    const total = Math.floor(this.ecoule / 1000);
    if (this.format === 'mmss') {
      // Le plafond s'applique au TOTAL, pas aux minutes seules : sinon les
      // secondes continueraient de défiler sous des minutes figées.
      const borne = Math.min(total, CHRONO_MMSS_MAX_S);
      this.affichage.textContent = deux(Math.floor(borne / 60)) + ':' + deux(borne % 60);
    } else {
      this.affichage.textContent = deux(Math.floor(total / 3600)) + ':'
        + deux(Math.floor((total % 3600) / 60)) + ':' + deux(total % 60);
    }
  }

  // Rien à remettre à zéro tant qu'il n'a jamais tourné : le bouton le dit.
  majBoutons() {
    if (this.boutonReset) this.boutonReset.disabled = (this.ecoule === 0 && !this.enMarche);
  }
}

// Câble un compteur à son bouton bascule et à son bouton de remise à zéro.
// L'icône ET l'infobulle suivent l'état ; l'infobulle passe par data-i18n-title
// pour que la bascule de langue relise la bonne clé (applyTranslations).
function brancherChrono(chrono, bascule, reset) {
  if (!bascule) return;
  const icone = bascule.querySelector('i');
  const accorder = () => {
    if (icone) icone.className = chrono.enMarche ? 'ph-light ph-pause' : 'ph-light ph-play';
    const cle = chrono.enMarche ? 'chronoStop' : 'chronoStart';
    bascule.setAttribute('data-i18n-title', cle);
    bascule.title = t(cle);
  };
  bascule.addEventListener('click', () => {
    if (chrono.enMarche) chrono.arreter(); else chrono.demarrer();
    accorder();
  });
  if (reset) reset.addEventListener('click', () => { chrono.remettreAZero(); accorder(); });
  accorder();
}

// Les deux compteurs de la barre. Construits au chargement du fichier : ils ne
// touchent que des éléments déjà présents dans la page, et ne comptent rien
// avant qu'on appuie sur ▶.
const _chrono = new Chrono($('chrono-display'), 'mmss', $('chrono-reset'));
const _tempsVol = new Chrono($('timer-display'), 'hhmmss', $('timer-reset'));
brancherChrono(_chrono, $('chrono-toggle'), $('chrono-reset'));
brancherChrono(_tempsVol, $('timer-toggle'), $('timer-reset'));
