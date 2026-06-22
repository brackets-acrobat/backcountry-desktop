/*
 * Backcountry Pathfinders — Desktop
 * Copyright (C) 2026 Cyril MILANI — GPL-3.0-or-later
 *
 * Extracteur de navaids MSFS 2024 REPRIS À L'IDENTIQUE de NavXpressVFR (même
 * méthode « traversance LNM » + seed bundlé). Seuls l'en-tête, le dossier de
 * sortie par défaut et le nom d'app SimConnect diffèrent.
 */

/* ============================================================
 * Extracteur navaids MONDIAL depuis MSFS 2024 (méthode "traversance LNM")
 * ------------------------------------------------------------
 * SimConnect ne peut pas lister les navaids mondiaux, MAIS on peut fetch
 * n'importe quel ICAO partout. On reconstruit donc la base :
 *   Phase 1 : requestFacilitiesList(AIRPORT) → aéroports mondiaux.
 *   Phase 2 : par aéroport, lire les legs d'approche → FIX_ICAO (seeds BFS).
 *   Phase 3 : BFS sur les airways (WAYPOINT→ROUTE) → récolte VOR/NDB + position.
 *   Phase 4 : fetch détail de chaque navaid (VOR/NDB) → freq/magvar/nom/flags.
 *   Phase 5 (DISCONNECTED) : OPTIONNELLE — si un fichier seed (ident,region,type)
 *     est présent (bundled-data/navaids-seed.csv.gz, façon LNM navaids24.csv),
 *     fetch CHAQUE (ident,région) du seed AVEC sa région → récupère les navaids
 *     isolés hors airways/procédures que le BFS rate (surtout NDB). Timeout court.
 *   Phase 6 : type, exclusion ILS, dédup + ID unique → navaids.jsonl (OurAirports).
 *
 * Idents NON uniques → clé = type|ident|region|lat|lon, ID séquentiel unique.
 * Pré-requis : MSFS 2024 lancé + vol chargé. Sortie : Documents/.../navaids.jsonl
 *   node extract-navaids-msfs.js [--seed-limit N] [--window N] [--out DIR] [--no-seed]
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { open: scOpen, Protocol: SCProtocol, FacilityListType } = require('node-simconnect');

const REQ_AIRPORTS = 7000;
const DEF_APPROACH = 1100, DEF_WPT = 1200, DEF_VOR = 1300, DEF_NDB = 1400;
const DEFAULT_OUT_DIR = path.join(os.homedir(), 'Documents', 'Backcountry Pathfinders', 'data');
const OUT_FILENAME = 'navaids.jsonl';
// Fichier seed des navaids déconnectés (liste ident,region,type). Cherché dans
// bundled-data/ (livré) puis dans le dossier NavXpressVFR de l'utilisateur (override).
const BUNDLED_SEED = path.join(__dirname, 'bundled-data', 'navaids-seed.csv.gz');
const DISCO_TIMEOUT_MS = 3000;   // timeout court : un navaid absent de FS2024 ne répond jamais

const LIST_INACTIVITY_MS = 12000, REQUEST_TIMEOUT_MS = 20000, STALL_MS = 90000, GLOBAL_TIMEOUT_MS = 60*60*1000;

const _dec = new TextDecoder('utf-8', { fatal: true });
function fixUtf8(s){ if(!s)return s; let c=s; for(let i=0;i<4;i++){let n;try{n=_dec.decode(Buffer.from(c,'latin1'));}catch(_){return c;} if(n===c)return c; c=n;} return c; }
function round(v,n){ const f=10**n; return Math.round(v*f)/f; }
function chrType(code){ return String.fromCharCode(code); } // 86=V 78=N 87=W
function isPseudoFix(icao){ return /^(RW|R\d|F[A-Z]?\d)/.test(icao) || /^\d/.test(icao); } // pistes/seuils

// Dérive le type OurAirports d'un VOR depuis les flags. null = ILS (à exclure).
// La liste "VOR" de MSFS contient aussi les ILS/localizers → on les écarte via
// HAS_GLIDE_SLOPE / LOCALIZER (cap localizer ≠ 0) / nom, comme le fait LNM.
function deriveVorType(d){
  const name = (d.NAME||'').toUpperCase();
  if (d.HAS_GLIDE_SLOPE || (Number.isFinite(d.LOCALIZER) && d.LOCALIZER !== 0)
      || d.TYPE === 4 || /\bILS\b|^ILS|\bLOC\b|LLZ/.test(name)) return null;
  if (d.IS_TACAN) return d.IS_NAV ? 'VORTAC' : 'TACAN';
  if (d.IS_NAV && d.IS_DME) return 'VOR-DME';
  if (d.IS_NAV && !d.IS_DME) return 'VOR';
  if (!d.IS_NAV && d.IS_DME) return 'DME';
  return 'VOR';
}
const M_TO_FT = 1/0.3048, M_TO_NM = 1/1852;
const readTrail = (d) => { const r=d.remaining(); return r>0?d.readString(r).replace(/\0.*$/,'').trim():''; };
// Parsing des nœuds détail (réutilisé par les phases vor/ndb ET disco).
function parseVorDet(d){
  return { VOR_LATITUDE:d.readFloat64(), VOR_LONGITUDE:d.readFloat64(), VOR_ALTITUDE:d.readFloat64(),
    IS_NAV:d.readInt32(), IS_DME:d.readInt32(), IS_TACAN:d.readInt32(), HAS_GLIDE_SLOPE:d.readInt32(),
    FREQUENCY:d.readInt32(), TYPE:d.readInt32(), NAV_RANGE:d.readFloat32(), MAGVAR:d.readFloat32(), LOCALIZER:d.readFloat32(),
    NAME:readTrail(d) };
}
function parseNdbDet(d){
  return { LATITUDE:d.readFloat64(), LONGITUDE:d.readFloat64(), ALTITUDE:d.readFloat64(),
    FREQUENCY:d.readInt32(), TYPE:d.readInt32(), RANGE:d.readFloat32(), MAGVAR:d.readFloat32(), NAME:readTrail(d) };
}

function runExtraction(opts = {}) {
  const WINDOW = opts.window > 0 ? opts.window : 80;
  const SEED_LIMIT = opts.seedLimit > 0 ? opts.seedLimit : 0; // 0 = tous les aéroports
  const MAX_BFS = opts.maxBfs > 0 ? opts.maxBfs : 0;          // 0 = illimité (test : borne le BFS)
  const OUT_DIR = opts.outDir || DEFAULT_OUT_DIR;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const OUT_FILE = path.join(OUT_DIR, OUT_FILENAME), TMP = OUT_FILE + '.tmp';
  const emit = p => { try{onProgress(p);}catch(_){} };

  return new Promise((resolve, reject) => {
    let handle=null, finished=false, simName='';
    const airports=[]; let listTotal=null, listLast=-1, listDone=false, lastList=Date.now();

    // Collecte
    const seedQueue=[];                 // waypoints à explorer (BFS) : {icao,region}
    const seenWpt=new Set();            // "icao|region" waypoints déjà mis en file
    const navCand=new Map();            // "T|icao|region|lat|lon" -> {t,icao,region,lat,lon}
    const navByIcao=new Map();          // "T|icao|region" -> liste de clés navCand (enrich)

    const inFlight=new Map(); const sendIdToReq=new Map(); let reqSeq=100000;
    let phase='', queue=[], qpos=0, watchdog=null, globalTimer=null, lastProgress=Date.now();
    let treated=0, target=0;

    function finish(reason){
      if(finished)return; finished=true;
      if(watchdog)clearInterval(watchdog); if(globalTimer)clearTimeout(globalTimer);
      try{handle&&handle.close();}catch(_){}
      emit({phase:'done', reason});
      resolve(buildResult(reason));
    }

    // ---------- résultat final : dédup + ID unique + écriture ----------
    let writtenCount=0, finalFile=null;
    function buildResult(reason){
      const recs=[]; const seen=new Set(); let id=1;
      for (const c of navCand.values()){
        const det=c.det;
        let type, freqKhz, name, magvar, rangeM, altM, lat, lon;
        if (c.t==='V'){
          if(!det) continue;            // pas de détail → ignore
          type = deriveVorType(det); if(!type) continue; // ILS exclu
          freqKhz = Number.isFinite(det.FREQUENCY)? round(det.FREQUENCY/1000,1):null;
          name = det.NAME||''; magvar = det.MAGVAR; rangeM = det.NAV_RANGE; altM = det.VOR_ALTITUDE;
          lat = Number.isFinite(det.VOR_LATITUDE)? det.VOR_LATITUDE : c.lat;
          lon = Number.isFinite(det.VOR_LONGITUDE)? det.VOR_LONGITUDE : c.lon;
        } else { // NDB
          type='NDB';
          freqKhz = det&&Number.isFinite(det.FREQUENCY)? round(det.FREQUENCY/1000,1):null;
          name = det? det.NAME||'' : ''; magvar = det? det.MAGVAR : null;
          rangeM = det? det.RANGE : null; altM = det? det.ALTITUDE : null;
          lat = det&&Number.isFinite(det.LATITUDE)? det.LATITUDE : c.lat;
          lon = det&&Number.isFinite(det.LONGITUDE)? det.LONGITUDE : c.lon;
        }
        lat=round(lat,6); lon=round(lon,6);
        const key=`${type}|${c.icao}|${c.region}|${lat}|${lon}`;
        if(seen.has(key))continue; seen.add(key);
        let mv = Number.isFinite(magvar)? (magvar>180?magvar-360:magvar) : '';
        recs.push({
          id: id++, ident:c.icao, name:fixUtf8(name)||c.icao, type,
          frequency_khz: freqKhz==null?'':freqKhz,
          latitude_deg:lat, longitude_deg:lon,
          elevation_ft: Number.isFinite(altM)? Math.round(altM*M_TO_FT):'',
          iso_country:'', iso_region:c.region,
          magnetic_variation_deg: mv===''?'':round(mv,1),
          range_nm: Number.isFinite(rangeM)&&rangeM>0? Math.round(rangeM*M_TO_NM):'',
          dme_frequency_khz:'', dme_channel:'', usageType:'', power:'', associated_airport:'',
          source:'msfs2024-traversal',
        });
      }
      try{ fs.mkdirSync(OUT_DIR,{recursive:true});
        fs.writeFileSync(TMP, recs.map(r=>JSON.stringify(r)).join('\n')+'\n','utf8');
        fs.renameSync(TMP, OUT_FILE); finalFile=OUT_FILE; writtenCount=recs.length;
      }catch(e){ /* ignore */ }
      const byType={}; for(const r of recs) byType[r.type]=(byType[r.type]||0)+1;
      return { ok:true, reason, sim:simName, airports:airports.length, navaids:writtenCount, byType, file:finalFile };
    }

    // ---------- définitions d'arbres ----------
    function defineAll(h){
      const add=(d,f)=>h.addToFacilityDefinition(d,f);
      // Procédures → legs (seeds). On lit transitions d'approche + SID + STAR
      // (ARRIVAL = 65% de fix enroute, le meilleur amorçage du BFS) ; la finale
      // seule donne des fix terminaux (N_ROUTES=0) qui ne propagent pas.
      const leg = (parent) => { add(DEF_APPROACH,'OPEN '+parent);
        ['TYPE','FIX_TYPE','FIX_LATITUDE','FIX_LONGITUDE','FIX_ICAO','FIX_REGION'].forEach(f=>add(DEF_APPROACH,f));
        add(DEF_APPROACH,'CLOSE '+parent); };
      add(DEF_APPROACH,'OPEN AIRPORT');
      add(DEF_APPROACH,'OPEN APPROACH');
      add(DEF_APPROACH,'OPEN APPROACH_TRANSITION'); leg('APPROACH_LEG'); add(DEF_APPROACH,'CLOSE APPROACH_TRANSITION');
      leg('FINAL_APPROACH_LEG');
      add(DEF_APPROACH,'CLOSE APPROACH');
      add(DEF_APPROACH,'OPEN DEPARTURE'); add(DEF_APPROACH,'OPEN ENROUTE_TRANSITION'); leg('APPROACH_LEG');
      add(DEF_APPROACH,'CLOSE ENROUTE_TRANSITION'); add(DEF_APPROACH,'CLOSE DEPARTURE');
      add(DEF_APPROACH,'OPEN ARRIVAL'); add(DEF_APPROACH,'OPEN ENROUTE_TRANSITION'); leg('APPROACH_LEG');
      add(DEF_APPROACH,'CLOSE ENROUTE_TRANSITION'); add(DEF_APPROACH,'CLOSE ARRIVAL');
      add(DEF_APPROACH,'CLOSE AIRPORT');
      // Waypoint + routes (BFS)
      add(DEF_WPT,'OPEN WAYPOINT'); ['LATITUDE','LONGITUDE','MAGVAR','TYPE','N_ROUTES','IS_TERMINAL_WPT'].forEach(f=>add(DEF_WPT,f));
      add(DEF_WPT,'OPEN ROUTE'); ['NEXT_TYPE','NEXT_LATITUDE','NEXT_LONGITUDE','PREV_TYPE','NEXT_ICAO','NEXT_REGION'].forEach(f=>add(DEF_WPT,f));
      add(DEF_WPT,'CLOSE ROUTE'); add(DEF_WPT,'CLOSE WAYPOINT');
      // VOR détail (champs LNM : position, flags ILS, range, élévation)
      add(DEF_VOR,'OPEN VOR');
      ['VOR_LATITUDE','VOR_LONGITUDE','VOR_ALTITUDE','IS_NAV','IS_DME','IS_TACAN','HAS_GLIDE_SLOPE','FREQUENCY','TYPE','NAV_RANGE','MAGVAR','LOCALIZER','NAME'].forEach(f=>add(DEF_VOR,f));
      add(DEF_VOR,'CLOSE VOR');
      // NDB détail (position directe + range + altitude + magvar)
      add(DEF_NDB,'OPEN NDB');
      ['LATITUDE','LONGITUDE','ALTITUDE','FREQUENCY','TYPE','RANGE','MAGVAR','NAME'].forEach(f=>add(DEF_NDB,f));
      add(DEF_NDB,'CLOSE NDB');
    }

    // ---------- parsing par phase ----------
    function onFacilityData(recv){
      const slot=inFlight.get(recv.userRequestId); if(!slot)return; const d=recv.data;
      try{
        if (phase==='seed' && (recv.type===8||recv.type===7)){
          d.readInt32(); const fixType=d.readInt32(); const flat=d.readFloat64(), flon=d.readFloat64();
          const icao=d.readString8().trim(), reg=d.readString8().trim();
          if(!icao||isPseudoFix(icao))return;
          const ch=chrType(fixType);
          if(ch==='W'){ const k=icao+'|'+reg; if(!seenWpt.has(k)){seenWpt.add(k); seedQueue.push({icao,region:reg});} }
          else if(ch==='V'||ch==='N'){ addNav(ch,icao,reg,flat,flon); }
        } else if (phase==='bfs'){
          if(recv.type===22){
            const nt=d.readInt32(), nlat=d.readFloat64(), nlon=d.readFloat64(); d.readInt32();
            const nicao=d.readString8().trim(), nreg=d.readString8().trim();
            if(!nicao)return; const ch=chrType(nt);
            if(ch==='W'){ const k=nicao+'|'+nreg; if(!seenWpt.has(k)){seenWpt.add(k); slot.children.push({icao:nicao,region:nreg});} }
            else if(ch==='V'||ch==='N'){ addNav(ch,nicao,nreg,nlat,nlon); }
          }
        } else if (phase==='vor'){
          slot.det = parseVorDet(d);
        } else if (phase==='ndb'){
          slot.det = parseNdbDet(d);
        } else if (phase==='disco'){
          slot.det = slot.item.t==='V' ? parseVorDet(d) : parseNdbDet(d);
        }
      }catch(_){}
    }
    function addNav(t,icao,region,lat,lon){
      const k=`${t}|${icao}|${region}|${round(lat,3)}|${round(lon,3)}`;
      if(navCand.has(k))return;
      const o={t,icao,region,lat,lon,det:null}; navCand.set(k,o);
      const ik=`${t}|${icao}|${region}`; if(!navByIcao.has(ik))navByIcao.set(ik,[]); navByIcao.get(ik).push(o);
    }
    // Ajoute un navaid découvert par la phase disco : position depuis le détail fetché.
    function addNavFromDet(t,icao,region,det){
      const lat = t==='V'?det.VOR_LATITUDE:det.LATITUDE, lon = t==='V'?det.VOR_LONGITUDE:det.LONGITUDE;
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
      const k=`${t}|${icao}|${region}|${round(lat,3)}|${round(lon,3)}`;
      if(navCand.has(k))return;
      const o={t,icao,region,lat,lon,det}; navCand.set(k,o);
      const ik=`${t}|${icao}|${region}`; if(!navByIcao.has(ik))navByIcao.set(ik,[]); navByIcao.get(ik).push(o);
    }

    function onDataEnd(recv){
      const slot=inFlight.get(recv.userRequestId); if(!slot)return; inFlight.delete(recv.userRequestId);
      treated++; lastProgress=Date.now();
      if(phase==='bfs'){ for(const c of slot.children) seedQueue.push(c); }
      if(phase==='vor'||phase==='ndb'){ if(slot.det) slot.target.det=slot.det; }
      if(phase==='disco'){ if(slot.det) addNavFromDet(slot.item.t, slot.item.icao, slot.item.region, slot.det); }
      pump();
    }

    // ---------- moteur fenêtré générique ----------
    function pump(){
      if(finished)return;
      const capped = (phase==='bfs' && MAX_BFS && treated>=MAX_BFS);
      while(!capped && inFlight.size<WINDOW && queue.length>qpos){
        const item=queue[qpos++]; const reqId=reqSeq++;
        const slot={item, startedAt:Date.now(), children:[], det:null, target:item.target||null};
        inFlight.set(reqId, slot); let sendId;
        try{
          if(phase==='seed') sendId=handle.requestFacilityData(DEF_APPROACH, reqId, item.icao);
          else if(phase==='bfs') sendId=handle.requestFacilityData(DEF_WPT, reqId, item.icao, item.region, 'W');
          else if(phase==='vor') sendId=handle.requestFacilityData(DEF_VOR, reqId, item.icao, item.region, 'V');
          else if(phase==='ndb') sendId=handle.requestFacilityData(DEF_NDB, reqId, item.icao, item.region, 'N');
          else if(phase==='disco') sendId=handle.requestFacilityData(item.t==='V'?DEF_VOR:DEF_NDB, reqId, item.icao, item.region, item.t);
        }catch(e){ inFlight.delete(reqId); continue; }
        if(typeof sendId==='number') sendIdToReq.set(sendId,reqId);
      }
      // BFS : réinjecte les waypoints découverts dans la file (sauf si borné)
      if(phase==='bfs' && !capped && seedQueue.length){ while(seedQueue.length) queue.push(seedQueue.shift()); }
      reportProgress();
      if((capped || qpos>=queue.length) && inFlight.size===0) nextPhase();
    }
    let _lastEmit=0;
    function reportProgress(force){
      const now=Date.now();
      if(!force && now-_lastEmit<250) return;   // throttle ~4 Hz (évite d'inonder l'IPC)
      _lastEmit=now;
      emit({phase, treated, target:queue.length, inFlight:inFlight.size, navaids:navCand.size, seeds:seenWpt.size });
    }

    // ---------- enchaînement des phases ----------
    function startSeed(){
      phase='seed'; let list = SEED_LIMIT? airports.slice(0,SEED_LIMIT) : airports;
      queue=list.map(a=>({icao:a.icao})); qpos=0; treated=0; lastProgress=Date.now(); reportProgress(true); pump();
    }
    function startBfs(){
      phase='bfs'; queue=seedQueue.splice(0); qpos=0; treated=0; lastProgress=Date.now(); reportProgress(true);
      if(!queue.length){ nextPhase(); return; } pump();
    }
    function startEnrich(t){
      phase=t==='V'?'vor':'ndb';
      const items=[]; for(const o of navCand.values()) if(o.t===t && !o.det) items.push({icao:o.icao, region:o.region, target:o});
      // dédup par icao|region pour ne pas refetch (on copiera le det sur tous les homonymes après)
      const uniq=new Map(); for(const it of items){const k=it.icao+'|'+it.region; if(!uniq.has(k))uniq.set(k,it);}
      queue=[...uniq.values()]; qpos=0; treated=0; lastProgress=Date.now(); reportProgress(true);
      if(!queue.length){ nextPhase(); return; } pump();
    }
    // Phase DISCONNECTED : lit le fichier seed (ident,region,type) et fetch chaque
    // (ident,région) AVEC sa région → récupère les navaids isolés non atteints par
    // le BFS. On saute ceux déjà trouvés (même ident|région).
    function startDisco(){
      let seedRows = null;
      if(!opts.noSeed) seedRows = loadSeed();
      if(!seedRows || !seedRows.length){ nextPhase(); return; }
      const q=[]; const seedSeen=new Set();
      for(const r of seedRows){
        const ik=`${r.t}|${r.icao}|${r.region}`;
        if(navByIcao.has(ik)) continue;          // déjà trouvé par le BFS/enrichissement
        if(seedSeen.has(ik)) continue; seedSeen.add(ik);
        q.push({icao:r.icao, region:r.region, t:r.t});
      }
      phase='disco'; queue=q; qpos=0; treated=0; lastProgress=Date.now(); reportProgress(true);
      if(!queue.length){ nextPhase(); return; } pump();
    }
    let phaseStep=0;
    function nextPhase(){
      // propage le détail aux homonymes (même icao|region) avant de changer de phase
      if(phase==='vor'||phase==='ndb'){
        for(const o of navCand.values()){ if(o.det)continue; const ik=`${o.t}|${o.icao}|${o.region}`;
          const list=navByIcao.get(ik); if(list){ const withDet=list.find(x=>x.det); if(withDet)o.det=withDet.det; } }
      }
      phaseStep++;
      if(phaseStep===1) startBfs();
      else if(phaseStep===2) startEnrich('V');
      else if(phaseStep===3) startEnrich('N');
      else if(phaseStep===4) startDisco();
      else finish('terminé');
    }
    // Charge le fichier seed (bundlé, ou override utilisateur dans NavXpressVFR/).
    // Retourne [{icao,region,t}] (V/N seulement) ou null si absent.
    function loadSeed(){
      const userSeed = path.join(OUT_DIR, '..', 'navaids24.csv.gz');
      const candidates = [BUNDLED_SEED, userSeed];
      for(const fp of candidates){
        try{
          if(!fs.existsSync(fp)) continue;
          const buf=fs.readFileSync(fp);
          const txt=(fp.endsWith('.gz')? zlib.gunzipSync(buf): buf).toString('utf8');
          const rows=[];
          for(const line of txt.split('\n')){
            if(!line)continue; const c=line.split(','); if(c.length<3)continue;
            const icao=c[0].trim(), region=c[1].trim(), t=c[2].trim();
            if((t==='V'||t==='N') && icao) rows.push({icao,region,t});
          }
          if(rows.length) return rows;
        }catch(_){ /* fichier illisible : on ignore */ }
      }
      return null;
    }

    // ---------- connexion ----------
    emit({phase:'connect'});
    scOpen('BackcountryPathfinders-NavaidsExtract', SCProtocol.SunRise).then(res=>{
      handle=res.handle; simName=(res.recvOpen&&res.recvOpen.applicationName)||'';
      emit({phase:'connected', sim:simName});
      try{ defineAll(handle); }catch(e){ try{handle.close();}catch(_){}; return reject(new Error('defineAll: '+e.message)); }

      handle.on('airportList', recv=>{
        if(recv.requestID!==REQ_AIRPORTS||listDone)return; lastList=Date.now();
        if(typeof recv.outOf==='number')listTotal=recv.outOf; if(typeof recv.entryNumber==='number')listLast=recv.entryNumber;
        for(const a of recv.airports) airports.push({icao:a.icao, region:a.region});
        emit({phase:'enumerate', enumerated:airports.length, packet:listLast+1, total:listTotal});
        if(listTotal!==null && listLast>=listTotal-1) onListDone();
      });
      handle.on('facilityData', onFacilityData);
      handle.on('facilityDataEnd', onDataEnd);
      handle.on('exception', ex=>{ const r=sendIdToReq.get(ex.sendId); if(r!==undefined){sendIdToReq.delete(ex.sendId); if(inFlight.delete(r)){treated++; pump();}} });
      handle.on('error', ()=>{}); handle.on('quit', ()=>finish('sim fermé'));

      handle.requestFacilitiesList(FacilityListType.AIRPORT, REQ_AIRPORTS);

      watchdog=setInterval(()=>{
        if(finished)return;
        if(!listDone && airports.length>0 && Date.now()-lastList>LIST_INACTIVITY_MS){ onListDone(); return; }
        if(!phase||phase==='')return;
        const now=Date.now(); let to=0;
        // Timeout court en phase disco (un navaid absent de FS2024 ne répond jamais).
        const TO = phase==='disco' ? DISCO_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        for(const [rid,s] of inFlight){ if(now-s.startedAt>TO){ inFlight.delete(rid); treated++; to++; } }
        if(to){ lastProgress=now; pump(); }   // un timeout EST une progression (anti-faux-stall)
        // Stall : en phase de COLLECTE (seed/bfs), on n'abandonne pas → on passe
        // à l'enrichissement avec ce qui est déjà collecté. Seul un stall pendant
        // l'enrichissement (vor/ndb) termine réellement.
        if(now-lastProgress>STALL_MS){
          if(phase==='seed'||phase==='bfs'){ inFlight.clear(); lastProgress=now; nextPhase(); }
          else finish('stall '+phase);
        }
      },1000);
      globalTimer=setTimeout(()=>finish('timeout global'), GLOBAL_TIMEOUT_MS);
    }).catch(err=>reject(new Error((err&&err.message)||'connexion impossible')));

    function onListDone(){ if(listDone)return; listDone=true; if(!airports.length){finish('aucun aéroport');return;} startSeed(); }
  });
}

module.exports = { runExtraction, OUT_FILENAME, DEFAULT_OUT_DIR };

// ---------------- CLI ----------------
if (require.main === module){
  const arg=(n,d)=>{const i=process.argv.indexOf(n);return i!==-1&&process.argv[i+1]?process.argv[i+1]:d;};
  const SEED_LIMIT=parseInt(arg('--seed-limit','0'),10)||0;
  const MAX_BFS=parseInt(arg('--max-bfs','0'),10)||0;
  const WINDOW=parseInt(arg('--window','80'),10)||80;
  const OUT_DIR=arg('--out',DEFAULT_OUT_DIR);
  const NO_SEED=process.argv.indexOf('--no-seed')!==-1;
  const PHASE_LABEL={connect:'Connexion…',seed:'Seeds (procédures)',bfs:'BFS airways',vor:'Détail VOR',ndb:'Détail NDB',disco:'Navaids déconnectés (seed)'};
  runExtraction({ seedLimit:SEED_LIMIT, maxBfs:MAX_BFS, window:WINDOW, outDir:OUT_DIR, noSeed:NO_SEED, onProgress:p=>{
    if(p.phase==='connected'){ console.log('Connecté :',p.sim); console.log(`Aéroports seed: ${SEED_LIMIT||'tous'}, fenêtre ${WINDOW}\n`); }
    else if(p.phase==='enumerate') process.stdout.write(`\r[aéroports] ${p.enumerated} (${p.packet}/${p.total??'?'})   `);
    else if(PHASE_LABEL[p.phase]) process.stdout.write(`\r[${PHASE_LABEL[p.phase]}] traités ${p.treated}/${p.target}  envol ${p.inFlight}  navaids ${p.navaids}  waypoints ${p.seeds}      `);
  }}).then(s=>{
    console.log('\n\n──────────────────────────────');
    console.log(`Fin (${s.reason}). Aéroports: ${s.airports}`);
    console.log(`Navaids écrits: ${s.navaids}`); console.log('Par type:', JSON.stringify(s.byType));
    console.log(s.file?`${s.file}`:'pas de fichier'); process.exit(0);
  }).catch(e=>{ console.log('\n',e.message); console.log('   → MSFS 2024 lancé avec un vol ?'); process.exit(1); });
}
