/**
 * Operation Tab controller
 */

'use strict';

const OperationTab = (() => {
  let totalPcbs        = 0;
  let pcbsCompleted    = 0;
  let productionActive = false;
  let startTime        = null;
  let statsTimer       = null;

  const totalInput    = () => document.getElementById('totalPcbsInput');
  const stopBtn       = () => document.getElementById('stopProductionBtn');
  const progressLabel = () => document.getElementById('progressLabel');
  const progressBar   = () => document.getElementById('productionProgress');
  const tableBody     = () => document.querySelector('#stationStatusTable tbody');

  // ── Setup complete ──────────────────────────────────────────────────────────

  function onSetupComplete() {
    buildStatusTable();
  }

  function buildStatusTable() {
    const tbody = tableBody();
    if (!tbody) return;
    tbody.innerHTML = '';
    [AppState.loaderStationId, ...AppState.pnpStations].forEach((sid) => {
      const name = sid === AppState.loaderStationId ? 'Loader' : `P&P ${sid}`;
      const tr   = document.createElement('tr');
      tr.id = `op-row-${sid}`;
      tr.innerHTML = `
        <td>${name}</td>
        <td id="op-status-${sid}">—</td>
        <td id="op-pcb-${sid}">—</td>
        <td id="op-cycle-${sid}">—</td>
        <td id="op-avg-${sid}">—</td>`;
      tbody.appendChild(tr);
    });
  }

  // ── Production started ──────────────────────────────────────────────────────

  function onProductionStarted({ totalPcbs: t }) {
    totalPcbs        = t;
    pcbsCompleted    = 0;
    productionActive = true;
    startTime        = Date.now();
    if (totalInput()) totalInput().disabled = true;
    if (stopBtn())    stopBtn().disabled    = false;
    if (progressLabel()) progressLabel().textContent = `0 / ${t} PCBs completed`;
    if (progressBar())   progressBar().value = 0;
    startStatsTimer();
  }

  // ── Production stopped (manual) ─────────────────────────────────────────────

  function onProductionStopped() {
    _deactivate();
    // 'returnedToSetup' event follows automatically from server
  }

  // ── Production complete ─────────────────────────────────────────────────────
  //
  // Flow:
  //   1. Stop the UI counters  (stations are still in last hardware state)
  //   2. Show summary dialog   (blocking — operator must read it)
  //   3. On OK → call POST /api/operation/acknowledge-complete
  //      Server runs _returnToSetup():
  //        - coil 17 = false
  //        - holding reg 0 = 1 (Setup) on all stations
  //        - holding regs 2-3-4-5 = 5,4,3,2 on all stations
  //        - emits 'returnedToSetup'
  //   4. 'returnedToSetup' socket event → app.js switches to Setup tab

  function onProductionComplete({ totalPcbs: t, totalTime, throughputPerMin }) {
    // 1. Freeze UI counters — production is finished
    _deactivate();

    // Update progress bar to 100 %
    if (progressBar())   progressBar().value = 100;
    if (progressLabel()) progressLabel().textContent = `${t} / ${t} PCBs completed`;

    // 2. Show summary — alert() is synchronous, blocks until OK clicked
    alert(
      `✅  Production complete!\n\n` +
      `  PCBs produced : ${t}\n` +
      `  Total time    : ${totalTime.toFixed(1)} s\n` +
      `  Throughput    : ${throughputPerMin.toFixed(2)} PCB/min\n\n` +
      `Click OK to return all stations to Setup mode.`
    );

    // 3. Operator clicked OK — trigger hardware reset
    console.log('[OperationTab] Operator confirmed — sending acknowledge-complete');

    apiPost('/api/operation/acknowledge-complete', {})
      .then((res) => {
        if (res && res.error) {
          console.error('[OperationTab] acknowledge-complete error:', res.error);
          alert(`Warning: Failed to reset stations.\n${res.error}`);
        }
        // On success, server emits 'returnedToSetup' → app.js handles the rest
      })
      .catch((err) => {
        console.error('[OperationTab] acknowledge-complete fetch failed:', err.message);
        alert(`Warning: Could not contact server.\n${err.message}`);
      });
  }

  // ── PCB completed ───────────────────────────────────────────────────────────

  function onPcbCompleted({ pcbsCompleted: c, totalPcbs: t }) {
    pcbsCompleted = c;
    updateProgress(c, t);
  }

  // ── State change ────────────────────────────────────────────────────────────

  function onStateChange({ slaveId, statusName }) {
    setText(`op-status-${slaveId}`, statusName ?? '—');
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  function onSnapshot(snapshot) {
    if (!snapshot) return;
    snapshot.stationRows?.forEach((row) => {
      setText(`op-status-${row.slaveId}`, row.statusName ?? '—');
      setText(`op-pcb-${row.slaveId}`,    row.pcbId > 0 ? row.pcbId : '—');
      setText(`op-cycle-${row.slaveId}`,
        row.cycleTime    != null ? row.cycleTime.toFixed(1)    : '—');
      setText(`op-avg-${row.slaveId}`,
        row.avgCycleTime != null ? row.avgCycleTime.toFixed(1) : '—');
    });
    if (snapshot.productionActive) {
      pcbsCompleted = snapshot.pcbsCompleted;
      updateProgress(snapshot.pcbsCompleted, snapshot.totalPcbs);
    }
  }

  // ── Stats timer ─────────────────────────────────────────────────────────────

  function startStatsTimer() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (!productionActive) { clearInterval(statsTimer); return; }
      const elapsed = (Date.now() - startTime) / 1000;
      setText('stat-completed', String(pcbsCompleted));
      setText('stat-remaining', String(totalPcbs - pcbsCompleted));
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = Math.floor(elapsed % 60);
      setText('stat-totalTime', `${pad(h)}:${pad(m)}:${pad(s)}`);
      setText('stat-throughput',
        `${(elapsed > 0 ? (pcbsCompleted / elapsed) * 60 : 0).toFixed(2)} PCB/min`);
    }, 1000);
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  function _deactivate() {
    productionActive = false;
    if (totalInput()) totalInput().disabled = false;
    if (stopBtn())    stopBtn().disabled    = true;
    if (statsTimer)   { clearInterval(statsTimer); statsTimer = null; }
  }

  function updateProgress(completed, total) {
    if (progressBar())
      progressBar().value = total > 0 ? Math.round((completed / total) * 100) : 0;
    if (progressLabel())
      progressLabel().textContent = `${completed} / ${total} PCBs completed`;
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    onSetupComplete,
    onProductionStarted,
    onProductionStopped,
    onProductionComplete,
    onPcbCompleted,
    onStateChange,
    onSnapshot,
  };
})();