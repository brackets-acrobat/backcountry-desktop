# Backcountry Pathfinders — Desktop

Application **desktop indépendante** (Electron / Windows, connectée à MSFS 2024 via
**SimConnect**) d'acquisition de pistes de brousse pour le projet communautaire
**Backcountry Pathfinders**. Elle détecte les posers sur des terrains non répertoriés
(altisurfaces, bancs de sable, clairières…), relève les caractéristiques du spot, et
envoie ces relevés au site web communautaire.

> Projet **séparé** de NavXpressVFR (aucune dépendance de code), mais il en **réutilise
> les patterns éprouvés** : connexion SimConnect (protocole FSX_SP2) et machine à états
> du poser (logique 2/3 du carnet de vol).

## Démarrage

```bash
npm install
cp config.example.json config.json   # puis renseigner apiKey
npm start                              # nécessite MSFS 2024 lancé pour SimConnect
```

`config.json` est **gitignoré** (il contient la clé API). Voir `config.example.json`.

## Architecture

```
                ┌─────────────────────────────┐
                │     Backcountry Engine       │
                └──────────────┬──────────────┘
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  [SimConnect API]      [Overpass / OSM]      [Local Math Engine]
  - GROUND ALTITUDE      - lits de rivière      - altitude-densité
  - SURFACE TYPE/COND    - lignes électriques   - triangle des vents
  - SIM ON GROUND        - clairières           - coeff. de freinage
  - GROUND VELOCITY                             - longueur (géométrie)
```

### Arborescence

| Fichier | Rôle | État |
|---|---|---|
| `src/main/main.js` | Process principal Electron, fenêtre, IPC | ✅ |
| `src/main/config.js` | Chargement `config.json` | ✅ |
| `src/main/simconnect.js` | Connexion + lecture SimVars (porté NavXpress) | ✅ |
| `src/main/math-engine.js` | Altitude-densité, vent, longueur géométrique, pente | ✅ |
| `src/main/api-client.js` | `POST /api/releve` (header `X-Api-Key`) | ✅ |
| `src/main/fsm.js` | Machine à états du poser | 🚧 stub + contrat |
| `src/main/scan.js` | Buffer profil relief (passage bas) | 🚧 stub + contrat |
| `src/main/capture.js` | Capture d'écran staging | 🚧 stub + contrat |
| `src/main/airports-data.js` | Bases MSFS extraites : bbox, code, recherche par nom | ✅ |
| `src/main/export-gtn750.js` | Dépose le plan de vol (`fpl.pln`) dans le GTN750 de PMS50 | ✅ |
| `src/main/addons-scan.js` | Détection des terrains add-on par lecture des paquets sur le disque | ✅ |
| `src/preload.js` | Pont sécurisé (contextIsolation) | ✅ |
| `src/renderer/renderer.js` | Socle de l'UI : carte, route, legs, profil, imports | ✅ |
| `src/renderer/js/features/` | Fonctionnalités de navigation (voir ci-dessous) | ✅ |

### Fonctionnalités de navigation (`src/renderer/js/features/`)

Scripts classiques chargés **après** `renderer.js`, dont ils réutilisent la carte, la
route, la déclinaison et les modales. Aucun module : même mécanisme de portée globale
partagée que le socle.

| Fichier | Rôle |
|---|---|
| `chronos.js` | Chronomètre (MM:SS) et temps de vol (HH:MM:SS) |
| `recherche-lieux.js` | Recherche d'un aérodrome / navaid par code OACI ou par nom |
| `inverser-plan.js` | Inversion du plan de vol (départ ↔ arrivée) |
| `mesure-carte.js` | Mesure de distance et de route sur la carte |
| `flanquement.js` | Flanquement VOR (radial magnétique vers un point de la route) |
| `compas.js` | Rose des vents magnétique (portage de Little Navmap) |
| `export-gtn750.js` | Construction du PLN pour le GTN750 de PMS50 |
| `addons.js` | Détection des terrains fournis par un paquet add-on (anneau jaune sur la carte) |

## Briques SimConnect (validées)

- **`GROUND ALTITUDE`** — relief sous l'avion, lisible **en vol** à toute altitude. Donnée centrale du scan de profil.
- **`SURFACE TYPE`** — enum sol (Grass, Sand, Dirt, Gravel, Snow…). Fiable **uniquement au contact**. « Mud » n'existe pas → assimilé à Dirt.
- **`SURFACE CONDITION`** — Normal / Wet / Icy / Snow. Au sol également.
- **`PLANE ALT ABOVE GROUND`** — hauteur-sol, garde-fou du passage bas (< 500 ft).
- **`SIM ON GROUND` / `BRAKE PARKING POSITION` / `GROUND VELOCITY`** — détection et validation du poser (FSM).
- **`AIRSPEED TRUE`** — vitesse propre, seule source de Vp pour l'angle de crabe de la rose des vents.
- **`GPS GROUND TRUE TRACK`** — route sol vraie, tracée par la rose des vents (trait TRK).
- **Friction** — pas de SimVar directe : à dériver empiriquement de la décélération au freinage.

**Conséquence de conception majeure** : un *lieu* = fusion de **deux phases** du même
endroit — le **profil de relief** vient du passage bas (optionnel), le **type/état de
sol** (+ friction) vient de la **course d'atterrissage**.

## Décisions de conception

- **Mode principal = détecter le POSER**, puis tout relever au toucher + roulage. Le passage bas (scan relief) est rétrogradé en **reconnaissance optionnelle**.
- **Deux distances de performance** distinctes : atterrissage (« je rentre ? ») et décollage (« je ressors ? »).
- **Longueur disponible** dérivée de la **géométrie** d'une polyligne tracée, pas d'un roulage.
- **Capture d'écran** : capture desktop programmatique (façon Greenshot), pas via SimConnect.

## Contrat de l'API web

`POST {apiBaseUrl}/api/releve` — auth header **`X-Api-Key`** (ou `Authorization: Bearer`).

Corps JSON (**`latitude` + `longitude` obligatoires**) :

```json
{
  "latitude": 45.5, "longitude": 3.1, "date_releve": "2026-06-20 14:30:00",
  "altitude_m": 1100, "type_surface": "Grass", "etat_surface": "Normal",
  "friction": 0.42, "longueur_utile_m": 240, "pente_max_pct": 3.5,
  "denivele_m": 4, "profil_relief": [], "aeronef": "Kitfox",
  "capture": "fichier.jpg", "commentaire": "…"
}
```

Réponse `201` → `{ ok, id_releve, id_lieu, nouveau_lieu }`. La **déduplication du lieu
est gérée côté serveur** (rayon géographique).

## Roadmap

- **Jalon 1 — Pipeline live** ✅ : fenêtre + connexion SimConnect + lecture en direct des SimVars clés.
- **Jalon 2 — FSM + relevé** 🚧 : détection du poser, relevé au contact, mesure de friction, scan relief au passage bas, calculs de perf.
- **Jalon 3 — Capture + envoi** : capture d'écran staging + revue, envoi des relevés vers le site, file d'attente hors-ligne.
- **Jalon 4 — Carte & Go/No-Go** : carte Leaflet, tracé de piste improvisée, profil vertical, verdict feu vert/orange/rouge.
- **Plus tard** : profils d'avion, « First Ascent », packaging/installeur.

## Licence

GPL-3.0-or-later — © 2026 Cyril MILANI.
