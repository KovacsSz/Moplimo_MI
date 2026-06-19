/**
 * Main application controller — visualization only
 * No connect/disconnect controls in the GUI.
 * Server auto-connects; PCB Loader watch handles everything.
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
  serialPort:        '—',
};

// ── PlacementStatus mirror ────────────────────────────────────────────────────
const PlacementStatus = {
  IDLE_WAITING_FOR_NEW_PCB:       0,
  LOADING_NEW_PCB:                1,
  LOADING_NEW_PCB_FINISHED:       2,
  COMPONENT_PLACEMENT_STARTED:    3,
  COMPONENT_PLACEMENT_FINISHED:   4,
  WAITING_TO_START_UNLOADING_PCB: 5,
  UNLOADING_POPULATED_PCB:        6,
  UNLOADING_FINISHED:             7,
  ERROR:                          99,
  getName(code) {
    return (
      Object.entries(this).find(
        ([k, v]) => typeof v === 'number' && v === code
      )?.[0] ?? `Unknown(${code})`
    );
  },
};

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  console.log('[Socket] Connected');
  appendMonitorLog('Connected to server');
});
socket.on('disconnect', () => {
  console.log('[Socket] Disconnected');
  appendMonitorLog('Disconnected from server');
});

// Full system state
socket.on('systemState', (data) => {
  AppState.connected         = data.connected;
  AppState.availableStations = data.availableStations ?? [];
  AppState.loaderStationId   = data.loaderStationId   ?? 5;
  AppState.pnpStations       = data.pnpStations        ?? [];
  AppState.systemStatus      = data.systemStatus       ?? 'idle';
  AppState.loaderPresent     = data.loaderPresent      ?? false;
  AppState.serialPort        = data.serialPort         ?? '—';

  applySystemState(data);
});

// Legacy connectionState
socket.on('connectionState', (data) => {
  AppState.connected         = data.connected;
  AppState.availableStations = data.availableStations ?? [];
  AppState.pnpStations       = data.pnpStations        ?? [];

  updateConnectionBadge(data.connected);
  updateTabAccess(data.connected);
  updateSysInfoTable();

  if (data.connected) {
    buildPnpCards(AppState.pnpStations);
    setLoaderCard(true, 'Online', 'present');
    if (typeof SetupTab !== 'undefined') SetupTab.onConnected();
  }
});

// Initialization progress
socket.on('initProgress', (data) => {
  const wrap = document.getElementById('progressBarWrap');
  const bar  = document.getElementById('initProgress');
  const log  = document.getElementById('initLog');
  if (wrap) wrap.style.display = 'block';
  if (bar  && data.pct != null) bar.value = data.pct;
  if (log  && data.message)     { log.textContent += data.message + '\n'; log.scrollTop = log.scrollHeight; }
});

// PCB Loader detected
socket.on('loaderDetected', () => {
  AppState.loaderPresent = true;
  setLoaderCard(false, 'Initializing…', 'initializing');
  updateLoaderBadge(true);
  appendMonitorLog('PCB Loader detected — starting initialization');
  buildPnpCards([]);   // clear until init completes
  const log = document.getElementById('initLog');
  if (log) log.textContent = '';
  const wrap = document.getElementById('progressBarWrap');
  if (wrap) { wrap.style.display = 'block'; }
  const bar = document.getElementById('initProgress');
  if (bar) bar.value = 0;
});

// PCB Loader removed
socket.on('loaderRemoved', () => {
  AppState.loaderPresent     = false;
  AppState.connected         = false;
  AppState.availableStations = [];
  AppState.pnpStations       = [];

  setLoaderCard(false, 'Removed', 'absent');
  updateLoaderBadge(false);
  updateConnectionBadge(false);
  updateSystemStatusBadge('idle');
  updateStatusBar('PCB Loader disconnected — waiting for reconnection…');
  updateTabAccess(false);
  buildPnpCards([]);
  updateSysInfoTable();
  appendMonitorLog('PCB Loader removed — stations set to last mode');
});

// Production events
socket.on('productionStarted',  (d) => { if (typeof OperationTab !== 'undefined') OperationTab.onProductionStarted(d); });
socket.on('productionStopped',  ()  => { if (typeof OperationTab !== 'undefined') OperationTab.onProductionStopped(); });
socket.on('productionComplete', (d) => { if (typeof OperationTab !== 'undefined') OperationTab.onProductionComplete(d); });
socket.on('pcbCompleted',       (d) => { if (typeof OperationTab !== 'undefined') OperationTab.onPcbCompleted(d); });

socket.on('stateChange', (d) => {
  if (typeof OperationTab !== 'undefined') OperationTab.onStateChange(d);
  appendMonitorLog(`${d.stationName}: ${PlacementStatus.getName(d.oldStatus)} → ${d.statusName}`);
  setPnpCardState(d.slaveId, d.statusName, d.newStatus);
});

socket.on('snapshot', (d) => {
  if (typeof OperationTab !== 'undefined') OperationTab.onSnapshot(d);
  if (d && d.stationRows) {
    d.stationRows.forEach((row) => {
      if (row.slaveId === AppState.loaderStationId) {
        const dotClass = row.status === 0 ? 'idle' : 'production';
        setLoaderCard(true, row.statusName, dotClass);
      } else {
        setPnpCardState(row.slaveId, row.statusName, row.status);
      }
    });
  }
});

socket.on('setupComplete',    () => { if (typeof OperationTab !== 'undefined') OperationTab.onSetupComplete(); });
socket.on('returnedToSetup',  () => {
  setTabEnabled('setup', true);
  setTabEnabled('operation', false);
  updateSystemStatusBadge('ready');
});
socket.on('buttonPressed', () => {
  appendMonitorLog('Physical start button pressed — production starting in 1 s');
  setTabEnabled('operation', true);
  switchTab('operation');
});

// ── Apply full system state ───────────────────────────────────────────────────

function applySystemState(data) {
  updateConnectionBadge(data.connected);
  updateLoaderBadge(data.loaderPresent);
  updateSystemStatusBadge(data.systemStatus);
  updateStatusBar(data.statusMessage ?? '');
  updateTabAccess(data.connected);
  updateSysInfoTable();

  if (data.connected && data.pnpStations?.length > 0) {
    buildPnpCards(data.pnpStations);
    setLoaderCard(true, 'Online', 'present');
    if (typeof SetupTab !== 'undefined') SetupTab.onConnected();
  } else if (!data.loaderPresent) {
    setLoaderCard(false, 'Waiting…', 'absent');
    buildPnpCards([]);
  } else if (data.systemStatus === 'initializing') {
    setLoaderCard(false, 'Initializing…', 'initializing');
  }
}

// ── System info table ─────────────────────────────────────────────────────────

function updateSysInfoTable() {
  setText('si-port',   AppState.serialPort || '—');
  setText('si-bus',    AppState.connected ? 'Connected' : 'Disconnected');
  setText('si-loader', AppState.loaderPresent ? `Online (Slave ID ${AppState.loaderStationId})` : 'Absent');
  setText('si-pnp',
    AppState.pnpStations.length > 0
      ? `${AppState.pnpStations.length} station(s): [${AppState.pnpStations.join(', ')}]`
      : 'None detected'
  );
  setText('si-state', AppState.systemStatus.charAt(0).toUpperCase() + AppState.systemStatus.slice(1));
}

// ── Station card management ───────────────────────────────────────────────────

function setLoaderCard(present, text, dotClass) {
  const dot  = document.getElementById('dot-loader');
  const txt  = document.getElementById('text-loader');
  const card = document.getElementById('card-loader');
  if (dot)  dot.className  = `indicator-dot ${dotClass}`;
  if (txt)  txt.textContent = text;
  if (card) {
    card.className = 'station-card ' + (
      dotClass === 'absent'       ? 'state-absent'     :
      dotClass === 'initializing' ? 'state-init'       :
      dotClass === 'production'   ? 'state-production' :
      dotClass === 'error'        ? 'state-error'      :
                                    'state-ready'
    );
  }
}

function buildPnpCards(pnpIds) {
  const area = document.getElementById('pnpCardArea');
  if (!area) return;
  area.innerHTML = '';

  if (pnpIds.length === 0) {
    const ph = document.createElement('div');
    ph.className = 'station-card placeholder-card';
    ph.id        = 'pnpPlaceholder';
    ph.innerHTML = `
      <div class="station-card-body" style="text-align:center;color:#999;padding:1.5rem .5rem">
        P&amp;P stations appear<br>after initialization
      </div>`;
    area.appendChild(ph);
    return;
  }

  pnpIds.forEach((sid) => {
    const card = document.createElement('div');
    card.className = 'station-card state-ready';
    card.id        = `card-pnp-${sid}`;
    card.innerHTML = `
      <div class="station-card-header">
        <span class="station-card-title">P&amp;P Station ${sid}</span>
        <span class="station-card-id">Slave ID ${sid}</span>
      </div>
      <div class="station-card-body">
        <div class="station-indicator">
          <div class="indicator-dot ready" id="dot-pnp-${sid}"></div>
          <span id="text-pnp-${sid}" class="indicator-label">Ready</span>
        </div>
      </div>`;
    area.appendChild(card);
  });
}

function setPnpCardState(slaveId, statusName, statusCode) {
  const dot  = document.getElementById(`dot-pnp-${slaveId}`);
  const txt  = document.getElementById(`text-pnp-${slaveId}`);
  const card = document.getElementById(`card-pnp-${slaveId}`);
  if (!dot || !txt) return;

  txt.textContent = statusName;

  let dotClass   = 'idle';
  let cardClass  = 'state-ready';

  switch (statusCode) {
    case 0:  dotClass = 'idle';       cardClass = 'state-ready';      break;
    case 3:
    case 4:  dotClass = 'production'; cardClass = 'state-production'; break;
    case 1:
    case 2:
    case 6:
    case 7:  dotClass = 'initializing'; cardClass = 'state-init';    break;
    case 5:  dotClass = 'production';   cardClass = 'state-production'; break;
    case 99: dotClass = 'error';        cardClass = 'state-error';    break;
  }

  dot.className  = `indicator-dot ${dotClass}`;
  if (card) card.className = `station-card ${cardClass}`;
}

// ── Badge / UI helpers ────────────────────────────────────────────────────────

function updateConnectionBadge(connected) {
  const el = document.getElementById('connectionBadge');
  if (!el) return;
  el.textContent = connected ? 'Connected' : 'Disconnected';
  el.className   = `badge ${connected ? 'connected' : 'disconnected'}`;
}

function updateLoaderBadge(present) {
  const el = document.getElementById('loaderBadge');
  if (!el) return;
  el.textContent = present ? 'Present' : 'Absent';
  el.className   = `badge ${present ? 'loader-present' : 'loader-absent'}`;
}

function updateSystemStatusBadge(status) {
  const el = document.getElementById('systemStatusBadge');
  if (!el) return;
  const label = {
    connecting:   'Connecting…',
    idle:         'Idle',
    initializing: 'Initializing',
    ready:        'Ready',
    production:   'Production',
    error:        'Error',
  };
  el.textContent = label[status] ?? status;
  el.className   = `badge status-${status}`;
}

function updateStatusBar(msg) {
  const el = document.getElementById('statusBarText');
  if (el) el.textContent = msg;
}

function updateTabAccess(connected) {
  ['setup', 'configuration', 'monitoring'].forEach((t) => setTabEnabled(t, connected));
  if (!connected) setTabEnabled('operation', false);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b)  => b.classList.remove('active'));
  const panel = document.getElementById(`tab-${name}`);
  const btn   = document.querySelector(`[data-tab="${name}"]`);
  if (panel) panel.classList.add('active');
  if (btn)   btn.classList.add('active');

  if (name === 'monitoring' && AppState.connected) {
    if (typeof MonitoringTab !== 'undefined') MonitoringTab.startPolling();
  } else {
    if (typeof MonitoringTab !== 'undefined') MonitoringTab.stopPolling();
  }
}

function setTabEnabled(name, enabled) {
  const btn = document.querySelector(`[data-tab="${name}"]`);
  if (btn) btn.disabled = !enabled;
}

// ── LED slider label ──────────────────────────────────────────────────────────

function updateLedLabel(key, value) {
  const el = document.getElementById(`led-${key}-val`);
  if (el) el.textContent = value;
}

// ── Monitoring log ────────────────────────────────────────────────────────────

function appendMonitorLog(message) {
  if (typeof MonitoringTab !== 'undefined') MonitoringTab.logEvent(message);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
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
    btn.addEventListener('click', () => {
      if (!btn.disabled) switchTab(btn.dataset.tab);
    });
  });

  // Operation tab buttons
  document.getElementById('stopProductionBtn')?.addEventListener('click', async () => {
    if (!confirm('Stop production?')) return;
    const res = await apiPost('/api/operation/stop', {});
    if (res.error) alert(`Error: ${res.error}`);
  });

  document.getElementById('setPcbsBtn')?.addEventListener('click', async () => {
    const val = parseInt(document.getElementById('totalPcbsInput')?.value ?? '10');
    if (val > 0) await apiPost('/api/operation/set-total', { totalPcbs: val });
  });

  // Configuration tab buttons
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
});

// ── Configuration helpers ─────────────────────────────────────────────────────

async function readConfiguration() {
  if (!AppState.connected) { alert('No stations connected'); return; }
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
        setVal(`rfid-uid-high-${i}`,
          `0x${box.uidHigh.toString(16).toUpperCase().padStart(8, '0')}`);
        setVal(`rfid-uid-low-${i}`,
          `0x${box.uidLow.toString(16).toUpperCase().padStart(8, '0')}`);
        setVal(`rfid-count-${i}`, box.count);
      });
    }
    if (cfg.volume != null) setRng('audio-volume', cfg.volume, 'audio-vol-val');
    alert('Configuration read from stations');
  } catch (err) {
    alert(`Read failed: ${err.message}`);
  }
}

async function writeConfiguration() {
  if (!AppState.connected) { alert('No stations connected'); return; }
  if (!confirm('Write configuration to all stations?')) return;
  const rfid = Array.from({ length: 4 }, (_, i) => ({
    uidHigh: parseInt(document.getElementById(`rfid-uid-high-${i}`)?.value ?? '0', 16) || 0,
    uidLow:  parseInt(document.getElementById(`rfid-uid-low-${i}`)?.value  ?? '0', 16) || 0,
    count:   parseInt(document.getElementById(`rfid-count-${i}`)?.value    ?? '0') || 0,
  }));
  const body = {
    timing: {
      transistor: getNum('timing-transistor'), diode:     getNum('timing-diode'),
      ic:         getNum('timing-ic'),         capacitor: getNum('timing-capacitor'),
      transport:  getNum('timing-transport'),
    },
    led: {
      red:             getNum('led-red'),    yellow: getNum('led-yellow'),
      green:           getNum('led-green'),  rgb:    getNum('led-rgb'),
      thresholdYellow: getNum('thresh-yellow'),
      thresholdRed:    getNum('thresh-red'),
    },
    rfid,
    volume: getNum('audio-volume'),
  };
  try {
    const res = await apiPost('/api/configuration', body);
    if (res.error) throw new Error(res.error);
    alert('Configuration written to all stations');
  } catch (err) {
    alert(`Write failed: ${err.message}`);
  }
}

async function softResetAll() {
  if (!AppState.connected) { alert('No stations connected'); return; }
  if (!confirm('Soft reset ALL stations?\nAny PCBs being processed may be lost.')) return;
  try {
    const res = await apiPost('/api/configuration/soft-reset', {});
    if (res.error) throw new Error(res.error);
    alert('All stations reset successfully');
  } catch (err) {
    alert(`Reset failed: ${err.message}`);
  }
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}
function setRng(id, val, lblId) {
  setVal(id, val);
  const lbl = document.getElementById(lblId);
  if (lbl) lbl.textContent = val;
}
function getNum(id) {
  return parseInt(document.getElementById(id)?.value ?? '0') || 0;
}