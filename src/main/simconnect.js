/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 */

// ============================================================
// simconnect.js — connexion SimConnect + lecture des SimVars de brousse.
//
// Porté de la connexion éprouvée de NavXpressVFR (protocole FSX_SP2, pattern
// open() / addToDataDefinition / requestDataOnSimObject / 'simObjectData').
//
// Cadence : groupe lu à SIM_FRAME (chaque image) pour permettre à la FSM
// d'échantillonner le poser à 0,5 s avec des données FRAÎCHES. On en déduit :
//   - 'frame' : émis à CHAQUE image (consommé par la FSM dans le main process)
//   - 'scan'  : émis au plus 1×/seconde (throttle) pour rafraîchir l'UI sans
//               inonder l'IPC
//   - 'status': état de connexion
//
// SimVars (cf. note de conception) :
//   GROUND ALTITUDE        → relief sous l'avion (donnée centrale)
//   SURFACE TYPE / COND    → sol, fiables au contact
//   PLANE ALT ABOVE GROUND → hauteur-sol (détection vol / poser)
//   SIM ON GROUND / GROUND VELOCITY / BRAKE PARKING → FSM du poser
//   LOCAL TIME/YEAR/MONTH/DAY → date+heure LOCALE du simulateur (horodatage)
// ============================================================

const EventEmitter = require('events');
const {
  open: scOpen,
  Protocol: SCProtocol,
  SimConnectDataType: SCDataType,
  SimConnectPeriod: SCPeriod,
  SimConnectConstants: SCConst,
} = require('node-simconnect');

const SC_SCAN_DEF_ID = 1;
const SC_SCAN_REQ_ID = 1;

const UI_THROTTLE_MS = 1000; // cadence d'émission vers le renderer (UI)

// Enum MSFS SURFACE TYPE → libellé. « Mud » n'existe pas (assimilé à Dirt).
const SURFACE_TYPES = [
  'Concrete', 'Grass', 'Water', 'Grass bumpy', 'Asphalt', 'Short grass',
  'Long grass', 'Hard turf', 'Snow', 'Ice', 'Urban', 'Forest', 'Dirt',
  'Coral', 'Gravel', 'Oil treated', 'Steel mats', 'Bituminus', 'Brick',
  'Macadam', 'Planks', 'Sand', 'Shale', 'Tarmac', 'Wright flyer track',
];
const SURFACE_CONDITIONS = ['Normal', 'Wet', 'Icy', 'Snow'];

function libelleSurface(v) { return SURFACE_TYPES[v] ?? `Inconnu (${v})`; }
function libelleCondition(v) { return SURFACE_CONDITIONS[v] ?? `Inconnu (${v})`; }

// Construit l'horodatage LOCAL du simulateur « AAAA-MM-JJ HH:MM:SS »
// (format attendu par l'API : Y-m-d H:i:s).
function buildSimLocal(year, month, day, secondsSinceMidnight) {
  const p2 = (n) => String(n).padStart(2, '0');
  const hh = Math.floor(secondsSinceMidnight / 3600) % 24;
  const mm = Math.floor(secondsSinceMidnight / 60) % 60;
  const ss = Math.floor(secondsSinceMidnight) % 60;
  if (!year || !month || !day) return null;
  return `${year}-${p2(month)}-${p2(day)} ${p2(hh)}:${p2(mm)}:${p2(ss)}`;
}

class SimConnectClient extends EventEmitter {
  constructor() {
    super();
    this._handle = null;
    this._connecting = false;
    this._lastUiEmit = 0;
  }

  estConnecte() { return !!this._handle; }

  async connecter() {
    if (this._handle) return { ok: true, alreadyConnected: true };
    if (this._connecting) return { ok: false, error: 'connect-in-progress' };

    this._connecting = true;
    this.emit('status', { state: 'connecting' });

    try {
      const { recvOpen, handle } = await scOpen('BackcountryPathfinders', SCProtocol.FSX_SP2);
      this._handle = handle;
      this._connecting = false;
      this.emit('status', { state: 'connected', app: recvOpen.applicationName });
      this._definirScan(handle);
      this._brancherEvenements(handle);
      return { ok: true };
    } catch (err) {
      this._connecting = false;
      this.emit('status', { state: 'disconnected', error: err && err.message });
      return { ok: false, error: err && err.message };
    }
  }

  async deconnecter() {
    if (this._handle) {
      try { this._handle.close(); } catch (_) {}
      this._handle = null;
    }
    this.emit('status', { state: 'disconnected' });
  }

  // L'ORDRE des addToDataDefinition fixe l'ordre de lecture dans 'simObjectData'.
  _definirScan(handle) {
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'PLANE LATITUDE',             'degrees', SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'PLANE LONGITUDE',            'degrees', SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'PLANE ALTITUDE',            'feet',    SCDataType.FLOAT64); // MSL
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'PLANE ALT ABOVE GROUND',    'feet',    SCDataType.FLOAT64); // AGL
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'GROUND ALTITUDE',           'feet',    SCDataType.FLOAT64); // relief
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'SURFACE TYPE',              'Enum',    SCDataType.INT32);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'SURFACE CONDITION',         'Enum',    SCDataType.INT32);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'GROUND VELOCITY',           'knots',   SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'PLANE HEADING DEGREES TRUE', 'degrees', SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'SIM ON GROUND',             'Bool',    SCDataType.INT32);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'BRAKE PARKING POSITION',    'Bool',    SCDataType.INT32);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'GENERAL ENG COMBUSTION:1',  'Bool',    SCDataType.INT32);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'GENERAL ENG COMBUSTION:2',  'Bool',    SCDataType.INT32);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'LOCAL TIME',                'seconds', SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'LOCAL YEAR',               'number',  SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'LOCAL MONTH OF YEAR',      'number',  SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'LOCAL DAY OF MONTH',       'number',  SCDataType.FLOAT64);
    handle.addToDataDefinition(SC_SCAN_DEF_ID, 'TITLE',                    null,      SCDataType.STRING256); // aéronef (constant)

    handle.requestDataOnSimObject(
      SC_SCAN_REQ_ID, SC_SCAN_DEF_ID, SCConst.OBJECT_ID_USER,
      SCPeriod.SIM_FRAME, 0, 0, 0, 0
    );
  }

  _brancherEvenements(handle) {
    handle.on('simObjectData', (data) => {
      if (data.requestID !== SC_SCAN_REQ_ID) return;
      try {
        // Lecture dans l'ordre EXACT de la définition ci-dessus.
        const lat          = data.data.readFloat64();
        const lon          = data.data.readFloat64();
        const amslFt       = data.data.readFloat64();
        const aglFt        = data.data.readFloat64();
        const groundAltFt  = data.data.readFloat64();
        const surfaceType  = data.data.readInt32();
        const surfaceCond  = data.data.readInt32();
        const groundSpeedKt = data.data.readFloat64();
        const headingTrue  = data.data.readFloat64();
        const onGround     = data.data.readInt32() !== 0;
        const parkingBrake = data.data.readInt32() !== 0;
        const eng1         = data.data.readInt32() !== 0;
        const eng2         = data.data.readInt32() !== 0;
        const localTime    = data.data.readFloat64();
        const localYear    = data.data.readFloat64();
        const localMonth   = data.data.readFloat64();
        const localDay     = data.data.readFloat64();
        const aircraftTitle = data.data.readString256();

        const frame = {
          lat, lon, amslFt, aglFt, groundAltFt,
          surfaceType, surfaceTypeLabel: libelleSurface(surfaceType),
          surfaceCond, surfaceCondLabel: libelleCondition(surfaceCond),
          groundSpeedKt, headingTrue, onGround, parkingBrake,
          engineOn: eng1 || eng2,
          aircraftTitle,
          simLocal: buildSimLocal(localYear, localMonth, localDay, localTime),
          t: Date.now(),
        };

        // Chaque image → FSM (in-process, peu coûteux).
        this.emit('frame', frame);

        // Throttle pour l'UI (renderer).
        if (frame.t - this._lastUiEmit >= UI_THROTTLE_MS) {
          this._lastUiEmit = frame.t;
          this.emit('scan', frame);
        }
      } catch (err) {
        this.emit('status', { state: 'connected', warn: 'lecture KO: ' + (err && err.message) });
      }
    });

    handle.on('exception', (ex) => {
      this.emit('status', { state: 'connected', warn: 'exception SimConnect: ' + JSON.stringify(ex) });
    });

    const onPerte = () => { this._handle = null; this.emit('status', { state: 'disconnected' }); };
    handle.on('quit', onPerte);
    handle.on('close', onPerte);
  }
}

module.exports = { SimConnectClient, SURFACE_TYPES, SURFACE_CONDITIONS, libelleSurface, libelleCondition };
