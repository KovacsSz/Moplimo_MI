/**
 * SMT Pick and Place Machine Controller
 * Express + Socket.IO backend server
 *
 * ─── STATE MACHINE ────────────────────────────────────────────────────────────
 *
 *  START PHASE
 *  ──────────
 *  1. Scan COM ports, find the one where ID4 responds.
 *  2. Once ID4 alive → watch for ID5.
 *  3. Once ID5 alive AND web-client > 0 → run init (set PAGE=1 on all stations).
 *  4. Init success → enter WORKING PHASE.
 *
 *  WORKING PHASE  (cyclic monitor every MONITOR_INTERVAL_MS)
 *  ─────────────
 *  Condition matrix:
 *
 *  awaitingAck  clients  ID5  ID4  │ action
 *  ─────────────────────────────────┼──────────────────────────────────────────
 *    true         *       *    *   │ do nothing — wait for operator to confirm
 *    false        0       *    *   │ set PAGE=0 → wait for client
 *    false       >0       Y    Y   │ normal operation (PAGE already 1 or 2)
 *    false       >0       N    Y   │ prune list to [ID4] → watch ID5 cyclically
 *    false       >0       N    N   │ clear list → watch ID4 cyclically
 *
 *  Re-entry to normal operation always:
 *    ID4 alive AND ID5 alive AND clients > 0  →  runInitSequence() → resume
 *
 *  KEY RULE: when ID5 is offline, availableStations is pruned to [ID4_SLAVE_ID]
 *  so NO Modbus communication reaches ID1/2/3 until full re-init completes.
 */

'use strict';

// ─── GLOBAL SAFETY NET ───────────────────────────────────────────────────────
process.on('uncaughtException',  (e) => console.warn('[Process] uncaughtException:', e.message));
process.on('unhandledRejection', (r) => console.warn('[Process] unhandledRejection:', r));

const express        = require('express');
const http           = require('http');
const { Server: SocketIOServer } = require('socket.io');
const cors           = require('cors');
const path           = require('path');
const { SerialPort } = require('serialport');
const ModbusRTU      = require('modbus-serial');

const ModbusHandler  = require('./src/modbusHandler');
const StationManager = require('./src/stationManager');
const {
  PCB_LOADER_SLAVE_ID,
  SLAVE_IDS,
  PageID,
  DefaultComponentCounts,
  HoldingRegisterAddresses,
  CoilAddresses,
  DiscreteInputAddresses,
  MODBUS_BAUDRATE,
  MODBUS_PARITY,
  MODBUS_DATA_BITS,
  MODBUS_STOP_BITS,
} = require('./src/modbusDefinitions');

// ─── APP ─────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ID4_SLAVE_ID         = 4;
const PORT_RESCAN_DELAY_MS = 200;
const PROBE_TIMEOUT_MS     = 100;
const MONITOR_INTERVAL_MS  = 200;
const PING_RETRIES         = 2;
const PING_RETRY_DELAY_MS  = 100;

const PARITY_MAP = { N: 'none', E: 'even', O: 'odd' };

// ─── PHASE / WORK-STATE ENUMS ─────────────────────────────────────────────────

const Phase = Object.freeze({
  START:   'start',
  WORKING: 'working',
});

const WorkState = Object.freeze({
  NORMAL:    'normal',
  NO_CLIENT: 'no_client',
  WAIT_ID5:  'wait_id5',
  WAIT_ID4:  'wait_id4',
});

// ─── STATE ────────────────────────────────────────────────────────────────────

let phase     = Phase.START;
let workState = WorkState.NORMAL;

let modbusHandler     = null;
let stationManager    = null;
let availableStations = [];
let loaderStationId   = PCB_LOADER_SLAVE_ID;
let pnpStations       = [];
let pendingTotalPcbs  = 10;
let detectedPort      = null;

let clientCount = 0;

let id4Alive = false;
let id5Alive = false;

let currentPage = null;   // last PAGE written to stations

let monitorTimer = null;

// ── set to true between 'productionComplete' and 'acknowledge-complete' ──────
// While true the cyclic monitor will not touch the stations or change state.
let awaitingProductionAck = false;

let systemStatus  = 'idle';
let statusMessage = 'Starting up…';
let initLogBuffer = [];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function broadcast(event, data) { io.emit(event, data); }

function buildSystemState() {
  return {
    systemStatus,
    statusMessage,
    serialPort:    detectedPort ?? '—',
    loaderPresent: id5Alive,
    connected:     modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  };
}

function setStatus(status, message) {
  systemStatus  = status;
  statusMessage = message;
  broadcast('systemState', buildSystemState());
  console.log(`[Status] ${status}: ${message}`);
}

function log(message, pct = null) {
  const payload = { message };
  if (pct !== null) payload.pct = pct;
  initLogBuffer.push(payload);
  if (initLogBuffer.length > 200) initLogBuffer.shift();
  broadcast('initProgress', payload);
  console.log(`[Init] ${message}`);
}

// ─── PING HELPERS ─────────────────────────────────────────────────────────────

async function pingStation(slaveId, timeoutMs = 400) {
  if (!modbusHandler || !modbusHandler.connected) return false;
  for (let i = 0; i < PING_RETRIES; i++) {
    try {
      const orig = modbusHandler.timeoutMs;
      if (timeoutMs !== orig) {
        modbusHandler.timeoutMs = timeoutMs;
        modbusHandler.client.setTimeout(timeoutMs);
      }
      const ok = await modbusHandler.pingStation(slaveId);
      if (timeoutMs !== orig) {
        modbusHandler.timeoutMs = orig;
        modbusHandler.client.setTimeout(orig);
      }
      if (ok) return true;
    } catch { /* ignore */ }
    if (i < PING_RETRIES - 1) await sleep(PING_RETRY_DELAY_MS);
  }
  return false;
}

// ─── PAGE WRITE HELPERS ───────────────────────────────────────────────────────

/**
 * Write PAGE=pageId to an explicit list of stations.
 * This is the authoritative function — callers decide exactly which
 * stations to write to, preventing stale-list bugs.
 *
 * @param {number}   pageId       PageID constant
 * @param {number[]} stationList  Explicit list of slave IDs to write to
 */
async function setPageOnStations(pageId, stationList) {
  if (!modbusHandler || !modbusHandler.connected) return;
  if (!stationList || stationList.length === 0) return;

  console.log(`[Page] Writing PAGE=${pageId} to stations [${stationList}]`);
  for (const sid of stationList) {
    try {
      const ok = await modbusHandler.setActivePage(sid, pageId);
      console.log(`[Page]   Station ${sid} → ${ok ? 'OK' : 'FAILED'}`);
    } catch (err) {
      console.warn(`[Page]   Station ${sid} error: ${err.message}`);
    }
  }
  currentPage = pageId;
}

/**
 * Convenience wrapper — writes PAGE to whatever is currently in
 * availableStations (or falls back to id5Alive / pnpStations).
 * Used by soft-reset and other non-monitor code paths.
 */
async function setPageOnAllStations(pageId) {
  const stations = availableStations.length > 0
    ? availableStations
    : [
        ...(id5Alive               ? [PCB_LOADER_SLAVE_ID] : []),
        ...(pnpStations.length > 0 ? pnpStations           : []),
      ];
  await setPageOnStations(pageId, stations);
}

// ─── STATION-MANAGER EMIT ─────────────────────────────────────────────────────

function managerEmit(event) {
  io.emit(event.type, event);

  switch (event.type) {

    case 'buttonPressed':
      setTimeout(async () => {
        try {
          setStatus('production', 'Starting production…');
          await setPageOnAllStations(PageID.PICK_AND_PLACE_ANIMATION);
          await stationManager.startProduction(pendingTotalPcbs);
        } catch (err) {
          console.error('[Server] Failed to start production:', err.message);
          setStatus('error', `Production start failed: ${err.message}`);
        }
      }, 1000);
      break;

    case 'productionStarted':
      setStatus('production', `Production running — ${event.totalPcbs} PCBs`);
      break;

    case 'productionComplete':
      // Set the ack-guard BEFORE the status update so the monitor sees it
      // immediately on the next tick.
      awaitingProductionAck = true;
      console.log('[Server] productionComplete — awaitingProductionAck=true');
      setStatus('ready', 'Production complete — awaiting operator confirmation');
      break;

    case 'productionStopped':
      setStatus('ready', 'Production stopped — returning to setup');
      break;

    case 'returnedToSetup':
      currentPage = PageID.PLACEMENT_PARAMETERS_SETUP;
      setStatus('ready', 'Setup mode — ready for next batch');
      broadcast('connectionState', {
        connected: true, availableStations, loaderStationId, pnpStations,
      });
      break;

    case 'setupComplete':
      broadcast('setupComplete', {});
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  START PHASE
// ═══════════════════════════════════════════════════════════════════════════════

async function getCandidatePorts() {
  let all = [];
  try { all = await SerialPort.list(); } catch { return []; }

  return all
    .filter(p => {
      const pt = p.path;
      if (process.platform === 'win32') return true;
      return /\/dev\/tty(USB|ACM|AMA)\d+/.test(pt) || /\/dev\/ttyS[0-3]$/.test(pt);
    })
    .sort((a, b) => {
      const rank = pt =>
        pt.includes('ttyUSB') ? 0 :
        pt.includes('ttyACM') ? 1 :
        pt.includes('ttyAMA') ? 2 : 3;
      return rank(a.path) - rank(b.path);
    });
}

function silentClose(client) {
  if (!client) return;
  try { client.removeAllListeners(); }                                    catch { /* ignore */ }
  try { if (client._port) client._port.removeAllListeners(); }           catch { /* ignore */ }
  try { if (client.isOpen) client.close(() => {}); }                     catch { /* ignore */ }
}

async function probePort(portPath) {
  console.log(`[Probe] Testing ${portPath}…`);
  const client = new ModbusRTU();
  client.on('error', () => {});

  try {
    await client.connectRTUBuffered(portPath, {
      baudRate: MODBUS_BAUDRATE,
      parity:   PARITY_MAP[MODBUS_PARITY] ?? 'none',
      stopBits: MODBUS_STOP_BITS,
      dataBits: MODBUS_DATA_BITS,
    });
    try { if (client._port) client._port.on('error', () => {}); } catch { /* ignore */ }

    client.setTimeout(PROBE_TIMEOUT_MS);
    await sleep(150);
    client.setID(ID4_SLAVE_ID);

    let ok = false;
    try {
      const r = await client.readDiscreteInputs(DiscreteInputAddresses.IS_UI_LOADED, 1);
      ok = r !== null && r.data !== undefined;
    } catch { ok = false; }

    console.log(`[Probe] ${portPath}: ${ok ? '✓ ID4 responded' : 'no response'}`);
    return ok;
  } catch (err) {
    console.log(`[Probe] ${portPath}: open failed — ${err.message}`);
    return false;
  } finally {
    await sleep(50);
    silentClose(client);
    await sleep(250);
  }
}

async function autoDetectPort() {
  const candidates = await getCandidatePorts();
  if (candidates.length === 0) { console.log('[Probe] No candidate ports.'); return null; }
  console.log(`[Probe] Scanning: ${candidates.map(p => p.path).join(', ')}`);
  for (const c of candidates) {
    if (await probePort(c.path)) { console.log(`[Probe] ✓ Bus on ${c.path}`); return c.path; }
  }
  return null;
}

async function openPort(portPath) {
  detectedPort = portPath;

  if (modbusHandler) {
    try { modbusHandler.disconnect(); } catch { /* ignore */ }
    modbusHandler = null;
  }

  modbusHandler = new ModbusHandler(portPath, { timeoutMs: 100, retries: 2, retryDelayMs: 100 });
  const ok = await modbusHandler.connect();
  if (!ok) {
    console.error(`[Server] Failed to open ${portPath}`);
    modbusHandler = null;
    detectedPort  = null;
    return false;
  }
  console.log(`[Server] Port ${portPath} open`);
  return true;
}

async function runStartPhase() {
  phase = Phase.START;
  setStatus('connecting', 'Scanning serial ports for Modbus bus…');

  // 1. Find COM port
  let portPath = null;
  while (!portPath) {
    portPath = await autoDetectPort();
    if (!portPath) {
      setStatus('error', `No Modbus bus found — retrying in ${PORT_RESCAN_DELAY_MS / 1000} s…`);
      await sleep(PORT_RESCAN_DELAY_MS);
    }
  }

  // 2. Open port
  if (!(await openPort(portPath))) {
    setStatus('error', `Could not open ${portPath} — retrying…`);
    await sleep(PORT_RESCAN_DELAY_MS);
    return runStartPhase();
  }

  id4Alive = true;
  setStatus('idle', `Port ${portPath} open — waiting for PCB Loader (ID5)…`);

  // 3. Wait for ID5 + client
  await waitForId5AndClient();

  // 4. Initialize
  const ok = await runInitSequence();
  if (!ok) { await sleep(PORT_RESCAN_DELAY_MS); return runStartPhase(); }

  // 5. Enter working phase
  enterWorkingPhase();
}

async function waitForId5AndClient() {
  console.log('[Start] Waiting for ID5 + web client…');
  while (true) {
    id5Alive = await pingStation(PCB_LOADER_SLAVE_ID, PROBE_TIMEOUT_MS);

    if (id5Alive && clientCount > 0) {
      console.log('[Start] ID5 present and client connected — proceeding to init');
      broadcast('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });
      return;
    }

    if (id5Alive) {
      setStatus('idle', 'PCB Loader present — waiting for web client…');
      broadcast('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });
    } else {
      setStatus('idle', `Port ${detectedPort} open — waiting for PCB Loader (ID5)…`);
      id5Alive = false;
    }

    await sleep(MONITOR_INTERVAL_MS);

    id4Alive = await pingStation(ID4_SLAVE_ID, PROBE_TIMEOUT_MS);
    if (!id4Alive) {
      console.log('[Start] ID4 went offline during wait — restarting start phase');
      setStatus('error', 'Bus lost during startup — rescanning…');
      if (modbusHandler) {
        try { modbusHandler.disconnect(); } catch { /* ignore */ }
        modbusHandler = null;
      }
      detectedPort = null;
      await sleep(PORT_RESCAN_DELAY_MS);
      return runStartPhase();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INITIALIZATION SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════════

async function runInitSequence() {
  initLogBuffer = [];
  setStatus('initializing', 'PCB Loader detected — initializing system…');

  try {
    // Step 1 — Confirm ID5
    log(`Detecting PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})…`, 5);
    let loaderFound = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      loaderFound = await pingStation(PCB_LOADER_SLAVE_ID);
      if (loaderFound) break;
      log(`  PCB Loader not responding, retry ${attempt + 1}/5…`);
      await sleep(500);
    }
    if (!loaderFound) throw new Error('PCB Loader (ID5) did not respond after 5 attempts');
    log(`✓ PCB Loader confirmed (ID ${PCB_LOADER_SLAVE_ID})`, 10);

    // Step 2 — Detect P&P stations
    log('Detecting Pick and Place stations…', 20);
    const foundPnp = [];
    for (const sid of SLAVE_IDS) {
      const found = await modbusHandler.pingStation(sid);
      log(found ? `  ✓ P&P Station ${sid} detected` : `  – P&P Station ${sid} not found`);
      if (found) foundPnp.push(sid);
      await sleep(100);
    }
    if (foundPnp.length === 0) throw new Error('No Pick and Place stations detected');
    log(`✓ ${foundPnp.length} P&P station(s) found: [${foundPnp}]`, 35);

    const allStations = [PCB_LOADER_SLAVE_ID, ...foundPnp];

    // Step 3 — Verify IDs, set PAGE=1, write defaults
    log('\nVerifying IDs, setting setup page and default components…', 40);
    for (let i = 0; i < allStations.length; i++) {
      const sid  = allStations[i];
      const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${sid}`;

      const stId = await modbusHandler.getStationId(sid);
      if (stId === null) throw new Error(`${name}: could not read station ID`);
      if (stId !== sid)  throw new Error(`${name} ID mismatch: expected ${sid}, got ${stId}`);

      const pageOk = await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
      if (!pageOk) throw new Error(`Failed to set setup page for ${name}`);

      const cntOk = await modbusHandler.setTotalPositions(
        sid,
        DefaultComponentCounts.transistors,
        DefaultComponentCounts.diodes,
        DefaultComponentCounts.ics,
        DefaultComponentCounts.capacitors
      );
      if (!cntOk) throw new Error(`Failed to write defaults to ${name}`);

      log(
        `  ✓ ${name}: ID OK, PAGE=1 set, defaults written ` +
        `(T:${DefaultComponentCounts.transistors} D:${DefaultComponentCounts.diodes} ` +
        `IC:${DefaultComponentCounts.ics} C:${DefaultComponentCounts.capacitors})`
      );
      broadcast('initProgress', { pct: 40 + Math.round(((i + 1) / allStations.length) * 58) });
    }

    currentPage           = PageID.PLACEMENT_PARAMETERS_SETUP;
    availableStations     = allStations;
    loaderStationId       = PCB_LOADER_SLAVE_ID;
    pnpStations           = foundPnp;
    id4Alive              = true;
    id5Alive              = true;
    awaitingProductionAck = false;   // fresh init clears any stale ack flag

    if (stationManager) { stationManager._stopPolling(); stationManager = null; }
    stationManager = new StationManager(modbusHandler, loaderStationId, pnpStations, managerEmit);

    log('', 100);
    log('✓ ALL STATIONS INITIALIZED SUCCESSFULLY');
    log(`  PCB Loader  : Slave ID ${PCB_LOADER_SLAVE_ID}`);
    log(`  Pick & Place: Slave IDs [${foundPnp}]`);

    setStatus('ready', `System ready — ${foundPnp.length} P&P station(s) online`);
    broadcast('connectionState', {
      connected: true, availableStations, loaderStationId, pnpStations,
    });
    return true;

  } catch (err) {
    console.error('[Init] Failed:', err.message);
    log(`✗ INITIALIZATION FAILED: ${err.message}`);
    setStatus('error', `Initialization failed: ${err.message}`);
    availableStations = [];
    pnpStations       = [];
    stationManager    = null;
    currentPage       = null;
    broadcast('connectionState', {
      connected: false, availableStations: [], loaderStationId, pnpStations: [],
    });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WORKING PHASE
// ═══════════════════════════════════════════════════════════════════════════════

function enterWorkingPhase() {
  phase     = Phase.WORKING;
  workState = WorkState.NORMAL;
  console.log('[Working] Entered working phase — starting cyclic monitor');
  scheduleMonitor();
}

function scheduleMonitor() {
  stopMonitor();
  monitorTimer = setTimeout(monitorTick, MONITOR_INTERVAL_MS);
}

function stopMonitor() {
  if (monitorTimer) { clearTimeout(monitorTimer); monitorTimer = null; }
}

async function monitorTick() {
  if (phase !== Phase.WORKING) return;
  try { await _doMonitorTick(); } catch (err) { console.error('[Monitor] Error:', err.message); }
  if (phase === Phase.WORKING) scheduleMonitor();
}

async function _doMonitorTick() {

  // ── GUARD: operator has not yet confirmed production-complete dialog ───────
  // Do nothing at all — stations stay in their current state, manager stays
  // alive, no PAGE writes happen until acknowledge-complete is called.
  if (awaitingProductionAck) {
    console.log('[Monitor] Waiting for operator production-complete acknowledgement — skipping tick');
    return;
  }

  // ── 1. No web clients ─────────────────────────────────────────────────────
  if (clientCount === 0) {
    if (workState !== WorkState.NO_CLIENT) {
      console.log('[Monitor] clients=0 → PAGE=0, entering NO_CLIENT state');
      workState = WorkState.NO_CLIENT;

      if (stationManager) { stationManager._stopPolling(); stationManager = null; }

      // Capture the full station list BEFORE clearing global arrays.
      // This ensures we write PAGE=0 to exactly the stations that were
      // active — no more, no less.
      const stationsToReset = [...availableStations];
      availableStations = [];
      pnpStations       = [];

      // Write PAGE=0 only to the stations we just captured.
      await setPageOnStations(PageID.STARTUP, stationsToReset);

      setStatus('idle', 'Web client disconnected — waiting for initialization…');
      broadcast('connectionState', {
        connected: false, availableStations: [], loaderStationId, pnpStations: [],
      });
    }
    return;
  }

  // ── 2. Clients present — check bus ───────────────────────────────────────
  // Always ping ID4 first; only ping ID5 if ID4 is alive.
  id4Alive = await pingStation(ID4_SLAVE_ID, PROBE_TIMEOUT_MS);
  id5Alive = id4Alive ? await pingStation(PCB_LOADER_SLAVE_ID, PROBE_TIMEOUT_MS) : false;

  // ── DEBUG: log current ping targets in wait states ────────────────────────
  if (workState === WorkState.WAIT_ID5) {
    console.log(
      `[Monitor] WAIT_ID5 state — ` +
      `ID4(${ID4_SLAVE_ID})=${id4Alive}, ID5(${PCB_LOADER_SLAVE_ID})=${id5Alive} ` +
      `— slave list: [${availableStations}]`
    );
  } else if (workState === WorkState.WAIT_ID4) {
    console.log(
      `[Monitor] WAIT_ID4 state — ` +
      `ID4(${ID4_SLAVE_ID})=${id4Alive} ` +
      `— slave list: [${availableStations}]`
    );
  }

  // ── 2a. Both alive ────────────────────────────────────────────────────────
  if (id4Alive && id5Alive) {
    if (workState !== WorkState.NORMAL) {
      console.log('[Monitor] ID4+ID5 back, clients>0 → re-initializing (PAGE=1)');
      workState = WorkState.NORMAL;
      const ok = await runInitSequence();
      if (!ok) workState = WorkState.WAIT_ID5;
    }
    // If workState is already NORMAL the station manager handles everything.
    return;
  }

  // ── 2b. ID4 alive, ID5 gone ───────────────────────────────────────────────
  if (id4Alive && !id5Alive) {
    if (workState !== WorkState.WAIT_ID5) {
      console.log('[Monitor] ID5 gone (ID4 OK) → entering WAIT_ID5');

      // ── Step 1: stop station manager immediately ──────────────────────────
      // Must happen before ANY list mutation so the manager cannot race and
      // trigger a Modbus write to a station we are about to remove.
      if (stationManager) { stationManager._stopPolling(); stationManager = null; }

      // ── Step 2: capture full list, THEN prune ────────────────────────────
      // We write PAGE=0 to every station that was previously active (one-shot
      // so their displays show the "waiting" screen), then we prune the list
      // down to [ID4_SLAVE_ID] only.  From this point on, the cyclic monitor
      // will contact ONLY ID4 and ID5 — never ID1/2/3.
      const stationsToReset = [...availableStations];

      availableStations = [ID4_SLAVE_ID];   // ← KEY FIX: prune, don't clear
      pnpStations       = [];

      console.log(
        `[Monitor] Slave list pruned: [${stationsToReset}] → [${availableStations}] ` +
        `(ID4 only — ID1/2/3 will NOT be contacted until full re-init)`
      );

      // Write PAGE=0 to all previously-active stations (one-time flush).
      await setPageOnStations(PageID.STARTUP, stationsToReset);

      workState = WorkState.WAIT_ID5;

      setStatus('idle', 'PCB Loader (ID5) disconnected — waiting for reconnection…');
      broadcast('loaderRemoved', { slaveId: PCB_LOADER_SLAVE_ID });
      broadcast('connectionState', {
        connected: false, availableStations: [], loaderStationId, pnpStations: [],
      });
    }
    // While in WAIT_ID5 we only ping ID4 and ID5 (done at the top of this
    // function).  No Modbus writes to ID1/2/3 happen anywhere below this line.
    return;
  }

  // ── 2c. ID4 gone ─────────────────────────────────────────────────────────
  // Handles both: previously NORMAL (all stations) and previously WAIT_ID5
  // (list was already pruned to [ID4]).
  if (!id4Alive) {
    if (workState !== WorkState.WAIT_ID4) {
      console.log('[Monitor] ID4 gone → entering WAIT_ID4');

      // ── Step 1: stop station manager ─────────────────────────────────────
      if (stationManager) { stationManager._stopPolling(); stationManager = null; }

      // ── Step 2: capture current list (may already be [ID4] or []) ────────
      const stationsToReset = [...availableStations];

      availableStations = [];   // nothing left to talk to
      pnpStations       = [];
      id5Alive          = false;

      console.log(
        `[Monitor] Slave list cleared: [${stationsToReset}] → [] ` +
        `(only pinging ID4 until bus recovers)`
      );

      // Attempt PAGE=0 on whatever was in the list.
      // This may fail/timeout if the bus is truly dead — that is expected.
      if (stationsToReset.length > 0) {
        await setPageOnStations(PageID.STARTUP, stationsToReset);
      }

      workState = WorkState.WAIT_ID4;

      setStatus('error', 'Bus offline (ID4 not responding) — waiting for bus recovery…');
      broadcast('connectionState', {
        connected: false, availableStations: [], loaderStationId, pnpStations: [],
      });
    }
    // While in WAIT_ID4 we only ping ID4 (done at the top of this function).
    return;
  }
}

// ─── CLIENT RECONNECT DURING WORKING PHASE ───────────────────────────────────

async function onClientReconnectedInWorkingPhase() {
  if (phase !== Phase.WORKING)           return;
  if (workState !== WorkState.NO_CLIENT) return;

  // Do not interfere while waiting for the operator to confirm production end.
  if (awaitingProductionAck) {
    console.log('[Working] Client reconnected during production-ack wait — no action needed');
    return;
  }

  console.log('[Working] Client reconnected in NO_CLIENT state — checking bus…');

  id4Alive = await pingStation(ID4_SLAVE_ID, PROBE_TIMEOUT_MS);
  id5Alive = id4Alive ? await pingStation(PCB_LOADER_SLAVE_ID, PROBE_TIMEOUT_MS) : false;

  if (id4Alive && id5Alive) {
    // Both alive — full re-init, which will detect all active P&P stations.
    console.log('[Working] ID4+ID5 alive → re-initializing (PAGE=1)');
    workState = WorkState.NORMAL;
    const ok = await runInitSequence();
    if (!ok) workState = WorkState.WAIT_ID5;

  } else if (id4Alive && !id5Alive) {
    // ID4 alive, ID5 absent — prune list to ID4 only (same logic as monitor).
    console.log('[Working] ID4 alive, ID5 absent → WAIT_ID5, pruning slave list to [ID4]');

    const stationsToReset = [...availableStations];
    availableStations = [ID4_SLAVE_ID];
    pnpStations       = [];

    console.log(
      `[Working] Slave list pruned: [${stationsToReset}] → [${availableStations}]`
    );

    if (stationsToReset.length > 0) {
      await setPageOnStations(PageID.STARTUP, stationsToReset);
    }

    workState = WorkState.WAIT_ID5;
    setStatus('idle', 'PCB Loader (ID5) not found — waiting for reconnection…');
    broadcast('loaderRemoved', { slaveId: PCB_LOADER_SLAVE_ID });
    broadcast('connectionState', {
      connected: false, availableStations: [], loaderStationId, pnpStations: [],
    });

  } else {
    // ID4 absent — clear everything.
    console.log('[Working] ID4 absent → WAIT_ID4, clearing slave list');

    const stationsToReset = [...availableStations];
    availableStations = [];
    pnpStations       = [];

    console.log(
      `[Working] Slave list cleared: [${stationsToReset}] → []`
    );

    if (stationsToReset.length > 0) {
      await setPageOnStations(PageID.STARTUP, stationsToReset);
    }

    workState = WorkState.WAIT_ID4;
    setStatus('error', 'Bus offline — waiting for bus recovery…');
    broadcast('connectionState', {
      connected: false, availableStations: [], loaderStationId, pnpStations: [],
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  clientCount++;
  console.log(`[Socket] Active clients: ${clientCount}`);

  socket.emit('systemState', buildSystemState());
  socket.emit('connectionState', {
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  });
  initLogBuffer.forEach(e => socket.emit('initProgress', e));
  if (stationManager) socket.emit('snapshot', stationManager.getSnapshot());

  if (clientCount === 1 && phase === Phase.WORKING) {
    setImmediate(async () => { await onClientReconnectedInWorkingPhase(); });
  }

  socket.on('disconnect', () => {
    clientCount = Math.max(0, clientCount - 1);
    console.log(`[Socket] Client disconnected: ${socket.id} — Active: ${clientCount}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/system/status', (_req, res) => res.json(buildSystemState()));


app.get('/api/setup/components', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const result = {};
    for (const sid of pnpStations) {
      const c = await modbusHandler.getComponentsToPlace(sid);
      result[sid] = c
        ? { transistors: c[0], diodes: c[1], ics: c[2], capacitors: c[3] }
        : { transistors: 0, diodes: 0, ics: 0, capacitors: 0 };
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/setup/total-positions', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { slaveId, transistors, diodes, ics, capacitors } = req.body;
  try {
    const ok = await modbusHandler.setTotalPositions(slaveId, transistors, diodes, ics, capacitors);
    res.json({ success: ok });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/setup/start-button', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { active } = req.body;
  try {
    const ok = await modbusHandler.setStartButtonActive(loaderStationId, active);
    if (stationManager) {
      if (active) await stationManager.onSetupComplete();
      else stationManager.onSetupIncomplete();
    }
    res.json({ success: ok });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operation/stop', async (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  try { await stationManager.stopProduction(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/operation/set-total', (req, res) => {
  const { totalPcbs } = req.body;
  if (totalPcbs && Number(totalPcbs) > 0) pendingTotalPcbs = Number(totalPcbs);
  res.json({ success: true, totalPcbs: pendingTotalPcbs });
});

app.get('/api/operation/snapshot', (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  res.json(stationManager.getSnapshot());
});

// ─── ACKNOWLEDGE PRODUCTION COMPLETE ─────────────────────────────────────────
//
// Called by the GUI after the operator clicks OK on the production-complete
// dialog. This is the ONLY place that clears awaitingProductionAck.

app.post('/api/operation/acknowledge-complete', async (_req, res) => {
  console.log('[Server] acknowledge-complete received');

  if (!stationManager) {
    console.warn('[Server] acknowledge-complete: no station manager — clearing ack flag');
    awaitingProductionAck = false;
    return res.status(400).json({ error: 'No station manager active' });
  }

  try {
    await stationManager._returnToSetup();
    // _returnToSetup emits 'returnedToSetup' which sets currentPage=1 via managerEmit
    awaitingProductionAck = false;
    console.log('[Server] acknowledge-complete: done — awaitingProductionAck=false');
    res.json({ success: true });
  } catch (err) {
    console.error('[Server] _returnToSetup error:', err.message);
    awaitingProductionAck = false;   // clear even on error so we don't get stuck
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/configuration', async (_req, res) => {
  if (!modbusHandler || pnpStations.length === 0)
    return res.status(400).json({ error: 'No P&P stations connected' });
  const sid = pnpStations[0];
  try {
    const timing = await modbusHandler.readHoldingRegisters(
      sid, HoldingRegisterAddresses.TRANSISTOR_PLACEMENT_DURATION_MS, 5
    );
    const led = await modbusHandler.readHoldingRegisters(
      sid, HoldingRegisterAddresses.BRIGHTNESS_RED_LED, 6
    );
    const rfid = await modbusHandler.readHoldingRegisters(
      sid, HoldingRegisterAddresses.RFID_BOX_UID_START, 12
    );
    const vol = await modbusHandler.readHoldingRegisters(
      sid, HoldingRegisterAddresses.SPEAKER_VOLUME, 1
    );
    res.json({
      timing: timing
        ? { transistor: timing[0], diode: timing[1], ic: timing[2],
            capacitor: timing[3], transport: timing[4] }
        : null,
      led: led
        ? { red: led[0], yellow: led[1], green: led[2], rgb: led[3],
            thresholdYellow: led[4], thresholdRed: led[5] }
        : null,
      rfid: rfid
        ? Array.from({ length: 4 }, (_, i) => ({
            uidHigh: rfid[i * 2],
            uidLow:  rfid[i * 2 + 1],
            count:   rfid[8 + i],
          }))
        : null,
      volume: vol ? vol[0] : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/configuration', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { timing, led, rfid, volume } = req.body;
  try {
    for (const sid of availableStations) {
      if (timing) await modbusHandler.setTimingConfig(
        sid, timing.transistor, timing.diode, timing.ic, timing.capacitor, timing.transport
      );
      if (led) await modbusHandler.setLedConfig(
        sid, led.red, led.yellow, led.green, led.rgb, led.thresholdYellow, led.thresholdRed
      );
      if (rfid) {
        const vals = [];
        rfid.forEach(b => vals.push(b.uidHigh, b.uidLow));
        rfid.forEach(b => vals.push(b.count));
        await modbusHandler.writeHoldingRegisters(
          sid, HoldingRegisterAddresses.RFID_BOX_UID_START, vals
        );
      }
      if (volume != null) await modbusHandler.setSpeakerVolume(sid, volume);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/configuration/soft-reset', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    for (const sid of availableStations)
      if (!(await modbusHandler.softReset(sid)))
        throw new Error(`Reset failed on ${sid}`);

    await sleep(2000);

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      let all = true;
      for (const sid of availableStations)
        if (!(await modbusHandler.checkSoftResetComplete(sid))) { all = false; break; }
      if (all) break;
      await sleep(200);
    }

    for (const sid of availableStations)
      await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
    currentPage = PageID.PLACEMENT_PARAMETERS_SETUP;

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/monitoring', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const result = {};
    for (const sid of [loaderStationId, ...pnpStations]) {
      result[sid] = {
        statusData:   await modbusHandler.getAllStatus(sid),
        inputCoils:   await modbusHandler.readCoils(
          sid, CoilAddresses.INPUT_TRANSISTOR_1_IS_POPULATED, 14
        ),
        outputInputs: await modbusHandler.readDiscreteInputs(
          sid, DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED, 14
        ),
      };
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, async () => {
  console.log(`[Server] SMT Pick & Place Controller → http://localhost:${PORT}`);
  await runStartPhase();
});