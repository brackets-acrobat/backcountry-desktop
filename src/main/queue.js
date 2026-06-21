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
// Découplé de l'envoi : flush() reçoit la fonction d'envoi (sendFn) et ne juge
// « réseau » que les échecs sans réponse HTTP (status 0) ; un refus serveur
// (4xx/5xx) retire quand même l'élément de la file (rejouer ne servirait à rien).
// ============================================================

const fs = require('fs');
const path = require('path');

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
    } else if (res.status && res.status >= 400) {
      // Refus serveur (relevé invalide…) : rejouer ne corrigera rien → on retire.
      fs.unlinkSync(p);
    } else {
      // Échec réseau (status 0) : on garde et on s'arrête (toujours hors-ligne).
      break;
    }
  }

  return { envoyes, restants: compter(queueDir) };
}

module.exports = { enfiler, compter, flush };
