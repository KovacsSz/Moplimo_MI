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

  function onProductionStarted({ totalPcbs: t }) {
    totalPcbs = t; pcbsCompleted = 0;
    productionActive = true; startTime = Date.now();
    if (totalInput()) totalInput().disabled = true;
    if (stopBtn())    stopBtn().disabled    = false;
    if (progressLabel()) progressLabel().textContent = `0 / ${t} PCBs completed`;
    if (progressBar())   progressBar().value = 0;
    startStatsTimer();
  }

  function onProductionStopped()  { _deactivate(); }

  function onProductionComplete({ totalPcbs: t, totalTime, throughputPerMin }) {
    _deactivate();
    alert(
      `All ${t} PCBs completed!\n` +
      `Total time: ${totalTime.toFixed(1)} s\n` +
      `Throughput: ${throughputPerMin.toFixed(2)} PCB/min`
    );
  }

  function onPcbCompleted({ pcbsCompleted: c, totalPcbs: t }) {
    pcbsCompleted = c;
    updateProgress(c, t);
  }

  function onStateChange({ slaveId, statusName }) {
    setText(`op-status-${slaveId}`, statusName ?? '—');
  }

  function onSnapshot(snapshot) {
    if (!snapshot) return;
    snapshot.stationRows?.forEach((row) => {
      setText(`op-status-${row.slaveId}`, row.statusName ?? '—');
      setText(`op-pcb-${row.slaveId}`,    row.pcbId > 0 ? row.pcbId : '—');
      setText(`op-cycle-${row.slaveId}`,  row.cycleTime    != null ? row.cycleTime.toFixed(1)    : '—');
      setText(`op-avg-${row.slaveId}`,    row.avgCycleTime != null ? row.avgCycleTime.toFixed(1) : '—');
    });
    if (snapshot.productionActive) {
      pcbsCompleted = snapshot.pcbsCompleted;
      updateProgress(snapshot.pcbsCompleted, snapshot.totalPcbs);
    }
  }

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
      setText('stat-totalTime',
        `${pad(h)}:${pad(m)}:${pad(s)}`);
      setText('stat-throughput',
        `${(elapsed > 0 ? (pcbsCompleted / elapsed) * 60 : 0).toFixed(2)} PCB/min`);
    }, 1000);
  }

  function _deactivate() {
    productionActive = false;
    if (totalInput()) totalInput().disabled = false;
    if (stopBtn())    stopBtn().disabled    = true;
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  function updateProgress(completed, total) {
    if (progressBar())
      progressBar().value = total > 0 ? Math.round((completed / total) * 100) : 0;
    if (progressLabel())
      progressLabel().textContent = `${completed} / ${total} PCBs completed`;
  }

  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
  function pad(n) { return String(n).padStart(2, '0'); }

  return {
    onSetupComplete, onProductionStarted, onProductionStopped,
    onProductionComplete, onPcbCompleted, onStateChange, onSnapshot,
  };
})();