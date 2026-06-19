/**
 * Setup Tab controller
 * Polls station component distribution and manages start-button state
 */

'use strict';

const SetupTab = (() => {
  const TOTAL = { transistors: 5, diodes: 4, ics: 3, capacitors: 2 };
  const KEYS  = ['transistors', 'diodes', 'ics', 'capacitors'];

  let pollTimer = null;
  let wasReady  = false;

  const availEl  = (key) => document.getElementById(`avail-${key}`);
  const distBody = ()    => document.querySelector('#distributionTable tbody');

  function onConnected() {
    buildDistributionTable();
    startPolling();
  }

  function buildDistributionTable() {
    const tbody = distBody();
    if (!tbody) return;
    tbody.innerHTML = '';
    AppState.pnpStations.forEach((sid) => {
      const tr = document.createElement('tr');
      tr.id = `dist-row-${sid}`;
      tr.innerHTML = `<td>P&amp;P Station ${sid}</td>` +
        KEYS.map((k) => `<td id="dist-${sid}-${k}">0</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 500);
    poll();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    if (!AppState.connected || AppState.pnpStations.length === 0) return;
    try {
      const data = await apiGet('/api/setup/components');
      updateUI(data);
    } catch { /* ignore */ }
  }

  function updateUI(data) {
    const allPlaced = AppState.pnpStations.map((sid) => data[sid] ?? {});

    const totalAssigned = KEYS.map((k) =>
      allPlaced.reduce((s, p) => s + (p[k] ?? 0), 0)
    );

    // Distribution table
    AppState.pnpStations.forEach((sid, idx) => {
      const placed = allPlaced[idx];
      KEYS.forEach((k) => {
        const cell = document.getElementById(`dist-${sid}-${k}`);
        if (cell) cell.textContent = placed[k] ?? 0;
      });
    });

    // Available counts
    const available = {};
    KEYS.forEach((k, i) => { available[k] = TOTAL[k] - totalAssigned[i]; });

    KEYS.forEach((k) => {
      const el = availEl(k);
      if (!el) return;
      el.textContent = available[k];
      el.className   = 'avail-count' +
        (available[k] < 0 ? ' negative' : available[k] === 0 ? ' zero' : '');
    });

    // Write total positions back to stations
    AppState.pnpStations.forEach((sid, idx) => {
      const otherSum   = KEYS.map((k, ki) => totalAssigned[ki] - (allPlaced[idx][k] ?? 0));
      const stationTotal = KEYS.map((k, ki) => Math.max(0, TOTAL[k] - otherSum[ki]));
      apiPost('/api/setup/total-positions', {
        slaveId:     sid,
        transistors: stationTotal[0],
        diodes:      stationTotal[1],
        ics:         stationTotal[2],
        capacitors:  stationTotal[3],
      }).catch(() => {});
    });

    // Ready check
    const allZero   = KEYS.every((k) => available[k] === 0);
    const allNonNeg = KEYS.every((k) => available[k] >= 0);
    const ready     = allZero && allNonNeg;

    if (ready && !wasReady) {
      setTabEnabled('operation', true);
      apiPost('/api/setup/start-button', { active: true }).catch(() => {});
      if (typeof OperationTab !== 'undefined') OperationTab.onSetupComplete();
      wasReady = true;
    } else if (!ready && wasReady) {
      setTabEnabled('operation', false);
      apiPost('/api/setup/start-button', { active: false }).catch(() => {});
      wasReady = false;
    } else {
      apiPost('/api/setup/start-button', { active: ready }).catch(() => {});
    }
  }

  return { onConnected, startPolling, stopPolling };
})();