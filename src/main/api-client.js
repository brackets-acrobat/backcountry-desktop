/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// api-client.js — envoi des VOLS vers le site (POST /api/vol).
//
// Un vol entier part en une requête multipart/form-data : un champ `vol` (JSON :
// méta du vol + tableau des posers) et une photo par poser (`capture_<uid>`).
// Auth : header X-Api-Key. Réponse 201 → { ok, id_vol, nb }.
//
// Pas de dépendance externe : corps multipart construit à la main.
// Convention de retour : status 0 = échec RÉSEAU (à mettre en file).
// ============================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Envoie un VOL entier (méta + tous ses posers + photos) en une requête vers
// POST /api/vol. `vol` = { date_debut, date_fin, duree_sec, aeronef,
// depart_icao, arrivee_icao, landings:[{uid, ...champs relevé}], _captures:[{uid, path}] }.
// Le champ multipart `vol` = JSON (sans les champs internes _*), les photos
// sont des parts `capture_<uid>`. Convention de retour : status 0 = échec RÉSEAU.
function envoyerVol(cfg, vol) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(cfg.apiBaseUrl.replace(/\/+$/, '') + '/api/vol');
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

    // Champ `vol` : méta + posers, en retirant les champs internes (_*).
    const cleanLanding = (l) => {
      const out = {};
      for (const [k, v] of Object.entries(l)) {
        if (!k.startsWith('_') && v !== undefined) out[k] = v;
      }
      return out;
    };
    const volJson = {
      date_debut: vol.date_debut ?? null,
      date_fin: vol.date_fin ?? null,
      duree_sec: vol.duree_sec ?? null,
      aeronef: vol.aeronef ?? null,
      depart_icao: vol.depart_icao ?? null,
      arrivee_icao: vol.arrivee_icao ?? null,
      landings: (vol.landings || []).map(cleanLanding),
    };
    field('vol', JSON.stringify(volJson));

    // Une photo par poser : part `capture_<uid>`.
    for (const cap of (vol._captures || [])) {
      if (cap && cap.uid && cap.path && fs.existsSync(cap.path)) {
        const img = fs.readFileSync(cap.path);
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="capture_${cap.uid}"; filename="${path.basename(cap.path)}"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n', 'utf-8'
        ));
        parts.push(img);
        parts.push(Buffer.from('\r\n', 'utf-8'));
      }
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
          // CONTOURNEMENT PROVISOIRE — à retirer dès que l'hébergeur aura corrigé.
          //
          // Une règle de sécurité côté hébergement (o2switch) rejette toute
          // requête multipart/form-data comportant un fichier lorsqu'elle
          // n'a PAS d'en-tête Referer. Le refus n'est pas franc : la requête
          // est détournée vers un chemin inconnu, si bien que le site rend sa
          // page 404 — d'où un diagnostic long.
          //
          // Mesuré : avec fichier et sans Referer → 404 ; la MÊME requête avec
          // Referer → le contrôleur répond normalement. Ni l'User-Agent, ni
          // Origin, ni le chemin, ni la taille n'y changent rien.
          //
          // La règle vise le CSRF, qui ne concerne pas cet endpoint :
          // l'authentification s'y fait par X-Api-Key, pas par un cookie de
          // session. Une application native n'a par ailleurs aucune page
          // d'origine à déclarer — on pointe donc l'origine du service lui-même.
          Referer: url.origin + '/',
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

// Message lisible tiré d'une réponse en échec. L'API répond
// { ok:false, erreur:"…" } ; mais un 502 de reverse proxy ou le 404 du site
// renvoient une page HTML, qui arrive telle quelle dans `brut` — d'où le
// dégraissage des balises et la troncature. Sans cette fonction, la seule chose
// que l'appelant pouvait montrer était un compteur d'échecs.
function messageServeur(res) {
  const corps = (res && res.body) || {};
  if (typeof corps.erreur === 'string' && corps.erreur.trim()) return corps.erreur.trim();
  if (typeof corps.message === 'string' && corps.message.trim()) return corps.message.trim();
  if (typeof corps.brut === 'string' && corps.brut.trim()) {
    const texte = corps.brut.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (texte) return texte.length > 200 ? texte.slice(0, 200) + '…' : texte;
  }
  return (res && res.status) ? `HTTP ${res.status}` : 'aucune réponse du serveur';
}

module.exports = { envoyerVol, recupererLieux, messageServeur };
