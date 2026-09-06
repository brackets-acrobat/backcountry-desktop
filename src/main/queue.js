/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// queue.js — file d'envoi hors-ligne des relevés.
//
// Si l'envoi échoue pour cause réseau (pas de connexion au serveur), le relevé
// est sérialisé dans un fichier JSON du dossier de file. Un flush() rejoue la
// file (au démarrage, périodiquement, et après une reconnexion réussie).
//
// Découplé de l'envoi : flush() reçoit la fonction d'envoi (sendFn) et décide de
// garder ou non chaque élément selon estReessayable() — voir cette fonction pour
// la règle et sa justification.
// ============================================================

const fs = require('fs');
const path = require('path');

// Un échec vaut-il d'être rejoué plus tard ?
//
//   • status 0 : aucune réponse HTTP — hors-ligne, DNS muet, serveur injoignable.
//   • 5xx      : panne côté serveur. Passagère par nature : c'est précisément le
//                cas où rejouer a le plus de sens.
//   • 429      : le serveur demande explicitement d'attendre.
//
// Tout le reste (400, 401, 403, 413, 422…) tient au CONTENU envoyé ou aux
// droits : rejouer le même corps redonnerait le même refus, mot pour mot.
//
// Cette fonction vivait auparavant implicitement dans flush(), sous la forme
// « status >= 400 → on retire ». Un 500 passager faisait donc disparaître le vol
// de la file au premier rejeu, sans trace — l'inverse de ce à quoi sert une file.
function estReessayable(res) {
  const status = (res && res.status) || 0;
  return status === 0 || status === 429 || status >= 500;
}

// Ajoute un relevé à la file. Retourne le chemin du fichier créé.
function enfiler(queueDir, releve) {
  fs.mkdirSync(queueDir, { recursive: true });
  const uid = releve._uid || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(queueDir, `${uid}.json`);
  fs.writeFileSync(file, JSON.stringify(releve, null, 2), 'utf-8');
  return file;
}

// Nombre d'éléments en attente.
function compter(queueDir) {
  try {
    return fs.readdirSync(queueDir).filter((f) => f.endsWith('.json')).length;
  } catch (_) {
    return 0;
  }
}

// Rejoue la file. sendFn(releve) → { ok, status, body }.
// Retourne { envoyes, restants }.
async function flush(queueDir, sendFn) {
  let envoyes = 0;
  let fichiers;
  try {
    fichiers = fs.readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return { envoyes: 0, restants: 0 };
  }

  for (const f of fichiers) {
    const p = path.join(queueDir, f);
    let releve;
    try {
      releve = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) {
      fs.unlinkSync(p);   // fichier corrompu → on l'enlève
      continue;
    }

    const res = await sendFn(releve);
    if (res.ok) {
      fs.unlinkSync(p);
      envoyes++;
    } else if (estReessayable(res)) {
      // Hors-ligne ou panne serveur : on GARDE le fichier, et on s'arrête là —
      // les suivants échoueraient de la même façon, autant ne pas marteler.
      break;
    } else {
      // Refus définitif (contenu, droits) : rejouer ne corrigera rien → on retire.
      fs.unlinkSync(p);
    }
  }

  return { envoyes, restants: compter(queueDir) };
}

module.exports = { enfiler, compter, flush, estReessayable };
