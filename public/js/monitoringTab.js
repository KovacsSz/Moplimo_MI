/**
 * Monitoring Tab controller
 */

'use strict';

const MonitoringTab = (() => {
  let pollTimer = null;

  const compBody   = () => document.querySelector('#componentStatusTable tbody');
  const inputBody  = () => document.querySelector('#inputStatusTable tbody');
  const outputBody = () => document.querySelector('#outputStatusTable tbody');
  const eventLog   = () => document.getElementById('eventLog');

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
      if (!tbody) return;
      tbody.innerHTML = '';
      allStations.forEach((sid) => {
        const name = sid === AppState.loaderStationId ? 'PCB Loader' : `P&P Station ${sid}`;
        const tr   = document.createElement('tr');
        tr.innerHTML = `<td>${name}</td><td>—</td><td>—</td><td>—</td><td>—</td>`;
        tbody.appendChild(tr);
      });
    });
  }

  async function poll() {
    if (!AppState.connected) return;
    try {
      const data        = await apiGet('/api/monitoring');
      const allStations = [AppState.loaderStationId, ...AppState.pnpStations];

      allStations.forEach((sid, idx) => {
        const entry = data[sid];
        if (!entry) return;

        if (entry.statusData) {
          const { toPlace: tp, available: av } = entry.statusData;
          setRow('componentStatusTable', idx, [
            `${tp.transistors}/${av.transistors}`,
            `${tp.diodes}/${av.diodes}`,
            `${tp.ics}/${av.ics}`,
            `${tp.capacitors}/${av.capacitors}`,
          ]);
        }
        if (entry.inputCoils) {
          setRow('inputStatusTable', idx, [
            boolBar(entry.inputCoils.slice(0, 5)),
            boolBar(entry.inputCoils.slice(5, 9)),
            boolBar(entry.inputCoils.slice(9, 12)),
            boolBar(entry.inputCoils.slice(12, 14)),
          ]);
        }
        if (entry.outputInputs) {
          setRow('outputStatusTable', idx, [
            boolBar(entry.outputInputs.slice(0, 5)),
            boolBar(entry.outputInputs.slice(5, 9)),
            boolBar(entry.outputInputs.slice(9, 12)),
            boolBar(entry.outputInputs.slice(12, 14)),
          ]);
        }
      });
    } catch { /* ignore */ }
  }

  function logEvent(message) {
    const now = new Date();
    const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((v) => String(v).padStart(2, '0')).join(':');
    const box = eventLog();
    if (!box) return;
    box.textContent += `[${ts}] ${message}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function setRow(tableId, rowIdx, cells) {
    const tbody = document.querySelector(`#${tableId} tbody`);
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    if (!rows[rowIdx]) return;
    const tds = rows[rowIdx].querySelectorAll('td');
    cells.forEach((v, i) => { if (tds[i + 1]) tds[i + 1].textContent = v; });
  }

  function boolBar(arr) {
    return arr.map((v) => (v ? '✓' : '○')).join(' ');
  }

  return { startPolling, stopPolling, logEvent };
})();