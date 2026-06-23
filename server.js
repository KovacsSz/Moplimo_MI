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
 *  clients  ID5  ID4  │ action
 *  ───────────────────┼──────────────────────────────────────────────────────
 *    0       *    *   │ set PAGE=0 on all stations → wait for client
 *    >0      Y    Y   │ normal operation (PAGE already 1 or 2)
 *    >0      N    Y   │ set PAGE=0 → watch ID5 cyclically; when ID5 returns
 *                     │   and clients>0 → set PAGE=1, resume normal operation
 *    >0      N    N   │ set PAGE=0 → watch ID4 cyclically; when ID4 returns
 *                     │   watch ID5; when both alive and clients>0 → set PAGE=1
 *
 *  Re-entry to normal operation always:
 *    ID4 alive AND ID5 alive AND clients > 0  →  set PAGE=1 → resume
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

const ID4_SLAVE_ID             = 4;           // used for bus detection
const PORT_RESCAN_DELAY_MS     = 500;        // retry when no COM port found
const PROBE_TIMEOUT_MS         = 200;         // per-port probe timeout
const MONITOR_INTERVAL_MS      = 500;        // working-phase cyclic check
const PING_RETRIES             = 2;           // retries per ping
const PING_RETRY_DELAY_MS      = 100;

const PARITY_MAP = { N: 'none', E: 'even', O: 'odd' };

// ─── PHASE ENUM ───────────────────────────────────────────────────────────────

const Phase = Object.freeze({
  START:   'start',    // finding COM port, waiting for ID4/ID5/client
  WORKING: 'working',  // system initialized, stations on page 1 or 2
});

// ─── WORKING-PHASE SUB-STATE ENUM ────────────────────────────────────────────

const WorkState = Object.freeze({
  NORMAL:       'normal',       // ID4+ID5+clients OK, PAGE ≥ 1
  NO_CLIENT:    'no_client',    // clients=0, PAGE=0, waiting for client
  WAIT_ID5:     'wait_id5',     // ID4 OK, ID5 gone, PAGE=0
  WAIT_ID4:     'wait_id4',     // ID4+ID5 gone, PAGE=0, only ping ID4
});

// ─── STATE ────────────────────────────────────────────────────────────────────

let phase       = Phase.START;
let workState   = WorkState.NORMAL;

let modbusHandler     = null;   // kept open for the whole session
let stationManager    = null;
let availableStations = [];
let loaderStationId   = PCB_LOADER_SLAVE_ID;
let pnpStations       = [];
let pendingTotalPcbs  = 10;
let detectedPort      = null;

let clientCount = 0;            // active Socket.IO connections

let id4Alive    = false;
let id5Alive    = false;

let currentPage = null;         // last PAGE value written to stations (null=unknown)

let monitorTimer = null;        // working-phase cyclic timer

// Status for GUI
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
    serialPort:        detectedPort ?? '—',
    loaderPresent:     id5Alive,
    connected:         modbusHandler?.connected ?? false,
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

async function pingStation(slaveId, timeoutMs = 1000) {
  if (!modbusHandler || !modbusHandler.connected) return false;
  for (let i = 0; i < PING_RETRIES; i++) {
    try {
      // Temporarily adjust timeout if caller requests a shorter one
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

// ─── PAGE WRITE HELPER ────────────────────────────────────────────────────────

async function setPageOnAllStations(pageId) {
  if (!modbusHandler || !modbusHandler.connected) return;

  // Build the list: prefer availableStations; fall back to whatever we know
  const stations = availableStations.length > 0
    ? availableStations
    : [
        ...(id5Alive              ? [PCB_LOADER_SLAVE_ID] : []),
        ...(pnpStations.length > 0 ? pnpStations          : []),
      ];

  if (stations.length === 0) return;

  console.log(`[Page] Writing PAGE=${pageId} to stations [${stations}]`);
  for (const sid of stations) {
    try {
      const ok = await modbusHandler.setActivePage(sid, pageId);
      console.log(`[Page]   Station ${sid} → ${ok ? 'OK' : 'FAILED'}`);
    } catch (err) {
      console.warn(`[Page]   Station ${sid} error: ${err.message}`);
    }
  }
  currentPage = pageId;
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

// ─── COM-PORT DETECTION ───────────────────────────────────────────────────────

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
  try { client.removeAllListeners(); } catch { /* ignore */ }
  try { if (client._port) client._port.removeAllListeners(); } catch { /* ignore */ }
  try { if (client.isOpen) client.close(() => {}); } catch { /* ignore */ }
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
    if (await probePort(c.path)) {
      console.log(`[Probe] ✓ Bus on ${c.path}`);
      return c.path;
    }
  }
  return null;
}

// ─── OPEN PORT ────────────────────────────────────────────────────────────────

async function openPort(portPath) {
  detectedPort = portPath;

  if (modbusHandler) {
    try { modbusHandler.disconnect(); } catch { /* ignore */ }
    modbusHandler = null;
  }

  modbusHandler = new ModbusHandler(portPath, {
    timeoutMs: 1000, retries: 2, retryDelayMs: 200,
  });

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

// ─── START PHASE ENTRY POINT ──────────────────────────────────────────────────

async function runStartPhase() {
  phase = Phase.START;
  setStatus('connecting', 'Scanning serial ports for Modbus bus…');

  // 1. Find COM port (ID4 must respond)
  let portPath = null;
  while (!portPath) {
    portPath = await autoDetectPort();
    if (!portPath) {
      setStatus('error', `No Modbus bus found — retrying in ${PORT_RESCAN_DELAY_MS / 1000} s…`);
      await sleep(PORT_RESCAN_DELAY_MS);
    }
  }

  // 2. Open the port
  const opened = await openPort(portPath);
  if (!opened) {
    setStatus('error', `Could not open ${portPath} — retrying…`);
    await sleep(PORT_RESCAN_DELAY_MS);
    return runStartPhase();
  }

  id4Alive = true;   // we just confirmed ID4 during probe
  setStatus('idle', `Port ${portPath} open — waiting for PCB Loader (ID5)…`);

  // 3. Wait until ID5 present AND at least one web client connected
  await waitForId5AndClient();

  // 4. Run initialization
  const ok = await runInitSequence();
  if (!ok) {
    // Init failed — stay in start phase loop
    await sleep(PORT_RESCAN_DELAY_MS);
    return runStartPhase();
  }

  // 5. Enter working phase
  enterWorkingPhase();
}

// ─── WAIT FOR ID5 + CLIENT (start phase) ─────────────────────────────────────

async function waitForId5AndClient() {
  console.log('[Start] Waiting for ID5 + web client…');

  while (true) {
    id5Alive = await pingStation(PCB_LOADER_SLAVE_ID, PROBE_TIMEOUT_MS);

    if (id5Alive && clientCount > 0) {
      console.log('[Start] ID5 present and client connected — proceeding to init');
      broadcast('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });
      return;
    }

    if (id5Alive && clientCount === 0) {
      setStatus('idle', 'PCB Loader present — waiting for web client…');
      broadcast('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });
    } else {
      setStatus('idle', `Port ${detectedPort} open — waiting for PCB Loader (ID5)…`);
      id5Alive = false;
    }

    await sleep(MONITOR_INTERVAL_MS);

    // Re-check ID4 is still alive; if not, restart entirely
    id4Alive = await pingStation(ID4_SLAVE_ID, PROBE_TIMEOUT_MS);
    if (!id4Alive) {
      console.log('[Start] ID4 went offline during wait — restarting start phase');
      setStatus('error', 'Bus lost during startup — rescanning…');
      if (modbusHandler) { try { modbusHandler.disconnect(); } catch { /* ignore */ } modbusHandler = null; }
      detectedPort = null;
      await sleep(PORT_RESCAN_DELAY_MS);
      return runStartPhase();   // tail-recursive restart
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INITIALIZATION SEQUENCE  (shared by start phase and working-phase recovery)
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

    // Step 3 — Verify IDs, set PAGE=1, write default counts
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

    // Success
    currentPage       = PageID.PLACEMENT_PARAMETERS_SETUP;
    availableStations = allStations;
    loaderStationId   = PCB_LOADER_SLAVE_ID;
    pnpStations       = foundPnp;
    id4Alive          = true;
    id5Alive          = true;

    // (Re-)create station manager
    if (stationManager) { stationManager._stopPolling(); stationManager = null; }
    stationManager = new StationManager(modbusHandler, loaderStationId, pnpStations, managerEmit);

    log('', 100);
    log('✓ ALL STATIONS INITIALIZED SUCCESSFULLY');
    log(`  PCB Loader  : Slave ID ${PCB_LOADER_SLAVE_ID}`);
    log(`  Pick & Place: Slave IDs [${foundPnp}]`);

    setStatus('ready', `System ready — ${foundPnp.length} P&P station(s) online`);
    broadcast('connectionState', { connected: true, availableStations, loaderStationId, pnpStations });
    return true;

  } catch (err) {
    console.error('[Init] Failed:', err.message);
    log(`✗ INITIALIZATION FAILED: ${err.message}`);
    setStatus('error', `Initialization failed: ${err.message}`);
    availableStations = [];
    pnpStations       = [];
    stationManager    = null;
    currentPage       = null;
    broadcast('connectionState', { connected: false, availableStations: [], loaderStationId, pnpStations: [] });
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

// ─── CYCLIC MONITOR TICK ─────────────────────────────────────────────────────

async function monitorTick() {
  if (phase !== Phase.WORKING) return;

  try {
    await _doMonitorTick();
  } catch (err) {
    console.error('[Monitor] Unhandled error:', err.message);
  }

  if (phase === Phase.WORKING) scheduleMonitor();
}

async function _doMonitorTick() {

  // ── 1. No web clients ─────────────────────────────────────────────────────
  if (clientCount === 0) {
    if (workState !== WorkState.NO_CLIENT) {
      console.log('[Monitor] clients=0 → PAGE=0, entering NO_CLIENT state');
      workState = WorkState.NO_CLIENT;

      if (stationManager) { stationManager._stopPolling(); stationManager = null; }
      await setPageOnAllStations(PageID.STARTUP);
      availableStations = [];
      pnpStations       = [];

      setStatus('idle', 'Web client disconnected — waiting for initialization…');
      broadcast('connectionState', { connected: false, availableStations: [], loaderStationId, pnpStations: [] });
    }
    // Stay in NO_CLIENT — nothing else to do until a client connects
    return;
  }

  // ── 2. Clients present — check ID4 and ID5 ───────────────────────────────
  id4Alive = await pingStation(ID4_SLAVE_ID, PROBE_TIMEOUT_MS);
  id5Alive = id4Alive ? await pingStation(PCB_LOADER_SLAVE_ID, PROBE_TIMEOUT_MS) : false;

  // ── 2a. Both alive (and clients > 0) ─────────────────────────────────────
  if (id4Alive && id5Alive) {

    if (workState !== WorkState.NORMAL) {
      // Recovering from a degraded state
      console.log('[Monitor] ID4+ID5 back, clients>0 → re-initializing (PAGE=1)');
      workState = WorkState.NORMAL;

      const ok = await runInitSequence();
      if (!ok) {
        // Init failed — drop back to WAIT_ID5 so we retry next tick
        workState = WorkState.WAIT_ID5;
      }
    }
    // If already NORMAL: nothing to do, station manager handles production
    return;
  }

  // ── 2b. ID4 alive, ID5 gone ───────────────────────────────────────────────
  if (id4Alive && !id5Alive) {

    if (workState !== WorkState.WAIT_ID5) {
      console.log('[Monitor] ID5 gone (ID4 OK) → PAGE=0, entering WAIT_ID5');
      workState = WorkState.WAIT_ID5;

      if (stationManager) { stationManager._stopPolling(); stationManager = null; }
      await setPageOnAllStations(PageID.STARTUP);
      availableStations = [];
      pnpStations       = [];

      setStatus('idle', 'PCB Loader (ID5) disconnected — waiting for reconnection…');
      broadcast('loaderRemoved', { slaveId: PCB_LOADER_SLAVE_ID });
      broadcast('connectionState', { connected: false, availableStations: [], loaderStationId, pnpStations: [] });
    }
    // Stay in WAIT_ID5 — next tick will re-check both IDs
    return;
  }

  // ── 2c. ID4 gone (implies ID5 also gone) ─────────────────────────────────
  if (!id4Alive) {

    if (workState !== WorkState.WAIT_ID4) {
      console.log('[Monitor] ID4 gone → PAGE=0, entering WAIT_ID4');
      workState = WorkState.WAIT_ID4;

      if (stationManager) { stationManager._stopPolling(); stationManager = null; }
      await setPageOnAllStations(PageID.STARTUP);
      availableStations = [];
      pnpStations       = [];
      id5Alive          = false;

      setStatus('error', 'Bus offline (ID4 not responding) — waiting for bus recovery…');
      broadcast('connectionState', { connected: false, availableStations: [], loaderStationId, pnpStations: [] });
    }
    // Stay in WAIT_ID4 — only check ID4 next tick (ID5 check done at top of 2.)
    return;
  }
}

// ─── CLIENT RECONNECT DURING WORKING PHASE ───────────────────────────────────
//
// When a client connects and we are in NO_CLIENT state, check ID4+ID5 and
// re-initialize if both are alive. Called from Socket.IO connection handler.

async function onClientReconnectedInWorkingPhase() {
  if (phase !== Phase.WORKING) return;
  if (workState !== WorkState.NO_CLIENT) return;

  console.log('[Working] Client reconnected in NO_CLIENT state — checking bus…');

  id4Alive = await pingStation(ID4_SLAVE_ID, PROBE_TIMEOUT_MS);
  id5Alive = id4Alive ? await pingStation(PCB_LOADER_SLAVE_ID, PROBE_TIMEOUT_MS) : false;

  if (id4Alive && id5Alive) {
    console.log('[Working] ID4+ID5 alive → re-initializing (PAGE=1)');
    workState = WorkState.NORMAL;   // set before init so monitor doesn't interfere
    const ok = await runInitSequence();
    if (!ok) workState = WorkState.WAIT_ID5;
  } else if (id4Alive && !id5Alive) {
    console.log('[Working] ID4 alive, ID5 absent → WAIT_ID5');
    workState = WorkState.WAIT_ID5;
    setStatus('idle', 'PCB Loader (ID5) not found — waiting for reconnection…');
    broadcast('loaderRemoved', { slaveId: PCB_LOADER_SLAVE_ID });
  } else {
    console.log('[Working] ID4 absent → WAIT_ID4');
    workState = WorkState.WAIT_ID4;
    setStatus('error', 'Bus offline — waiting for bus recovery…');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  clientCount++;
  console.log(`[Socket] Active clients: ${clientCount}`);

  // Send current state
  socket.emit('systemState', buildSystemState());
  socket.emit('connectionState', {
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  });
  initLogBuffer.forEach(e => socket.emit('initProgress', e));
  if (stationManager) socket.emit('snapshot', stationManager.getSnapshot());

  // ── Reconnect logic ───────────────────────────────────────────────────────
  if (clientCount === 1) {
    if (phase === Phase.WORKING) {
      // Working phase: handle NO_CLIENT → recovery
      setImmediate(async () => {
        await onClientReconnectedInWorkingPhase();
      });
    }
    // Start phase: waitForId5AndClient() polls clientCount directly — nothing extra needed
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    clientCount = Math.max(0, clientCount - 1);
    console.log(`[Socket] Client disconnected: ${socket.id} — Active: ${clientCount}`);
    // Working phase monitor will detect clientCount===0 on next tick automatically
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

app.post('/api/operation/acknowledge-complete', async (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'No station manager active' });
  try {
    await stationManager._returnToSetup();
    currentPage = PageID.PLACEMENT_PARAMETERS_SETUP;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/configuration', async (_req, res) => {
  if (!modbusHandler || pnpStations.length === 0)
    return res.status(400).json({ error: 'No P&P stations connected' });
  const sid = pnpStations[0];
  try {
    const timing = await modbusHandler.readHoldingRegisters(sid, HoldingRegisterAddresses.TRANSISTOR_PLACEMENT_DURATION_MS, 5);
    const led    = await modbusHandler.readHoldingRegisters(sid, HoldingRegisterAddresses.BRIGHTNESS_RED_LED, 6);
    const rfid   = await modbusHandler.readHoldingRegisters(sid, HoldingRegisterAddresses.RFID_BOX_UID_START, 12);
    const vol    = await modbusHandler.readHoldingRegisters(sid, HoldingRegisterAddresses.SPEAKER_VOLUME, 1);
    res.json({
      timing: timing ? { transistor: timing[0], diode: timing[1], ic: timing[2], capacitor: timing[3], transport: timing[4] } : null,
      led:    led    ? { red: led[0], yellow: led[1], green: led[2], rgb: led[3], thresholdYellow: led[4], thresholdRed: led[5] } : null,
      rfid:   rfid   ? Array.from({ length: 4 }, (_, i) => ({ uidHigh: rfid[i*2], uidLow: rfid[i*2+1], count: rfid[8+i] })) : null,
      volume: vol ? vol[0] : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/configuration', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { timing, led, rfid, volume } = req.body;
  try {
    for (const sid of availableStations) {
      if (timing) await modbusHandler.setTimingConfig(sid, timing.transistor, timing.diode, timing.ic, timing.capacitor, timing.transport);
      if (led)    await modbusHandler.setLedConfig(sid, led.red, led.yellow, led.green, led.rgb, led.thresholdYellow, led.thresholdRed);
      if (rfid) {
        const vals = [];
        rfid.forEach(b => vals.push(b.uidHigh, b.uidLow));
        rfid.forEach(b => vals.push(b.count));
        await modbusHandler.writeHoldingRegisters(sid, HoldingRegisterAddresses.RFID_BOX_UID_START, vals);
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
      if (!(await modbusHandler.softReset(sid))) throw new Error(`Reset failed on ${sid}`);
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
        inputCoils:   await modbusHandler.readCoils(sid, CoilAddresses.INPUT_TRANSISTOR_1_IS_POPULATED, 14),
        outputInputs: await modbusHandler.readDiscreteInputs(sid, DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED, 14),
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