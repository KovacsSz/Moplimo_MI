/**
 * Monitoring Tab controller
 */

'use strict';

const MonitoringTab = (() => {
  let pollTimer = null;

  // ── DOM ───────────────────────────────────────────────────────────────────
  const compBody   = () => document.querySelector('#componentStatusTable tbody');
  const inputBody  = () => document.querySelector('#inputStatusTable tbody');
  const outputBody = () => document.querySelector('#outputStatusTable tbody');
  const eventLog   = () => document.getElementById('eventLog');

  // ── Start / stop polling ──────────────────────────────────────────────────
  function startPolling() {
    if (!AppState.connected) return;
    buildTables();
    stopPolling();
    pollTimer = setInterval(poll, 500);
    poll();
    logEvent('Monitoring started');
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function buildTables() {
    const allStations = [AppState.loaderStationId, ...AppState.pnpStations];

    [compBody(), inputBody(), outputBody()].forEach((tbody) => {
      tbody.innerHTML = '';
      allStations.forEach((sid) => {
        const name = sid === AppState.loaderStationId ? 'PCB Loader' : `P&P Station ${sid}`;
        const tr = document.createElement('tr');
        tr.id = `mon-${tbody.closest('table').id}-${sid}`;
        tr.innerHTML = `<td>${name}</td><td>-</td><td>-</td><td>-</td><td>-</td>`;
        tbody.appendChild(tr);
      });
    });
  }

  // ── Poll ──────────────────────────────────────────────────────────────────
  async function poll() {
    if (!AppState.connected) return;
    try {
      const data = await apiGet('/api/monitoring');
      const allStations = [AppState.loaderStationId, ...AppState.pnpStations];

      allStations.forEach((sid, idx) => {
        const entry = data[sid];
        if (!entry) return;

        // Component status table
        const sd = entry.statusData;
        if (sd) {
          const tp = sd.toPlace;
          const av = sd.available;
          setRowCells('componentStatusTable', sid, [
            `${tp.transistors}/${av.transistors}`,
            `${tp.diodes}/${av.diodes}`,
            `${tp.ics}/${av.ics}`,
            `${tp.capacitors}/${av.capacitors}`,
          ]);
        }

        // Input coils (14 booleans starting at index 0 of the slice)
        const ic = entry.inputCoils;
        if (ic) {
          setRowCells('inputStatusTable', sid, [
            boolBar(ic.slice(0, 5)),
            boolBar(ic.slice(5, 9)),
            boolBar(ic.slice(9, 12)),
            boolBar(ic.slice(12, 14)),
          ]);
        }

        // Output discrete inputs
        const oi = entry.outputInputs;
        if (oi) {
          setRowCells('outputStatusTable', sid, [
            boolBar(oi.slice(0, 5)),
            boolBar(oi.slice(5, 9)),
            boolBar(oi.slice(9, 12)),
            boolBar(oi.slice(12, 14)),
          ]);
        }
      });
    } catch { /* ignore */ }
  }

  // ── Event log ─────────────────────────────────────────────────────────────
  function logEvent(message) {
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((v) => String(v).padStart(2, '0'))
      .join(':');
    const box = eventLog();
    if (!box) return;
    box.textContent += `[${ts}] ${message}\n`;
    box.scrollTop = box.scrollHeight;
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function setRowCells(tableId, slaveId, cellValues) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const rows = table.querySelectorAll('tbody tr');
    const allStations = [AppState.loaderStationId, ...AppState.pnpStations];
    const idx = allStations.indexOf(slaveId);
    if (idx < 0 || !rows[idx]) return;
    const cells = rows[idx].querySelectorAll('td');
    cellValues.forEach((v, i) => { if (cells[i + 1]) cells[i + 1].textContent = v; });
  }

  function boolBar(arr) {
    return arr.map((v) => (v ? '✓' : '○')).join('');
  }

  return { startPolling, stopPolling, logEvent };
})();