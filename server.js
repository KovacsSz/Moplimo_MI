/**
 * SMT Pick and Place Machine Controller
 * Express + Socket.IO backend server
 *
 * Behaviour summary:
 *  - Auto-detects COM port by pinging Slave ID 4.
 *  - Watches for PCB Loader (Slave ID 5).
 *  - Initialization runs only when BOTH ID5 is present AND ≥1 web client connected.
 *  - If ID5 disappears OR last web client disconnects while stations are on
 *    ACTIVE_PAGE_ID 1 (setup) or 2 (animation):
 *      → write ACTIVE_PAGE_ID = 0 (Startup) to every station
 *      → set "Waiting for initialization" status
 *      → all station activity frozen.
 *  - When a web client connects again while frozen:
 *      → if ID5 is present: re-run init (sets ACTIVE_PAGE_ID = 1 on all stations)
 *      → if ID5 absent: set pending flag, wait for ID5
 *  - If BOTH ID5 and ID4 are offline:
 *      → stop all comms, ping ID4 on the existing open port (no re-scan).
 *  - PORT_RESCAN_DELAY_MS = 2 000 ms.
 *  - No soft-reset / UI-load phases during init.
 */

'use strict';

// ─── GLOBAL UNHANDLED-ERROR SAFETY NET ───────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.warn('[Process] Caught unhandled exception (suppressed):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[Process] Caught unhandled rejection (suppressed):', reason);
});

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

// ─── APP SETUP ────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const PROBE_SLAVE_ID           = 4;
const PROBE_TIMEOUT_MS         = 200;
const PORT_RESCAN_DELAY_MS     = 500;
const LOADER_WATCH_INTERVAL_MS = 500;
const LOADER_PING_RETRIES      = 2;
const ID4_PING_INTERVAL_MS     = 500;
const ID4_PING_TIMEOUT_MS      = 200;

// Pages that mean "actively in use" — leaving these requires writing STARTUP(0)
const ACTIVE_PAGES = new Set([
  PageID.PLACEMENT_PARAMETERS_SETUP,   // 1
  PageID.PICK_AND_PLACE_ANIMATION,     // 2
]);

const PARITY_MAP = { N: 'none', E: 'even', O: 'odd' };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── APPLICATION STATE ────────────────────────────────────────────────────────

let modbusHandler     = null;
let stationManager    = null;
let availableStations = [];
let loaderStationId   = PCB_LOADER_SLAVE_ID;
let pnpStations       = [];
let pendingTotalPcbs  = 10;
let detectedPort      = null;

// Tracks the last ACTIVE_PAGE_ID written to all stations.
//   null  = unknown / never set (pre first init)
//   0     = STARTUP  (frozen / waiting for init)
//   1     = PLACEMENT_PARAMETERS_SETUP
//   2     = PICK_AND_PLACE_ANIMATION
let currentStationPage = null;

// Flag: system was frozen (page 0) and is waiting for a client + ID5
// so it can re-initialize automatically.
let frozenWaitingForClient = false;

// Loader watch
let loaderWatchActive = false;
let loaderWatchTimer  = null;
let loaderPresent     = false;

// Initialisation gate
let initInProgress       = false;
let initPendingForClient = false;  // loader present but no client yet

// Web-client tracking
let clientCount = 0;

// ID4 recovery ping loop
let id4PingActive = false;
let id4PingTimer  = null;

// System status
let systemStatus  = 'idle';
let statusMessage = 'Starting up…';
let initLogBuffer = [];

// ─── BROADCAST HELPERS ────────────────────────────────────────────────────────

function broadcast(event, data) {
  io.emit(event, data);
}

function log(message, pct = null) {
  const payload = { message };
  if (pct !== null) payload.pct = pct;
  initLogBuffer.push(payload);
  if (initLogBuffer.length > 200) initLogBuffer.shift();
  broadcast('initProgress', payload);
  console.log(`[Init] ${message}`);
}

function setStatus(status, message) {
  systemStatus  = status;
  statusMessage = message;
  broadcastSystemState();
  console.log(`[Status] ${status}: ${message}`);
}

function broadcastSystemState() {
  broadcast('systemState', buildSystemState());
}

function buildSystemState() {
  return {
    systemStatus,
    statusMessage,
    serialPort:        detectedPort ?? '—',
    loaderPresent,
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  };
}

// ─── STATION-MANAGER EMIT ─────────────────────────────────────────────────────

function managerEmit(event) {
  io.emit(event.type, event);

  switch (event.type) {

    case 'buttonPressed':
      setTimeout(async () => {
        try {
          setStatus('production', 'Starting production…');
          await _setAllStationsPage(PageID.PICK_AND_PLACE_ANIMATION);
          await stationManager.startProduction(pendingTotalPcbs);
        } catch (err) {
          console.error('[Server] Failed to auto-start production:', err.message);
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
      currentStationPage = PageID.PLACEMENT_PARAMETERS_SETUP;
      setStatus('ready', 'Setup mode — ready for next batch');
      broadcast('connectionState', {
        connected: true,
        availableStations,
        loaderStationId,
        pnpStations,
      });
      break;

    case 'setupComplete':
      broadcast('setupComplete', {});
      break;
  }
}

// ─── HELPER: set ACTIVE_PAGE_ID on all known stations ────────────────────────

async function _setAllStationsPage(pageId) {
  if (!modbusHandler || !modbusHandler.connected) return;

  const stations = availableStations.length > 0
    ? availableStations
    : (loaderPresent ? [PCB_LOADER_SLAVE_ID] : []);

  for (const sid of stations) {
    try {
      const ok = await modbusHandler.setActivePage(sid, pageId);
      console.log(
        `[Server] setActivePage(${sid}, ${pageId}) → ${ok ? 'OK' : 'FAILED'}`
      );
    } catch (err) {
      console.warn(`[Server] setActivePage(${sid}) error: ${err.message}`);
    }
  }
  currentStationPage = pageId;
}

// ─── SERIAL PORT AUTO-DETECTION ───────────────────────────────────────────────

async function getCandidatePorts() {
  let all = [];
  try {
    all = await SerialPort.list();
  } catch (err) {
    console.error('[Probe] SerialPort.list() failed:', err.message);
    return [];
  }

  const candidates = all.filter((p) => {
    const pt = p.path;
    if (process.platform === 'win32') return true;
    if (/\/dev\/ttyUSB\d+/.test(pt))  return true;
    if (/\/dev\/ttyACM\d+/.test(pt))  return true;
    if (/\/dev\/ttyAMA\d+/.test(pt))  return true;
    if (/\/dev\/ttyS[0-3]$/.test(pt)) return true;
    return false;
  });

  candidates.sort((a, b) => {
    const rank = (pt) => {
      if (pt.includes('ttyUSB')) return 0;
      if (pt.includes('ttyACM')) return 1;
      if (pt.includes('ttyAMA')) return 2;
      return 3;
    };
    return rank(a.path) - rank(b.path);
  });

  return candidates;
}

function silentClose(client) {
  if (!client) return;
  try {
    const port = client._port;
    if (port) { try { port.removeAllListeners(); } catch { /* ignore */ } }
    try { client.removeAllListeners(); } catch { /* ignore */ }
    if (client.isOpen) client.close(() => {});
  } catch { /* ignore */ }
}

async function probePort(portPath) {
  console.log(`[Probe] Testing ${portPath} …`);

  const client = new ModbusRTU();
  const noop   = () => {};
  client.on('error', noop);

  try {
    await client.connectRTUBuffered(portPath, {
      baudRate: MODBUS_BAUDRATE,
      parity:   PARITY_MAP[MODBUS_PARITY] ?? 'none',
      stopBits: MODBUS_STOP_BITS,
      dataBits: MODBUS_DATA_BITS,
    });

    try { if (client._port) client._port.on('error', noop); } catch { /* ignore */ }

    client.setTimeout(PROBE_TIMEOUT_MS);
    await sleep(150);
    client.setID(PROBE_SLAVE_ID);

    let responded = false;
    try {
      const result = await client.readDiscreteInputs(
        DiscreteInputAddresses.IS_UI_LOADED, 1
      );
      responded = result !== null && result.data !== undefined;
    } catch { responded = false; }

    console.log(
      responded
        ? `[Probe] ${portPath}: ✓ Slave ${PROBE_SLAVE_ID} responded`
        : `[Probe] ${portPath}: no response from Slave ${PROBE_SLAVE_ID}`
    );
    return responded;

  } catch (err) {
    console.log(`[Probe] ${portPath}: could not open — ${err.message}`);
    return false;

  } finally {
    await sleep(50);
    silentClose(client);
    await sleep(250);
  }
}

async function autoDetectPort() {
  const candidates = await getCandidatePorts();

  if (candidates.length === 0) {
    console.log('[Probe] No candidate serial ports found on this system');
    return null;
  }

  console.log(
    `[Probe] Scanning ${candidates.length} candidate port(s): ` +
    candidates.map((p) => p.path).join(', ')
  );

  for (const candidate of candidates) {
    if (await probePort(candidate.path)) {
      console.log(`[Probe] ✓ Modbus bus detected on ${candidate.path}`);
      return candidate.path;
    }
  }

  console.log('[Probe] No port responded — adapter absent or Station 4 not connected');
  return null;
}

// ─── INITIAL SERVER START ─────────────────────────────────────────────────────

async function autoConnect() {
  setStatus('connecting', 'Scanning serial ports for Modbus bus…');
  console.log('[Server] Starting serial port auto-detection…');

  const portPath = await autoDetectPort();

  if (!portPath) {
    const msg = `No Modbus bus found. Retrying in ${PORT_RESCAN_DELAY_MS / 1000} s…`;
    setStatus('error', msg);
    console.error(`[Server] ${msg}`);
    setTimeout(autoConnect, PORT_RESCAN_DELAY_MS);
    return;
  }

  await _openPort(portPath);
}

async function _openPort(portPath) {
  detectedPort = portPath;
  setStatus('connecting', `Port ${portPath} identified — connecting…`);

  if (modbusHandler) {
    try { modbusHandler.disconnect(); } catch { /* ignore */ }
    modbusHandler = null;
  }

  modbusHandler = new ModbusHandler(portPath, {
    timeoutMs:    1000,
    retries:      2,
    retryDelayMs: 200,
  });

  const connected = await modbusHandler.connect();
  if (!connected) {
    const msg =
      `Failed to open ${portPath}. Retrying in ${PORT_RESCAN_DELAY_MS / 1000} s…`;
    setStatus('error', msg);
    console.error(`[Server] ${msg}`);
    detectedPort  = null;
    modbusHandler = null;
    setTimeout(autoConnect, PORT_RESCAN_DELAY_MS);
    return;
  }

  console.log(`[Server] Serial port ${portPath} open`);
  setStatus(
    'idle',
    `Port ${portPath} open — watching for PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})…`
  );

  await sleep(200);
  startLoaderWatch();
}

// ─── PCB LOADER WATCH LOOP ────────────────────────────────────────────────────

async function pingLoader() {
  if (!modbusHandler || !modbusHandler.connected) return false;
  for (let i = 0; i < LOADER_PING_RETRIES; i++) {
    const ok = await modbusHandler.pingStation(PCB_LOADER_SLAVE_ID);
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

async function loaderWatchLoop() {
  if (!loaderWatchActive) return;

  try {
    const nowPresent = await pingLoader();

    if (nowPresent && !loaderPresent) {
      loaderPresent = true;
      console.log('[Watch] PCB Loader (ID5) appeared');
      broadcast('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });
      await onLoaderDetected();

    } else if (!nowPresent && loaderPresent) {
      loaderPresent = false;
      console.log('[Watch] PCB Loader (ID5) disappeared');
      broadcast('loaderRemoved', { slaveId: PCB_LOADER_SLAVE_ID });
      await onLoaderRemoved();
    }
  } catch (err) {
    console.error('[Watch] Loop error:', err.message);
  }

  if (loaderWatchActive) {
    loaderWatchTimer = setTimeout(loaderWatchLoop, LOADER_WATCH_INTERVAL_MS);
  }
}

function startLoaderWatch() {
  if (loaderWatchActive) return;
  loaderWatchActive = true;
  loaderPresent     = false;
  console.log('[Watch] PCB Loader watch started');
  loaderWatchLoop();
}

function stopLoaderWatch() {
  loaderWatchActive = false;
  if (loaderWatchTimer) {
    clearTimeout(loaderWatchTimer);
    loaderWatchTimer = null;
  }
  console.log('[Watch] PCB Loader watch stopped');
}

// ─── ID4 RECOVERY PING LOOP ──────────────────────────────────────────────────

async function pingId4Once() {
  if (!modbusHandler || !modbusHandler.connected) return false;
  try {
    const orig = modbusHandler.timeoutMs;
    modbusHandler.timeoutMs = ID4_PING_TIMEOUT_MS;
    modbusHandler.client.setTimeout(ID4_PING_TIMEOUT_MS);
    const ok = await modbusHandler.pingStation(PROBE_SLAVE_ID);
    modbusHandler.timeoutMs = orig;
    modbusHandler.client.setTimeout(orig);
    return ok;
  } catch {
    return false;
  }
}

function startId4PingLoop() {
  if (id4PingActive) return;
  id4PingActive = true;
  console.log('[Recovery] Starting ID4 ping loop on existing port…');
  _id4PingTick();
}

function stopId4PingLoop() {
  id4PingActive = false;
  if (id4PingTimer) {
    clearTimeout(id4PingTimer);
    id4PingTimer = null;
  }
  console.log('[Recovery] ID4 ping loop stopped');
}

async function _id4PingTick() {
  if (!id4PingActive) return;

  try {
    const ok = await pingId4Once();
    if (ok) {
      console.log('[Recovery] ID4 responded — resuming loader watch');
      stopId4PingLoop();
      startLoaderWatch();
      setStatus(
        'idle',
        `Bus restored — watching for PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})…`
      );
      return;
    }
    console.log('[Recovery] ID4 still offline…');
  } catch (err) {
    console.error('[Recovery] Ping error:', err.message);
  }

  if (id4PingActive) {
    id4PingTimer = setTimeout(_id4PingTick, ID4_PING_INTERVAL_MS);
  }
}

// ─── FULL STATION TEARDOWN (port stays open) ──────────────────────────────────

function _teardownStations() {
  if (stationManager) {
    stationManager._stopPolling();
    stationManager = null;
  }

  stopLoaderWatch();

  availableStations      = [];
  pnpStations            = [];
  loaderPresent          = false;
  initInProgress         = false;
  initPendingForClient   = false;
  frozenWaitingForClient = false;
  currentStationPage     = null;

  broadcast('connectionState', {
    connected:         false,
    availableStations: [],
    loaderStationId,
    pnpStations:       [],
  });
}

// ─── CHECK ID4 → MAYBE ESCALATE TO FULL RECOVERY ─────────────────────────────

async function _checkId4AndMaybeRecover() {
  console.log('[Server] Checking whether ID4 is still online…');

  const id4Ok = await pingId4Once();

  if (id4Ok) {
    console.log('[Server] ID4 still online — keeping port open, watching for ID5');
    return;
  }

  console.log('[Server] ID4 also offline — entering full recovery mode');
  setStatus(
    'error',
    'Bus offline (ID4 + ID5 not responding) — waiting for bus to recover…'
  );

  _teardownStations();
  startId4PingLoop();
}

// ─── FREEZE FOR RE-INITIALIZATION ────────────────────────────────────────────
//
// 1. Stops the station manager poll.
// 2. Writes ACTIVE_PAGE_ID = 0 (STARTUP) to every station currently on
//    page 1 or 2.
// 3. Sets frozenWaitingForClient = true so that the next client connection
//    knows it must re-run initialization.
// 4. Updates system status to "Waiting for initialization".

async function _freezeForReinitialization(msg) {
  console.log(`[Server] Freezing — ${msg}`);

  // Stop manager first so no more Modbus traffic races with our writes
  if (stationManager) {
    stationManager._stopPolling();
    stationManager = null;
  }

  // Write STARTUP page (0) to every station that is on an active page
  if (
    modbusHandler &&
    modbusHandler.connected &&
    ACTIVE_PAGES.has(currentStationPage)
  ) {
    const stations = availableStations.length > 0
      ? availableStations
      : (loaderPresent ? [PCB_LOADER_SLAVE_ID] : []);

    console.log(
      `[Server] Writing STARTUP page (0) to ${stations.length} station(s)…`
    );

    for (const sid of stations) {
      try {
        const ok = await modbusHandler.setActivePage(sid, PageID.STARTUP);
        console.log(
          `[Server]   Station ${sid}: setActivePage(STARTUP=0) → ${ok ? 'OK' : 'FAILED'}`
        );
      } catch (err) {
        console.warn(
          `[Server]   Station ${sid}: setActivePage error — ${err.message}`
        );
      }
    }
    currentStationPage = PageID.STARTUP;
  }

  // Clear tracking state but keep the COM port open
  availableStations    = [];
  pnpStations          = [];
  initInProgress       = false;
  initPendingForClient = false;

  // Mark that we are frozen: next client connect + ID5 present → re-init
  frozenWaitingForClient = true;

  setStatus('idle', msg);

  broadcast('connectionState', {
    connected:         false,
    availableStations: [],
    loaderStationId,
    pnpStations:       [],
  });
}

// ─── ON CLIENT RECONNECT WHILE FROZEN ────────────────────────────────────────
//
// Called when a web client connects and frozenWaitingForClient is true.
// Restores ACTIVE_PAGE_ID = 1 on all reachable stations, then re-runs the
// full initialization sequence (which will also re-discover P&P stations).

async function _onClientReconnectWhileFrozen(socket) {
  console.log(
    '[Server] Client reconnected while frozen — ' +
    'setting ACTIVE_PAGE_ID=1 and re-initializing…'
  );

  frozenWaitingForClient = false;   // clear flag before async work

  // Inform the GUI that the loader is present so the progress bar appears
  socket.emit('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });

  // Write ACTIVE_PAGE_ID = 1 (setup) to whatever stations are still reachable.
  // runInitSequence() will re-detect and write again anyway, but doing it here
  // gives immediate visual feedback on the station displays.
  if (modbusHandler && modbusHandler.connected && loaderPresent) {
    console.log('[Server] Pre-setting ACTIVE_PAGE_ID=1 on loader before init…');
    try {
      await modbusHandler.setActivePage(
        PCB_LOADER_SLAVE_ID,
        PageID.PLACEMENT_PARAMETERS_SETUP
      );
      currentStationPage = PageID.PLACEMENT_PARAMETERS_SETUP;
    } catch (err) {
      console.warn('[Server] Pre-set page failed:', err.message);
    }
  }

  // Run the full init sequence
  await _startInitSequence();
}

// ─── LOADER DETECTED ─────────────────────────────────────────────────────────

async function onLoaderDetected() {
  if (initInProgress) return;

  if (clientCount === 0) {
    initPendingForClient = true;
    console.log(
      '[Server] PCB Loader detected but no web client connected — ' +
      'holding in Startup page until client connects'
    );
    setStatus(
      'idle',
      'PCB Loader present — waiting for web client before initializing…'
    );
    return;
  }

  initPendingForClient = false;
  await _startInitSequence();
}

// ─── LOADER REMOVED ──────────────────────────────────────────────────────────

async function onLoaderRemoved() {
  console.log('[Server] PCB Loader (ID5) removed');
  initPendingForClient = false;

  await _freezeForReinitialization(
    'PCB Loader disconnected — waiting for initialization…'
  );

  await _checkId4AndMaybeRecover();
}

// ─── LAST CLIENT DISCONNECTED ─────────────────────────────────────────────────

async function onLastClientDisconnected() {
  console.log('[Server] Last web client disconnected');

  if (!ACTIVE_PAGES.has(currentStationPage)) {
    console.log(
      `[Server] Stations on page ${currentStationPage} — no page change needed`
    );
    return;
  }

  await _freezeForReinitialization(
    'Web client disconnected — waiting for initialization…'
  );

  await _checkId4AndMaybeRecover();
}

// ─── KICK OFF INIT SEQUENCE ───────────────────────────────────────────────────

async function _startInitSequence() {
  if (initInProgress) return;
  if (!loaderPresent)  return;

  initInProgress = true;
  initLogBuffer  = [];

  setStatus('initializing', 'PCB Loader detected — initializing system…');

  try {
    await runInitSequence();
  } catch (err) {
    console.error('[Server] Init sequence failed:', err.message);
    log(`✗ INITIALIZATION FAILED: ${err.message}`);
    setStatus('error', `Initialization failed: ${err.message}`);

    availableStations  = [];
    pnpStations        = [];
    stationManager     = null;
    currentStationPage = null;
    broadcast('connectionState', {
      connected:         false,
      availableStations: [],
      loaderStationId,
      pnpStations:       [],
    });
  } finally {
    initInProgress = false;
  }
}

// ─── INITIALIZATION SEQUENCE ──────────────────────────────────────────────────

async function runInitSequence() {

  // Step 1 — Confirm PCB Loader
  log(`Detecting PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})…`, 5);
  let loaderFound = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    loaderFound = await modbusHandler.pingStation(PCB_LOADER_SLAVE_ID);
    if (loaderFound) break;
    log(`  PCB Loader not responding, retry ${attempt + 1}/5…`);
    await sleep(500);
  }
  if (!loaderFound) {
    throw new Error(
      `PCB Loader (ID ${PCB_LOADER_SLAVE_ID}) did not respond after 5 attempts`
    );
  }
  log(`✓ PCB Loader confirmed (ID ${PCB_LOADER_SLAVE_ID})`, 10);

  // Step 2 — Detect P&P stations
  log('Detecting Pick and Place stations…', 20);
  const foundPnp = [];
  for (const sid of SLAVE_IDS) {
    const found = await modbusHandler.pingStation(sid);
    if (found) {
      foundPnp.push(sid);
      log(`  ✓ P&P Station ${sid} detected`);
    } else {
      log(`  – P&P Station ${sid} not found (skipped)`);
    }
    await sleep(100);
  }
  if (foundPnp.length === 0) {
    throw new Error('No Pick and Place stations detected');
  }
  log(`✓ ${foundPnp.length} P&P station(s) found: [${foundPnp}]`, 35);

  const allStations = [PCB_LOADER_SLAVE_ID, ...foundPnp];

  // Step 3 — Verify IDs, set ACTIVE_PAGE_ID=1 (setup), write default counts
  log('\nVerifying IDs, setting setup page and default components…', 40);

  for (let i = 0; i < allStations.length; i++) {
    const sid  = allStations[i];
    const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${sid}`;

    // Verify station ID register
    const stationId = await modbusHandler.getStationId(sid);
    if (stationId === null) {
      throw new Error(`${name}: could not read station ID register`);
    }
    if (stationId !== sid) {
      throw new Error(`${name} ID mismatch: expected ${sid}, got ${stationId}`);
    }

    // Set ACTIVE_PAGE_ID = 1
    const pageOk = await modbusHandler.setActivePage(
      sid, PageID.PLACEMENT_PARAMETERS_SETUP
    );
    if (!pageOk) throw new Error(`Failed to set setup page for ${name}`);

    // Write default component counts
    const countsOk = await modbusHandler.setTotalPositions(
      sid,
      DefaultComponentCounts.transistors,
      DefaultComponentCounts.diodes,
      DefaultComponentCounts.ics,
      DefaultComponentCounts.capacitors
    );
    if (!countsOk) {
      throw new Error(`Failed to write default component counts to ${name}`);
    }

    log(
      `  ✓ ${name}: ID verified, setup page set, defaults written ` +
      `(T:${DefaultComponentCounts.transistors} ` +
      `D:${DefaultComponentCounts.diodes} ` +
      `IC:${DefaultComponentCounts.ics} ` +
      `C:${DefaultComponentCounts.capacitors})`
    );

    broadcast('initProgress', {
      pct: 40 + Math.round(((i + 1) / allStations.length) * 58),
    });
  }

  // All stations are now on page 1 (PLACEMENT_PARAMETERS_SETUP)
  currentStationPage     = PageID.PLACEMENT_PARAMETERS_SETUP;
  frozenWaitingForClient = false;   // successfully initialized — no longer frozen

  log('', 100);
  log('✓ ALL STATIONS INITIALIZED SUCCESSFULLY');
  log(`  PCB Loader  : Slave ID ${PCB_LOADER_SLAVE_ID}`);
  log(`  Pick & Place: Slave IDs [${foundPnp}]`);

  availableStations = allStations;
  loaderStationId   = PCB_LOADER_SLAVE_ID;
  pnpStations       = foundPnp;

  stationManager = new StationManager(
    modbusHandler,
    loaderStationId,
    pnpStations,
    managerEmit
  );

  setStatus('ready', `System ready — ${foundPnp.length} P&P station(s) online`);

  broadcast('connectionState', {
    connected:         true,
    availableStations,
    loaderStationId,
    pnpStations,
  });
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  clientCount++;
  console.log(`[Socket] Active clients: ${clientCount}`);

  // Send current state to new client
  socket.emit('systemState', buildSystemState());
  socket.emit('connectionState', {
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  });

  initLogBuffer.forEach((entry) => socket.emit('initProgress', entry));

  if (stationManager) {
    socket.emit('snapshot', stationManager.getSnapshot());
  }

  // ── Decide what to do on this new connection ──────────────────────────────

  if (frozenWaitingForClient && loaderPresent && clientCount === 1) {
    // ── Case A: system was frozen (page 0) and ID5 is present ─────────────
    // Re-initialize: set ACTIVE_PAGE_ID=1, then run full init sequence.
    console.log(
      '[Socket] Client connected — system frozen with ID5 present, ' +
      're-initializing (ACTIVE_PAGE_ID=1)…'
    );
    setImmediate(async () => {
      await _onClientReconnectWhileFrozen(socket);
    });

  } else if (frozenWaitingForClient && !loaderPresent && clientCount === 1) {
    // ── Case B: frozen but ID5 is still absent ─────────────────────────────
    // Stay frozen; set pending flag so init fires when ID5 appears.
    console.log(
      '[Socket] Client connected — system frozen but ID5 absent, ' +
      'waiting for ID5 before initializing…'
    );
    initPendingForClient   = true;
    frozenWaitingForClient = false;   // client is now here; pending covers the rest

  } else if (initPendingForClient && clientCount === 1) {
    // ── Case C: loader appeared before any client was connected ───────────
    console.log(
      '[Socket] First web client connected and init was pending — ' +
      'starting initialization now'
    );
    setImmediate(async () => {
      initPendingForClient = false;
      socket.emit('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });
      await _startInitSequence();
    });
  }

  // ── Client disconnect ─────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    clientCount = Math.max(0, clientCount - 1);
    console.log(
      `[Socket] Client disconnected: ${socket.id} — Active clients: ${clientCount}`
    );

    if (clientCount === 0) {
      setImmediate(async () => {
        await onLastClientDisconnected();
      });
    }
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/system/status', (_req, res) => {
  res.json(buildSystemState());
});

app.get('/api/setup/components', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const result = {};
    for (const sid of pnpStations) {
      const components = await modbusHandler.getComponentsToPlace(sid);
      result[sid] = components
        ? {
            transistors: components[0],
            diodes:      components[1],
            ics:         components[2],
            capacitors:  components[3],
          }
        : { transistors: 0, diodes: 0, ics: 0, capacitors: 0 };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/setup/total-positions', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { slaveId, transistors, diodes, ics, capacitors } = req.body;
  try {
    const ok = await modbusHandler.setTotalPositions(
      slaveId, transistors, diodes, ics, capacitors
    );
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/setup/start-button', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { active } = req.body;
  try {
    const ok = await modbusHandler.setStartButtonActive(loaderStationId, active);
    if (stationManager) {
      if (active) {
        await stationManager.onSetupComplete();
      } else {
        stationManager.onSetupIncomplete();
      }
    }
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/operation/stop', async (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  try {
    await stationManager.stopProduction();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  if (!stationManager) {
    return res.status(400).json({ error: 'No station manager active' });
  }
  try {
    console.log('[Server] acknowledge-complete received — running _returnToSetup');
    await stationManager._returnToSetup();
    res.json({ success: true });
  } catch (err) {
    console.error('[Server] _returnToSetup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/configuration', async (_req, res) => {
  if (!modbusHandler || pnpStations.length === 0) {
    return res.status(400).json({ error: 'No P&P stations connected' });
  }
  const slaveId = pnpStations[0];
  try {
    const timing = await modbusHandler.readHoldingRegisters(
      slaveId, HoldingRegisterAddresses.TRANSISTOR_PLACEMENT_DURATION_MS, 5
    );
    const led = await modbusHandler.readHoldingRegisters(
      slaveId, HoldingRegisterAddresses.BRIGHTNESS_RED_LED, 6
    );
    const rfid = await modbusHandler.readHoldingRegisters(
      slaveId, HoldingRegisterAddresses.RFID_BOX_UID_START, 12
    );
    const vol = await modbusHandler.readHoldingRegisters(
      slaveId, HoldingRegisterAddresses.SPEAKER_VOLUME, 1
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/configuration', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { timing, led, rfid, volume } = req.body;
  try {
    for (const sid of availableStations) {
      if (timing) {
        await modbusHandler.setTimingConfig(
          sid, timing.transistor, timing.diode,
          timing.ic, timing.capacitor, timing.transport
        );
      }
      if (led) {
        await modbusHandler.setLedConfig(
          sid, led.red, led.yellow, led.green,
          led.rgb, led.thresholdYellow, led.thresholdRed
        );
      }
      if (rfid) {
        const rfidValues = [];
        for (const box of rfid) rfidValues.push(box.uidHigh, box.uidLow);
        for (const box of rfid) rfidValues.push(box.count);
        await modbusHandler.writeHoldingRegisters(
          sid, HoldingRegisterAddresses.RFID_BOX_UID_START, rfidValues
        );
      }
      if (volume != null) await modbusHandler.setSpeakerVolume(sid, volume);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/configuration/soft-reset', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    for (const sid of availableStations) {
      if (!(await modbusHandler.softReset(sid))) {
        throw new Error(`Failed to reset Station ${sid}`);
      }
    }
    await sleep(2000);
    const timeout = 10000;
    const start   = Date.now();
    let allReset  = false;
    while (!allReset && Date.now() - start < timeout) {
      allReset = true;
      for (const sid of availableStations) {
        if (!(await modbusHandler.checkSoftResetComplete(sid))) {
          allReset = false; break;
        }
      }
      if (!allReset) await sleep(200);
    }
    if (!allReset) throw new Error('Reset timeout — check station status manually');
    for (const sid of availableStations) {
      await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
    }
    currentStationPage = PageID.PLACEMENT_PARAMETERS_SETUP;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitoring', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const allStations = [loaderStationId, ...pnpStations];
    const result = {};
    for (const sid of allStations) {
      const statusData   = await modbusHandler.getAllStatus(sid);
      const inputCoils   = await modbusHandler.readCoils(
        sid, CoilAddresses.INPUT_TRANSISTOR_1_IS_POPULATED, 14
      );
      const outputInputs = await modbusHandler.readDiscreteInputs(
        sid, DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED, 14
      );
      result[sid] = { statusData, inputCoils, outputInputs };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, async () => {
  console.log(`[Server] SMT Pick & Place Controller at http://localhost:${PORT}`);
  await autoConnect();
});