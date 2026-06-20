/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// api-client.js — envoi des relevés vers le site web communautaire.
//
// Endpoint : POST {apiBaseUrl}/api/releve
// Auth     : header X-Api-Key (le serveur accepte aussi Authorization: Bearer).
// Corps    : JSON. lat/lon obligatoires. Champs acceptés par le serveur :
//   date_releve, altitude_m, type_surface, etat_surface, friction,
//   longueur_utile_m, pente_max_pct, denivele_m, profil_relief[],
//   aeronef, capture, commentaire
// Réponse 201 → { ok, id_releve, id_lieu, nouveau_lieu }
// La déduplication du lieu est gérée CÔTÉ SERVEUR.
//
// Pas de dépendance externe : on utilise http/https natifs de Node.
// ============================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Envoie un relevé. cfg = config effective (apiBaseUrl, apiKey).
// releve = objet JSON (au minimum { latitude, longitude }).
// Retour : { ok, status, body } — body est l'objet JSON renvoyé par le serveur.
function envoyerReleve(cfg, releve) {
  return new Promise((resolve) => {
    let url;
    try {
      // Concaténation directe : un chemin commençant par « / » dans new URL(path, base)
      // serait résolu à la RACINE du domaine et perdrait le préfixe (/backcountry).
      url = new URL(cfg.apiBaseUrl.replace(/\/+$/, '') + '/api/releve');
    } catch (e) {
      return resolve({ ok: false, status: 0, body: { erreur: 'apiBaseUrl invalide: ' + e.message } });
    }

    const payload = Buffer.from(JSON.stringify(releve), 'utf-8');
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': payload.length,
          'X-Api-Key': cfg.apiKey || '',
          'User-Agent': 'BackcountryPathfinders-Desktop',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let body;
          try { body = JSON.parse(data); } catch (_) { body = { brut: data }; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
        });
      }
    );

    req.on('error', (err) => resolve({ ok: false, status: 0, body: { erreur: err.message } }));
    req.write(payload);
    req.end();
  });
}

module.exports = { envoyerReleve };
