/**
 * Connection Tab controller
 */

'use strict';

const ConnectionTab = (() => {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const portSelect      = () => document.getElementById('portSelect');
  const connectBtn      = () => document.getElementById('connectBtn');
  const disconnectBtn   = () => document.getElementById('disconnectBtn');
  const refreshBtn      = () => document.getElementById('refreshPortsBtn');
  const progressBarWrap = () => document.getElementById('progressBarWrap');
  const initProgress    = () => document.getElementById('initProgress');
  const initLog         = () => document.getElementById('initLog');

  // ── Initialise ────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    refreshBtn().addEventListener('click', refreshPorts);
    connectBtn().addEventListener('click', connectAndInitialize);
    disconnectBtn().addEventListener('click', disconnect);
    refreshPorts();
  });

  // ── Port list ─────────────────────────────────────────────────────────────
  async function refreshPorts() {
    const sel = portSelect();
    sel.innerHTML = '';
    try {
      const ports = await apiGet('/api/ports');
      if (ports.length === 0) {
        sel.innerHTML = '<option value="">No ports available</option>';
        connectBtn().disabled = true;
      } else {
        ports.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.path;
          opt.textContent = `${p.path} – ${p.friendlyName ?? p.manufacturer ?? ''}`;
          sel.appendChild(opt);
        });
        connectBtn().disabled = false;
      }
      log(`Found ${ports.length} serial port(s)`);
    } catch (err) {
      log(`Error fetching ports: ${err.message}`);
    }
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  async function connectAndInitialize() {
    const port = portSelect().value;
    if (!port) { alert('No serial port selected'); return; }

    connectBtn().disabled = true;
    progressBarWrap().style.display = 'block';
    initProgress().value = 0;
    initLog().textContent = '';

    try {
      const result = await apiPost('/api/connect', { port });
      if (result.error) throw new Error(result.error);

      disconnectBtn().disabled = false;
    } catch (err) {
      log(`\n✗ ERROR: ${err.message}`);
      progressBarWrap().style.display = 'none';
      connectBtn().disabled = false;
      alert(`Initialization Failed: ${err.message}`);
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  async function disconnect() {
    await apiPost('/api/disconnect', {});
    connectBtn().disabled = false;
    disconnectBtn().disabled = true;
    progressBarWrap().style.display = 'none';
    log('\nDisconnected from Modbus');
    updateConnectionBadge(false);
    updateTabAccess(false);
    switchTab('connection');
  }

  // ── Called by Socket.IO 'initProgress' event ──────────────────────────────
  function onProgress({ pct, message }) {
    if (pct != null) initProgress().value = pct;
    if (message)     log(message);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function log(msg) {
    const box = initLog();
    box.textContent += msg + '\n';
    box.scrollTop = box.scrollHeight;
  }

  return { onProgress, refreshPorts };
})();