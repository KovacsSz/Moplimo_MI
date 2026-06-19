/**
 * Main application controller
 * Visualization-only — no manual connect/init button
 */

'use strict';

// ── Shared state ──────────────────────────────────────────────────────────────
const AppState = {
  connected:         false,
  availableStations: [],
  loaderStationId:   5,
  pnpStations:       [],
  systemStatus:      'idle',
  loaderPresent:     false,
};

// ── PlacementStatus (client mirror) ──────────────────────────────────────────
const PlacementStatus = {
  IDLE_WAITING_FOR_NEW_PCB:      0,
  LOADING_NEW_PCB:               1,
  LOADING_NEW_PCB_FINISHED:      2,
  COMPONENT_PLACEMENT_STARTED:   3,
  COMPONENT_PLACEMENT_FINISHED:  4,
  WAITING_TO_START_UNLOADING_PCB:5,
  UNLOADING_POPULATED_PCB:       6,
  UNLOADING_FINISHED:            7,
  ERROR:                         99,
  getName(code) {
    return Object.entries(this).find(([k, v]) => typeof v === 'number' && v === code)?.[0]
      ?? String(code);
  },
};

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect',    () => logMonitoring('Socket connected to server'));
socket.on('disconnect', () => logMonitoring('Socket disconnected from server'));

// Full system state update
socket.on('systemState', (data) => {
  AppState.connected         = data.connected;
  AppState.availableStations = data.availableStations ?? [];
  AppState.loaderStationId   = data.loaderStationId ?? 5;
  AppState.pnpStations       = data.pnpStations ?? [];
  AppState.systemStatus      = data.systemStatus ?? 'idle';
  AppState.loaderPresent     = data.loaderPresent ?? false;

  updateConnectionBadge(data.connected);
  updateLoaderBadge(data.loaderPresent);
  updateSystemStatusBadge(data.systemStatus);
  updateStatusBar(data.statusMessage ?? '');
  updateTabAccess(data.connected);

  if (data.connected && typeof SetupTab !== 'undefined') {
    SetupTab.onConnected();
  }
});

// Legacy connectionState (also sent by server)
socket.on('connectionState', (data) => {
  AppState.connected         = data.connected;
  AppState.availableStations = data.availableStations ?? [];
  AppState.pnpStations       = data.pnpStations ?? [];
  updateConnectionBadge(data.connected);
  updateTabAccess(data.connected);
  if (data.connected && typeof SetupTab !== 'undefined') SetupTab.onConnected();
});

// Initialization progress
socket.on('initProgress', (data) => {
  const wrap = document.getElementById('progressBarWrap');
  const bar  = document.getElementById('initProgress');
  const log  = document.getElementById('initLog');
  if (wrap) wrap.style.display = 'block';
  if (bar && data.pct != null) bar.value = data.pct;
  if (log && data.message) {
    log.textContent += data.message + '\n';
    log.scrollTop = log.scrollHeight;
  }
});

// PCB Loader detected/removed
socket.on('loaderDetected', () => {
  updateLoaderCard(true, 'Detected — initializing…', 'initializing');
  logMonitoring('PCB Loader detected');
  rebuildPnpCards([]);   // clear until init completes
});

socket.on('loaderRemoved', () => {
  updateLoaderCard(false, 'Not detected', 'absent');
  updateLoaderBadge(false);
  updateSystemStatusBadge('idle');
  logMonitoring('PCB Loader removed — stations in last mode');
  rebuildPnpCards([]);
});

// Production events → OperationTab
socket.on('productionStarted',  (d) => { if (typeof OperationTab !== 'undefined') OperationTab.onProductionStarted(d); });
socket.on('productionStopped',  ()  => { if (typeof OperationTab !== 'undefined') OperationTab.onProductionStopped(); });
socket.on('productionComplete', (d) => { if (typeof OperationTab !== 'undefined') OperationTab.onProductionComplete(d); });
socket.on('pcbCompleted',       (d) => { if (typeof OperationTab !== 'undefined') OperationTab.onPcbCompleted(d); });
socket.on('stateChange',        (d) => {
  if (typeof OperationTab !== 'undefined')  OperationTab.onStateChange(d);
  logMonitoring(`${d.stationName}: ${PlacementStatus.getName(d.oldStatus)} → ${d.statusName}`);
  updatePnpCardStatus(d.slaveId, d.statusName, d.newStatus);
});
socket.on('snapshot', (d) => {
  if (typeof OperationTab !== 'undefined') OperationTab.onSnapshot(d);
  updateCardsFromSnapshot(d);
});
socket.on('setupComplete', () => {
  if (typeof OperationTab !== 'undefined') OperationTab.onSetupComplete();
});
socket.on('returnedToSetup', () => {
  setTabEnabled('setup', true);
  setTabEnabled('operation', false);
  updateSystemStatusBadge('ready');
});
socket.on('buttonPressed', () => {
  logMonitoring('Physical start button pressed on PCB Loader');
  setTabEnabled('operation', true);
  switchTab('operation');
});

// ── Overview card helpers ─────────────────────────────────────────────────────

function updateLoaderCard(present, text, dotClass) {
  const dot  = document.getElementById('loaderDot');
  const txt  = document.getElementById('loaderStatusText');
  const card = document.getElementById('loaderCard');
  if (dot)  { dot.className = `indicator-dot ${dotClass}`; }
  if (txt)  { txt.textContent = text; }
}

function rebuildPnpCards(pnpIds) {
  const container = document.getElementById('pnpCards');
  if (!container) return;
  container.innerHTML = '';

  if (pnpIds.length === 0) {
    const ph = document.createElement('div');
    ph.className = 'card status-card placeholder-card';
    ph.innerHTML = '<p style="color:#999;text-align:center;margin-top:1rem">P&amp;P stations appear here after initialization</p>';
    container.appendChild(ph);
    return;
  }

  pnpIds.forEach((sid) => {
    const card = document.createElement('div');
    card.className = 'card status-card';
    card.id = `pnp-card-${sid}`;
    card.innerHTML = `
      <div class="status-card-header">
        <span class="station-label">P&amp;P Station ${sid}</span>
        <span class="station-id">Slave ID ${sid}</span>
      </div>
      <div class="status-indicator">
        <div class="indicator-dot ready" id="pnp-dot-${sid}"></div>
        <span id="pnp-status-${sid}">Ready</span>
      </div>
    `;
    container.appendChild(card);
  });
}

function updatePnpCardStatus(slaveId, statusName, statusCode) {
  const dot = document.getElementById(`pnp-dot-${slaveId}`);
  const txt = document.getElementById(`pnp-status-${slaveId}`);
  if (!dot || !txt) return;
  txt.textContent = statusName;

  let dotClass = 'ready';
  switch (statusCode) {
    case 0:  dotClass = 'ready';      break;
    case 3:
    case 4:  dotClass = 'production'; break;
    case 6:
    case 7:  dotClass = 'initializing'; break;
    case 99: dotClass = 'error';      break;
    default: dotClass = 'ready';
  }
  dot.className = `indicator-dot ${dotClass}`;
}

function updateCardsFromSnapshot(snapshot) {
  if (!snapshot || !snapshot.stationRows) return;
  snapshot.stationRows.forEach((row) => {
    if (row.slaveId === AppState.loaderStationId) {
      updateLoaderCard(true, row.statusName, row.status === 0 ? 'present' : 'production');
    } else {
      updatePnpCardStatus(row.slaveId, row.statusName, row.status);
    }
  });
}

// Called when pnpStations are confirmed after init
function onStationsInitialized() {
  updateLoaderCard(true, 'Online', 'present');
  updateLoaderBadge(true);
  updateSystemStatusBadge('ready');
  rebuildPnpCards(AppState.pnpStations);
}

// ── Badge / UI updates ────────────────────────────────────────────────────────

function updateConnectionBadge(connected) {
  const badge = document.getElementById('connectionBadge');
  if (!badge) return;
  badge.textContent = connected ? 'Connected' : 'Disconnected';
  badge.className   = `badge ${connected ? 'connected' : 'disconnected'}`;

  // When connected, rebuild P&P cards
  if (connected && AppState.pnpStations.length > 0) {
    onStationsInitialized();
  }
}

function updateLoaderBadge(present) {
  const badge = document.getElementById('loaderBadge');
  if (!badge) return;
  badge.textContent = `PCB Loader: ${present ? 'Present' : 'Absent'}`;
  badge.className   = `badge ${present ? 'loader-present' : 'loader-absent'}`;
}

function updateSystemStatusBadge(status) {
  const badge = document.getElementById('systemStatusBadge');
  if (!badge) return;
  const labels = {
    idle:         'Idle',
    initializing: 'Initializing…',
    ready:        'Ready',
    production:   'Production',
    error:        'Error',
  };
  badge.textContent = labels[status] ?? status;
  badge.className   = `badge status-${status}`;
}

function updateStatusBar(message) {
  const el = document.getElementById('statusBarText');
  if (el) el.textContent = message;
}

function updateTabAccess(connected) {
  ['setup', 'configuration', 'monitoring'].forEach((t) => setTabEnabled(t, connected));
  setTabEnabled('operation', false);
}

// ── Port selector ─────────────────────────────────────────────────────────────

async function refreshPorts() {
  const sel = document.getElementById('portSelect');
  const btn = document.getElementById('connectPortBtn');
  if (!sel) return;
  sel.innerHTML = '';
  try {
    const ports = await apiGet('/api/ports');
    if (ports.length === 0) {
      sel.innerHTML = '<option value="">No ports available</option>';
      if (btn) btn.disabled = true;
    } else {
      ports.forEach((p) => {
        const opt = document.createElement('option');
        opt.value       = p.path;
        opt.textContent = `${p.path} – ${p.friendlyName ?? p.manufacturer ?? ''}`;
        sel.appendChild(opt);
      });
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    console.error('Failed to fetch ports:', err.message);
  }
}

async function connectPort() {
  const sel = document.getElementById('portSelect');
  const port = sel?.value;
  if (!port) { alert('No port selected'); return; }

  const btn  = document.getElementById('connectPortBtn');
  const disc = document.getElementById('disconnectBtn');
  if (btn)  btn.disabled  = true;
  if (disc) disc.disabled = false;

  updateStatusBar(`Connecting to ${port}…`);

  // Clear init log
  const log = document.getElementById('initLog');
  if (log) log.textContent = '';
  const wrap = document.getElementById('progressBarWrap');
  if (wrap) wrap.style.display = 'none';

  try {
    const result = await apiPost('/api/connect', { port });
    if (result.error) throw new Error(result.error);
    updateStatusBar(`Port ${port} open — watching for PCB Loader (Slave ID 5)…`);
  } catch (err) {
    updateStatusBar(`Connection failed: ${err.message}`);
    if (btn)  btn.disabled  = false;
    if (disc) disc.disabled = true;
  }
}

async function disconnectPort() {
  await apiPost('/api/disconnect', {});
  const btn  = document.getElementById('connectPortBtn');
  const disc = document.getElementById('disconnectBtn');
  if (btn)  btn.disabled  = false;
  if (disc) disc.disabled = true;
  updateConnectionBadge(false);
  updateLoaderBadge(false);
  updateSystemStatusBadge('idle');
  updateStatusBar('Disconnected');
  updateTabAccess(false);
  switchTab('overview');
  updateLoaderCard(false, 'Not detected', 'absent');
  rebuildPnpCards([]);
  const wrap = document.getElementById('progressBarWrap');
  if (wrap) wrap.style.display = 'none';
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b)  => b.classList.remove('active'));
  const panel = document.getElementById(`tab-${tabName}`);
  const btn   = document.querySelector(`[data-tab="${tabName}"]`);
  if (panel) panel.classList.add('active');
  if (btn)   btn.classList.add('active');

  if (tabName === 'monitoring' && AppState.connected) {
    if (typeof MonitoringTab !== 'undefined') MonitoringTab.startPolling();
  } else {
    if (typeof MonitoringTab !== 'undefined') MonitoringTab.stopPolling();
  }
}

function setTabEnabled(tabName, enabled) {
  const btn = document.querySelector(`[data-tab="${tabName}"]`);
  if (btn) btn.disabled = !enabled;
}

// ── Monitoring event log helper ───────────────────────────────────────────────

function logMonitoring(message) {
  if (typeof MonitoringTab !== 'undefined') MonitoringTab.logEvent(message);
}

// ── LED slider ────────────────────────────────────────────────────────────────

function updateLedLabel(key, value) {
  const el = document.getElementById(`led-${key}-val`);
  if (el) el.textContent = value;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiPost(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(url) {
  const res = await fetch(url);
  return res.json();
}

// ── DOM Ready ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => { if (!btn.disabled) switchTab(btn.dataset.tab); });
  });

  // Port controls
  document.getElementById('refreshPortsBtn')?.addEventListener('click', refreshPorts);
  document.getElementById('connectPortBtn')?.addEventListener('click', connectPort);
  document.getElementById('disconnectBtn')?.addEventListener('click', disconnectPort);

  // Operation tab
  document.getElementById('stopProductionBtn')?.addEventListener('click', async () => {
    if (!confirm('Stop production?')) return;
    await apiPost('/api/operation/stop', {});
  });

  document.getElementById('setPcbsBtn')?.addEventListener('click', async () => {
    const val = parseInt(document.getElementById('totalPcbsInput')?.value ?? '10');
    if (val > 0) {
      await apiPost('/api/operation/set-total', { totalPcbs: val });
    }
  });

  // Configuration tab
  document.getElementById('readConfigBtn')?.addEventListener('click',  readConfiguration);
  document.getElementById('writeConfigBtn')?.addEventListener('click', writeConfiguration);
  document.getElementById('softResetBtn')?.addEventListener('click',   softResetAll);

  // Build RFID table rows
  const rfidBody = document.getElementById('rfidTableBody');
  if (rfidBody) {
    for (let i = 0; i < 4; i++) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>Box ${i + 1}</td>
        <td><input type="text"   id="rfid-uid-high-${i}" placeholder="0x00000000" style="width:120px" /></td>
        <td><input type="text"   id="rfid-uid-low-${i}"  placeholder="0x00000000" style="width:120px" /></td>
        <td><input type="number" id="rfid-count-${i}" min="0" max="65535" value="0" style="width:80px" /></td>
      `;
      rfidBody.appendChild(tr);
    }
  }

  // Initial port list
  refreshPorts();
});

// ── Configuration functions ───────────────────────────────────────────────────

async function readConfiguration() {
  if (!AppState.connected) { alert('Not connected to any stations'); return; }
  try {
    const cfg = await apiGet('/api/configuration');
    if (cfg.timing) {
      setVal('timing-transistor', cfg.timing.transistor);
      setVal('timing-diode',      cfg.timing.diode);
      setVal('timing-ic',         cfg.timing.ic);
      setVal('timing-capacitor',  cfg.timing.capacitor);
      setVal('timing-transport',  cfg.timing.transport);
    }
    if (cfg.led) {
      setRng('led-red',    cfg.led.red,    'led-red-val');
      setRng('led-yellow', cfg.led.yellow, 'led-yellow-val');
      setRng('led-green',  cfg.led.green,  'led-green-val');
      setRng('led-rgb',    cfg.led.rgb,    'led-rgb-val');
      setVal('thresh-yellow', cfg.led.thresholdYellow);
      setVal('thresh-red',    cfg.led.thresholdRed);
    }
    if (cfg.rfid) {
      cfg.rfid.forEach((box, i) => {
        setVal(`rfid-uid-high-${i}`, `0x${box.uidHigh.toString(16).toUpperCase().padStart(8,'0')}`);
        setVal(`rfid-uid-low-${i}`,  `0x${box.uidLow.toString(16).toUpperCase().padStart(8,'0')}`);
        setVal(`rfid-count-${i}`,    box.count);
      });
    }
    if (cfg.volume != null) setRng('audio-volume', cfg.volume, 'audio-vol-val');
    alert('Configuration read from stations');
  } catch (err) { alert(`Read failed: ${err.message}`); }
}

async function writeConfiguration() {
  if (!AppState.connected) { alert('Not connected'); return; }
  if (!confirm('Write configuration to all stations?')) return;
  const rfid = Array.from({ length: 4 }, (_, i) => ({
    uidHigh: parseInt(document.getElementById(`rfid-uid-high-${i}`)?.value ?? '0', 16) || 0,
    uidLow:  parseInt(document.getElementById(`rfid-uid-low-${i}`)?.value  ?? '0', 16) || 0,
    count:   parseInt(document.getElementById(`rfid-count-${i}`)?.value    ?? '0') || 0,
  }));
  const body = {
    timing: {
      transistor: getNum('timing-transistor'), diode:    getNum('timing-diode'),
      ic:         getNum('timing-ic'),         capacitor:getNum('timing-capacitor'),
      transport:  getNum('timing-transport'),
    },
    led: {
      red: getNum('led-red'), yellow: getNum('led-yellow'), green: getNum('led-green'),
      rgb: getNum('led-rgb'), thresholdYellow: getNum('thresh-yellow'), thresholdRed: getNum('thresh-red'),
    },
    rfid,
    volume: getNum('audio-volume'),
  };
  try {
    const res = await apiPost('/api/configuration', body);
    if (res.error) throw new Error(res.error);
    alert('Configuration written to all stations');
  } catch (err) { alert(`Write failed: ${err.message}`); }
}

async function softResetAll() {
  if (!AppState.connected) { alert('Not connected'); return; }
  if (!confirm('Soft reset ALL stations? Any PCBs being processed may be lost.')) return;
  try {
    const res = await apiPost('/api/configuration/soft-reset', {});
    if (res.error) throw new Error(res.error);
    alert('All stations reset successfully');
  } catch (err) { alert(`Reset failed: ${err.message}`); }
}

function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function setRng(id, val, lblId) { setVal(id, val); setVal(lblId, val); }
function getNum(id) { return parseInt(document.getElementById(id)?.value ?? '0') || 0; }