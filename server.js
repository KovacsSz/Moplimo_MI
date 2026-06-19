/**
 * SMT Pick and Place Machine Controller
 * Express + Socket.IO backend server
 * Auto-connects and monitors PCB Loader (Slave ID 5)
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server: SocketIOServer } = require('socket.io');
const cors       = require('cors');
const path       = require('path');
const { SerialPort } = require('serialport');

const ModbusHandler  = require('./src/modbusHandler');
const StationManager = require('./src/stationManager');
const {
  PCB_LOADER_SLAVE_ID,
  SLAVE_IDS,
  PageID,
  DefaultComponentCounts,
  DefaultTimingConfig,
  DefaultLEDConfig,
  DefaultAudioConfig,
  HoldingRegisterAddresses,
  CoilAddresses,
  DiscreteInputAddresses,
} = require('./src/modbusDefinitions');

// ─── APP SETUP ────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── APPLICATION STATE ────────────────────────────────────────────────────────

let modbusHandler       = null;
let stationManager      = null;
let availableStations   = [];
let loaderStationId     = PCB_LOADER_SLAVE_ID;
let pnpStations         = [];
let pendingTotalPcbs    = 10;

// Loader-watch loop state
let loaderWatchActive   = false;
let loaderWatchTimer    = null;
let loaderPresent       = false;     // last known state of PCB Loader
let initInProgress      = false;     // guard: only one init at a time
let selectedPort        = null;      // port chosen by user

// System status for GUI
let systemStatus        = 'idle';    // 'idle' | 'initializing' | 'ready' | 'production' | 'error'
let statusMessage       = 'Waiting for serial port selection';
let initLog             = [];

const LOADER_WATCH_INTERVAL_MS  = 2000;   // how often to ping Slave ID 5
const LOADER_PING_RETRIES       = 2;      // pings before declaring absent/present
const RESET_POLL_INTERVAL_MS    = 500;
const RESET_TOTAL_TIMEOUT_MS    = 30000;
const UI_WAIT_PER_STATION_MS    = 20000;
const UI_POLL_INTERVAL_MS       = 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── BROADCAST HELPERS ────────────────────────────────────────────────────────

function broadcast(event, data) {
  io.emit(event, data);
}

function broadcastSystemState() {
  broadcast('systemState', {
    systemStatus,
    statusMessage,
    selectedPort,
    loaderPresent,
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
    // keep legacy key so existing client code still works
    connectionState: {
      connected:         modbusHandler?.connected ?? false,
      availableStations,
      loaderStationId,
      pnpStations,
    },
  });
}

function log(message, pct = null) {
  const entry = { message, pct, ts: Date.now() };
  initLog.push(entry);
  if (initLog.length > 200) initLog.shift();

  const payload = { message };
  if (pct !== null) payload.pct = pct;
  broadcast('initProgress', payload);
  console.log(`[Init] ${message}`);
}

function setStatus(status, message) {
  systemStatus  = status;
  statusMessage = message;
  broadcastSystemState();
}

// ─── MANAGER EMIT ─────────────────────────────────────────────────────────────

function managerEmit(event) {
  io.emit(event.type, event);

  switch (event.type) {
    case 'buttonPressed':
      // Auto-start production 1 s after physical button pressed
      setTimeout(async () => {
        try {
          for (const sid of availableStations) {
            await modbusHandler.setActivePage(sid, PageID.PICK_AND_PLACE_ANIMATION);
          }
          setStatus('production', 'Production running');
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
      setStatus('ready', 'Production complete — ready for next batch');
      break;

    case 'productionStopped':
      setStatus('ready', 'Production stopped — system ready');
      break;

    case 'returnedToSetup':
      setStatus('ready', 'Stations returned to setup page');
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

// ─── LOADER WATCH LOOP ────────────────────────────────────────────────────────

/**
 * Ping Slave ID 5 with multiple attempts for reliability.
 */
async function pingLoader() {
  if (!modbusHandler || !modbusHandler.connected) return false;
  for (let i = 0; i < LOADER_PING_RETRIES; i++) {
    const ok = await modbusHandler.pingStation(PCB_LOADER_SLAVE_ID);
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Called when PCB Loader is detected for the first time (or re-detected).
 * Runs the full initialization sequence.
 */
async function onLoaderDetected() {
  if (initInProgress) return;
  initInProgress = true;
  initLog = [];

  setStatus('initializing', 'PCB Loader detected — initializing system');
  broadcast('loaderDetected', { slaveId: PCB_LOADER_SLAVE_ID });

  try {
    await runInitSequence();
  } catch (err) {
    console.error('[Server] Init sequence failed:', err.message);
    log(`✗ INITIALIZATION FAILED: ${err.message}`);
    setStatus('error', `Initialization failed: ${err.message}`);
    // Clean up so next detect attempt can retry
    availableStations = [];
    pnpStations       = [];
    stationManager    = null;
  } finally {
    initInProgress = false;
  }
}

/**
 * Called when PCB Loader disappears.
 * Resets all connected stations to idle and stops production.
 */
async function onLoaderRemoved() {
  console.log('[Server] PCB Loader removed — resetting all stations');
  broadcast('loaderRemoved', { slaveId: PCB_LOADER_SLAVE_ID });
  setStatus('idle', 'PCB Loader disconnected — stations in last mode');

  // Stop any running production / monitoring
  if (stationManager) {
    stationManager._stopPolling();
    // Don't null it yet — we may need to re-init with same stations
  }

  // Attempt to put all known stations into idle / setup page
  // (best-effort — stations may also be gone)
  if (modbusHandler && modbusHandler.connected && availableStations.length > 0) {
    for (const sid of availableStations) {
      try {
        await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
      } catch { /* ignore — station may be offline */ }
    }
  }

  // Clear state so re-detection triggers a full re-init
  availableStations = [];
  pnpStations       = [];
  stationManager    = null;

  broadcast('connectionState', {
    connected:         modbusHandler?.connected ?? false,
    availableStations: [],
    loaderStationId,
    pnpStations:       [],
  });
}

/**
 * The background loop that watches for PCB Loader presence changes.
 */
async function loaderWatchLoop() {
  if (!loaderWatchActive) return;

  try {
    const nowPresent = await pingLoader();

    if (nowPresent && !loaderPresent) {
      // Rising edge: loader just appeared
      loaderPresent = true;
      console.log('[Watch] PCB Loader appeared');
      await onLoaderDetected();

    } else if (!nowPresent && loaderPresent) {
      // Falling edge: loader just disappeared
      loaderPresent = false;
      console.log('[Watch] PCB Loader disappeared');
      await onLoaderRemoved();
    }
    // else: no change — nothing to do
  } catch (err) {
    console.error('[Watch] Loop error:', err.message);
  }

  // Reschedule — only if still active and not in the middle of init
  if (loaderWatchActive) {
    loaderWatchTimer = setTimeout(loaderWatchLoop, LOADER_WATCH_INTERVAL_MS);
  }
}

function startLoaderWatch() {
  if (loaderWatchActive) return;
  loaderWatchActive = true;
  loaderPresent     = false;
  console.log('[Watch] PCB Loader watch started');
  loaderWatchLoop();   // kick off immediately
}

function stopLoaderWatch() {
  loaderWatchActive = false;
  if (loaderWatchTimer) {
    clearTimeout(loaderWatchTimer);
    loaderWatchTimer = null;
  }
  console.log('[Watch] PCB Loader watch stopped');
}

// ─── INITIALIZATION SEQUENCE ──────────────────────────────────────────────────

async function runInitSequence() {

  // ── Detect PCB Loader (already confirmed, but verify) ─────────────────────
  log(`Detecting PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})...`, 5);

  let loaderFound = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    loaderFound = await modbusHandler.pingStation(PCB_LOADER_SLAVE_ID);
    if (loaderFound) break;
    log(`  PCB Loader not responding, retry ${attempt + 1}/5...`);
    await sleep(500);
  }
  if (!loaderFound) {
    throw new Error(
      `PCB Loader Station (ID ${PCB_LOADER_SLAVE_ID}) not found — ` +
      `is it powered and connected?`
    );
  }
  log(`✓ PCB Loader detected (ID ${PCB_LOADER_SLAVE_ID})`, 10);

  // ── Detect P&P stations ───────────────────────────────────────────────────
  log('Detecting Pick and Place stations...', 12);
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
  log(`✓ ${foundPnp.length} P&P station(s) found: [${foundPnp}]`, 18);

  const allStations = [PCB_LOADER_SLAVE_ID, ...foundPnp];

  // ── Phase 1: Soft reset ───────────────────────────────────────────────────
  log('\nPhase 1 — Sending soft reset to all stations...', 20);

  for (const sid of allStations) {
    const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${sid}`;
    const ok = await modbusHandler.softReset(sid);
    if (!ok) throw new Error(`Failed to send soft reset to ${name}`);
    log(`  ↺ Reset sent → ${name}`);
    await sleep(50);
  }

  // ── Phase 2: Wait for reset complete ─────────────────────────────────────
  log('\nPhase 2 — Waiting for all stations to complete reset...');

  const pending    = new Set(allStations);
  const confirmed  = new Set();
  const resetStart = Date.now();

  while (pending.size > 0) {
    if (Date.now() - resetStart > RESET_TOTAL_TIMEOUT_MS) {
      const names = [...pending].map((s) =>
        s === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${s}`
      );
      throw new Error(
        `Reset timeout (${RESET_TOTAL_TIMEOUT_MS / 1000}s) for: ${names.join(', ')}`
      );
    }
    for (const sid of [...pending]) {
      const done = await modbusHandler.checkSoftResetComplete(sid);
      if (done) {
        const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${sid}`;
        log(`  ✓ ${name}: reset complete`);
        pending.delete(sid);
        confirmed.add(sid);
        const pct = 20 + Math.round((confirmed.size / allStations.length) * 30);
        broadcast('initProgress', { pct });
      }
    }
    if (pending.size > 0) await sleep(RESET_POLL_INTERVAL_MS);
  }

  // ── Phase 3: Wait for UI load ─────────────────────────────────────────────
  log('\nPhase 3 — Waiting for UIs to load on all stations...');
  broadcast('initProgress', { pct: 55 });

  for (let i = 0; i < allStations.length; i++) {
    const sid  = allStations[i];
    const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${sid}`;
    log(`  ⏳ Waiting for ${name} UI...`);

    const uiLoaded = await modbusHandler.checkUiLoaded(
      sid, UI_WAIT_PER_STATION_MS, UI_POLL_INTERVAL_MS
    );
    if (!uiLoaded) {
      throw new Error(
        `${name} UI did not load within ${UI_WAIT_PER_STATION_MS / 1000}s.`
      );
    }
    log(`  ✓ ${name}: UI loaded`);
    const pct = 55 + Math.round(((i + 1) / allStations.length) * 20);
    broadcast('initProgress', { pct });
  }

  // ── Phase 4: Verify IDs and set setup page ────────────────────────────────
  log('\nPhase 4 — Verifying station IDs and setting setup page...');
  broadcast('initProgress', { pct: 78 });

  for (let i = 0; i < allStations.length; i++) {
    const sid  = allStations[i];
    const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${sid}`;

    const stationId = await modbusHandler.getStationId(sid);
    if (stationId === null) throw new Error(`${name}: could not read station ID register`);
    if (stationId !== sid) {
      throw new Error(`${name} ID mismatch: expected ${sid}, got ${stationId}.`);
    }

    // Set setup page (ACTIVE_PAGE_ID = 1)
    const pageOk = await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
    if (!pageOk) throw new Error(`Failed to set setup page for ${name}`);

    // Set default component counts on holding registers 2-3-4-5
    const countsOk = await modbusHandler.setTotalPositions(
      sid,
      DefaultComponentCounts.transistors,
      DefaultComponentCounts.diodes,
      DefaultComponentCounts.ics,
      DefaultComponentCounts.capacitors
    );
    if (!countsOk) throw new Error(`Failed to set default component counts for ${name}`);

    log(`  ✓ ${name}: ID verified, setup page set, defaults written`);
    const pct = 78 + Math.round(((i + 1) / allStations.length) * 20);
    broadcast('initProgress', { pct });
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  broadcast('initProgress', {
    pct:     100,
    message: '✓ ALL STATIONS INITIALIZED SUCCESSFULLY',
  });
  log(`  - PCB Loader  : Slave ID ${PCB_LOADER_SLAVE_ID}`);
  log(`  - Pick & Place: Slave IDs [${foundPnp}]`);

  // Save application state
  availableStations = allStations;
  loaderStationId   = PCB_LOADER_SLAVE_ID;
  pnpStations       = foundPnp;

  // Create station manager
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

  // Send full current state immediately
  socket.emit('systemState', {
    systemStatus,
    statusMessage,
    selectedPort,
    loaderPresent,
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  });
  socket.emit('connectionState', {
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  });

  // Replay recent init log
  initLog.forEach((entry) => socket.emit('initProgress', { message: entry.message, pct: entry.pct }));

  if (stationManager) {
    socket.emit('snapshot', stationManager.getSnapshot());
  }

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// ── List serial ports ─────────────────────────────────────────────────────────
app.get('/api/ports', async (_req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json(ports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Select port & start watching ─────────────────────────────────────────────
app.post('/api/port/select', async (req, res) => {
  const { port } = req.body;
  if (!port) return res.status(400).json({ error: 'port is required' });

  // Stop existing watch
  stopLoaderWatch();

  // Disconnect existing handler
  if (modbusHandler) {
    modbusHandler.disconnect();
    modbusHandler = null;
  }
  stationManager    = null;
  availableStations = [];
  pnpStations       = [];
  loaderPresent     = false;

  selectedPort = port;
  setStatus('idle', `Port ${port} selected — waiting for PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})`);

  try {
    modbusHandler = new ModbusHandler(port, {
      timeoutMs:    1000,
      retries:      2,
      retryDelayMs: 200,
    });

    const connected = await modbusHandler.connect();
    if (!connected) {
      selectedPort = null;
      setStatus('error', `Failed to open port ${port}`);
      return res.status(500).json({ error: `Failed to open serial port ${port}` });
    }

    log(`Serial port ${port} opened successfully`);
    await sleep(200);

    // Start watching for PCB Loader
    startLoaderWatch();

    res.json({ success: true, port });
  } catch (err) {
    selectedPort = null;
    setStatus('error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Disconnect / release port ─────────────────────────────────────────────────
app.post('/api/disconnect', (_req, res) => {
  stopLoaderWatch();

  if (stationManager) {
    stationManager._stopPolling();
    stationManager = null;
  }
  if (modbusHandler) {
    modbusHandler.disconnect();
    modbusHandler = null;
  }
  availableStations = [];
  pnpStations       = [];
  loaderPresent     = false;
  selectedPort      = null;

  setStatus('idle', 'Disconnected — waiting for port selection');
  broadcast('connectionState', {
    connected:         false,
    availableStations: [],
    pnpStations:       [],
  });

  res.json({ success: true });
});

// ── Legacy connect endpoint (kept for compatibility, maps to port select) ─────
app.post('/api/connect', async (req, res) => {
  req.url = '/api/port/select';
  // Forward to port/select handler
  const { port } = req.body;
  if (!port) return res.status(400).json({ error: 'port is required' });

  stopLoaderWatch();
  if (modbusHandler) { modbusHandler.disconnect(); modbusHandler = null; }
  stationManager = null; availableStations = []; pnpStations = []; loaderPresent = false;

  selectedPort = port;
  setStatus('idle', `Connecting to ${port} — waiting for PCB Loader`);

  try {
    modbusHandler = new ModbusHandler(port, { timeoutMs: 1000, retries: 2, retryDelayMs: 200 });
    const connected = await modbusHandler.connect();
    if (!connected) {
      selectedPort = null;
      setStatus('error', `Failed to open port ${port}`);
      return res.status(500).json({ error: `Failed to open serial port ${port}` });
    }
    await sleep(200);
    startLoaderWatch();
    res.json({ success: true, port });
  } catch (err) {
    selectedPort = null;
    setStatus('error', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Setup: read component distribution from stations ──────────────────────────
app.get('/api/setup/components', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const result = {};
    for (const sid of pnpStations) {
      const components = await modbusHandler.getComponentsToPlace(sid);
      result[sid] = components
        ? { transistors: components[0], diodes: components[1], ics: components[2], capacitors: components[3] }
        : { transistors: 0, diodes: 0, ics: 0, capacitors: 0 };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup: write total positions to a station ─────────────────────────────────
app.post('/api/setup/total-positions', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { slaveId, transistors, diodes, ics, capacitors } = req.body;
  try {
    const ok = await modbusHandler.setTotalPositions(slaveId, transistors, diodes, ics, capacitors);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup: activate / deactivate physical start button ────────────────────────
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

// ── Operation: stop production ────────────────────────────────────────────────
app.post('/api/operation/stop', async (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  try {
    await stationManager.stopProduction();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Operation: set total PCBs ─────────────────────────────────────────────────
app.post('/api/operation/set-total', (req, res) => {
  const { totalPcbs } = req.body;
  if (totalPcbs && totalPcbs > 0) pendingTotalPcbs = totalPcbs;
  res.json({ success: true, totalPcbs: pendingTotalPcbs });
});

// ── Operation: get snapshot ───────────────────────────────────────────────────
app.get('/api/operation/snapshot', (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  res.json(stationManager.getSnapshot());
});

// ── Configuration: read from first P&P station ───────────────────────────────
app.get('/api/configuration', async (_req, res) => {
  if (!modbusHandler || pnpStations.length === 0) {
    return res.status(400).json({ error: 'No P&P stations connected' });
  }
  const slaveId = pnpStations[0];
  try {
    const timing = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.TRANSISTOR_PLACEMENT_DURATION_MS, 5);
    const led    = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.BRIGHTNESS_RED_LED, 6);
    const rfid   = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.RFID_BOX_UID_START, 12);
    const vol    = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.SPEAKER_VOLUME, 1);

    res.json({
      timing: timing ? { transistor: timing[0], diode: timing[1], ic: timing[2], capacitor: timing[3], transport: timing[4] } : null,
      led:    led    ? { red: led[0], yellow: led[1], green: led[2], rgb: led[3], thresholdYellow: led[4], thresholdRed: led[5] } : null,
      rfid:   rfid   ? Array.from({ length: 4 }, (_, i) => ({ uidHigh: rfid[i*2], uidLow: rfid[i*2+1], count: rfid[8+i] })) : null,
      volume: vol    ? vol[0] : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Configuration: write to all stations ──────────────────────────────────────
app.post('/api/configuration', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { timing, led, rfid, volume } = req.body;
  try {
    for (const sid of availableStations) {
      if (timing) await modbusHandler.setTimingConfig(sid, timing.transistor, timing.diode, timing.ic, timing.capacitor, timing.transport);
      if (led)    await modbusHandler.setLedConfig(sid, led.red, led.yellow, led.green, led.rgb, led.thresholdYellow, led.thresholdRed);
      if (rfid) {
        const rfidValues = [];
        for (const box of rfid) rfidValues.push(box.uidHigh, box.uidLow);
        for (const box of rfid) rfidValues.push(box.count);
        await modbusHandler.writeHoldingRegisters(sid, HoldingRegisterAddresses.RFID_BOX_UID_START, rfidValues);
      }
      if (volume != null) await modbusHandler.setSpeakerVolume(sid, volume);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Configuration: soft reset all stations ────────────────────────────────────
app.post('/api/configuration/soft-reset', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    for (const sid of availableStations) {
      if (!(await modbusHandler.softReset(sid))) throw new Error(`Failed to reset Station ${sid}`);
    }
    await sleep(2000);

    const timeout = 10000;
    const start   = Date.now();
    let allReset  = false;

    while (!allReset && Date.now() - start < timeout) {
      allReset = true;
      for (const sid of availableStations) {
        if (!(await modbusHandler.checkSoftResetComplete(sid))) { allReset = false; break; }
      }
      if (!allReset) await sleep(200);
    }
    if (!allReset) throw new Error('Reset timeout — check station status manually');

    for (const sid of availableStations) {
      await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Monitoring: all station status ────────────────────────────────────────────
app.get('/api/monitoring', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const allStations = [loaderStationId, ...pnpStations];
    const result = {};
    for (const sid of allStations) {
      const statusData   = await modbusHandler.getAllStatus(sid);
      const inputCoils   = await modbusHandler.readCoils(sid, CoilAddresses.INPUT_TRANSISTOR_1_IS_POPULATED, 14);
      const outputInputs = await modbusHandler.readDiscreteInputs(sid, DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED, 14);
      result[sid] = { statusData, inputCoils, outputInputs };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── System status ─────────────────────────────────────────────────────────────
app.get('/api/system/status', (_req, res) => {
  res.json({
    systemStatus,
    statusMessage,
    selectedPort,
    loaderPresent,
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
    pendingTotalPcbs,
  });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`[Server] SMT Pick & Place Controller running at http://localhost:${PORT}`);
});