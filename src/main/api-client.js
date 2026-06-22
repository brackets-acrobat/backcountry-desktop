/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// api-client.js — envoi des relevés vers le site (POST /api/releve).
//
// Format multipart/form-data : tous les champs du relevé en form-fields
// (profil_relief sérialisé en JSON), + un champ `uid` (id du poser, sert à
// nommer la photo côté serveur) + un fichier `capture` optionnel (la photo).
// Auth : header X-Api-Key. Réponse 201 → { ok, id_releve, id_lieu,
// nouveau_lieu, capture }.
//
// Pas de dépendance externe : corps multipart construit à la main.
// Convention de retour : status 0 = échec RÉSEAU (à mettre en file).
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Envoie un relevé (+ image éventuelle). imagePath = chemin local du JPEG ou null.
function envoyer(cfg, releve, imagePath = null) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(cfg.apiBaseUrl.replace(/\/+$/, '') + '/api/releve');
    } catch (e) {
      return resolve({ ok: false, status: 0, body: { erreur: 'apiBaseUrl invalide: ' + e.message } });
    }

    const boundary = '----bcp' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const parts = [];
    const field = (name, value) => {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf-8'
      ));
    };

    for (const [k, v] of Object.entries(releve)) {
      if (k.startsWith('_')) continue;            // champs internes (_uid, _capturePath…)
      if (v === null || v === undefined) continue;
      const val = (k === 'profil_relief' && typeof v !== 'string') ? JSON.stringify(v) : String(v);
      field(k, val);
    }
    if (releve._uid) field('uid', releve._uid);

    if (imagePath && fs.existsSync(imagePath)) {
      const img = fs.readFileSync(imagePath);
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="capture"; filename="${path.basename(imagePath)}"\r\n` +
        'Content-Type: image/jpeg\r\n\r\n', 'utf-8'
      ));
      parts.push(img);
      parts.push(Buffer.from('\r\n', 'utf-8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
    const body = Buffer.concat(parts);

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'X-Api-Key': cfg.apiKey || '',
          'User-Agent': 'BackcountryPathfinders-Desktop',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch (_) { parsed = { brut: data }; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, status: 0, body: { erreur: err.message } }));
    req.write(body);
    req.end();
  });
}

// Récupère la liste publique des lieux de poser (GET /api/lieux). Endpoint
// public : pas d'auth requise. Réponse attendue { ok, lieux: [...] }.
// Retour : { ok, lieux } en succès, { ok: false, status, error } sinon.
function recupererLieux(cfg) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(cfg.apiBaseUrl.replace(/\/+$/, '') + '/api/lieux');
    } catch (e) {
      return resolve({ ok: false, status: 0, error: 'apiBaseUrl invalide: ' + e.message });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BackcountryPathfinders-Desktop',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch (_) { parsed = null; }
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed && parsed.ok) {
            resolve({ ok: true, lieux: Array.isArray(parsed.lieux) ? parsed.lieux : [] });
          } else {
            resolve({ ok: false, status: res.statusCode, error: 'réponse inattendue' });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.end();
  });
}

module.exports = { envoyer, recupererLieux };
