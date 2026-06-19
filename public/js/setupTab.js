/**
 * Setup Tab controller
 *
 * Responsibilities:
 *  - Poll /api/setup/components every 500 ms
 *  - Show how many components are still available for distribution
 *  - When all available = 0  → activate start button + enable Operation tab
 *  - When distribution changes back → deactivate start button
 *  - onReturnedToSetup() → hard-reset display so next run can start cleanly
 */

'use strict';

const SetupTab = (() => {

  // Defaults must match DefaultComponentCounts in modbusDefinitions.js
  const DEFAULTS = { transistors: 5, diodes: 4, ics: 3, capacitors: 2 };
  const KEYS     = ['transistors', 'diodes', 'ics', 'capacitors'];

  let pollTimer = null;
  let wasReady  = false;   // true while start button is active

  // ── DOM helpers ────────────────────────────────────────────────────────────
  const availEl  = (key) => document.getElementById(`avail-${key}`);
  const distBody = ()    => document.querySelector('#distributionTable tbody');

  // ── onConnected ────────────────────────────────────────────────────────────
  // Called once when the system finishes initialization and stations are online.
  function onConnected() {
    wasReady = false;
    _resetDisplay();
    buildDistributionTable();
    startPolling();
  }

  // ── onReturnedToSetup ──────────────────────────────────────────────────────
  // Called after production completes OR is stopped.
  // Must reset EVERYTHING so the operator can start a new batch.
  function onReturnedToSetup() {
    console.log('[SetupTab] onReturnedToSetup — resetting for next batch');

    // 1. Stop the poll while we reset so no stale data races through
    stopPolling();

    // 2. Reset internal ready-flag
    wasReady = false;

    // 3. Reset the visual display to "nothing distributed yet"
    //    available = full defaults (5,4,3,2), distribution cells = 0
    _resetDisplay();

    // 4. Disable Operation tab — operator must redistribute first
    setTabEnabled('operation', false);

    // 5. Resume polling so operator can see live register values
    //    and the ready-check runs automatically
    startPolling();
  }

  // ── _resetDisplay ──────────────────────────────────────────────────────────
  // Hard-resets the available-components counters and distribution table
  // to the "nothing assigned" state.
  function _resetDisplay() {
    // Available = full defaults (nothing distributed)
    KEYS.forEach((k) => {
      const el = availEl(k);
      if (!el) return;
      el.textContent = DEFAULTS[k];
      el.className   = 'avail-count';   // remove 'zero' / 'negative'
    });

    // Distribution table cells → 0
    AppState.pnpStations.forEach((sid) => {
      KEYS.forEach((k) => {
        const cell = document.getElementById(`dist-${sid}-${k}`);
        if (cell) cell.textContent = '0';
      });
    });
  }

  // ── buildDistributionTable ─────────────────────────────────────────────────
  function buildDistributionTable() {
    const tbody = distBody();
    if (!tbody) return;
    tbody.innerHTML = '';
    AppState.pnpStations.forEach((sid) => {
      const tr = document.createElement('tr');
      tr.id = `dist-row-${sid}`;
      tr.innerHTML =
        `<td>P&amp;P Station ${sid}</td>` +
        KEYS.map((k) => `<td id="dist-${sid}-${k}">0</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  // ── Polling ────────────────────────────────────────────────────────────────
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 500);
    poll();   // immediate first call
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    if (!AppState.connected || AppState.pnpStations.length === 0) return;
    try {
      const data = await apiGet('/api/setup/components');
      _updateUI(data);
    } catch {
      /* ignore transient network / Modbus errors */
    }
  }

  // ── _updateUI ──────────────────────────────────────────────────────────────
  function _updateUI(data) {
    const allPlaced = AppState.pnpStations.map((sid) => data[sid] ?? {});

    // How many components have been assigned across all stations
    const totalAssigned = KEYS.map((k) =>
      allPlaced.reduce((sum, p) => sum + (p[k] ?? 0), 0)
    );

    // Update distribution table
    AppState.pnpStations.forEach((sid, idx) => {
      KEYS.forEach((k) => {
        const cell = document.getElementById(`dist-${sid}-${k}`);
        if (cell) cell.textContent = allPlaced[idx][k] ?? 0;
      });
    });

    // Available = defaults minus what has been assigned
    const available = {};
    KEYS.forEach((k, i) => {
      available[k] = DEFAULTS[k] - totalAssigned[i];
    });

    // Update available-count display
    KEYS.forEach((k) => {
      const el = availEl(k);
      if (!el) return;
      el.textContent = available[k];
      el.className   = 'avail-count' +
        (available[k] < 0 ? ' negative' : available[k] === 0 ? ' zero' : '');
    });

    // Push corrected total-positions back to each station's holding registers
    // so the station display stays in sync with the GUI.
    AppState.pnpStations.forEach((sid, idx) => {
      const otherAssigned = KEYS.map((k, ki) =>
        totalAssigned[ki] - (allPlaced[idx][k] ?? 0)
      );
      const stationTotal = KEYS.map((k, ki) =>
        Math.max(0, DEFAULTS[k] - otherAssigned[ki])
      );
      apiPost('/api/setup/total-positions', {
        slaveId:     sid,
        transistors: stationTotal[0],
        diodes:      stationTotal[1],
        ics:         stationTotal[2],
        capacitors:  stationTotal[3],
      }).catch(() => {});
    });

    // ── Ready check ──────────────────────────────────────────────────────────
    // Ready = every available value is exactly 0 (fully distributed, none over)
    const allZero   = KEYS.every((k) => available[k] === 0);
    const noneOver  = KEYS.every((k) => available[k] >= 0);
    const ready     = allZero && noneOver;

    if (ready && !wasReady) {
      // Transition: not-ready → ready
      wasReady = true;
      setTabEnabled('operation', true);
      apiPost('/api/setup/start-button', { active: true }).catch(() => {});
      if (typeof OperationTab !== 'undefined') OperationTab.onSetupComplete();
      console.log('[SetupTab] All components distributed — start button activated');

    } else if (!ready && wasReady) {
      // Transition: ready → not-ready (operator changed a value)
      wasReady = false;
      setTabEnabled('operation', false);
      apiPost('/api/setup/start-button', { active: false }).catch(() => {});
      console.log('[SetupTab] Distribution changed — start button deactivated');

    } else {
      // No transition — keep button in sync (handles page refresh / reconnect)
      apiPost('/api/setup/start-button', { active: ready }).catch(() => {});
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    onConnected,
    onReturnedToSetup,
    startPolling,
    stopPolling,
  };

})();