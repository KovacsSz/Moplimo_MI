/**
 * Station Manager
 * Manages production flow, station state tracking, and PCB lifecycle.
 */

'use strict';

const { PlacementStatus, PageID, PCB_LOADER_SLAVE_ID } = require('./modbusDefinitions');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class StationManager {
  /**
   * @param {import('./modbusHandler')} modbusHandler
   * @param {number}   loaderStationId
   * @param {number[]} pnpStations        sorted list of P&P slave IDs
   * @param {(event: object) => void} emitFn  callback to push events to clients
   */
  constructor(modbusHandler, loaderStationId, pnpStations, emitFn) {
    this.mh             = modbusHandler;
    this.loaderStationId = loaderStationId;
    this.pnpStations    = [...pnpStations].sort((a, b) => a - b);
    this.emit           = emitFn;

    // Station sequence: Loader first, then P&P in order
    this.stationSequence = [loaderStationId, ...this.pnpStations];

    // Production state
    this.productionActive    = false;
    this.totalPcbs           = 0;
    this.currentPcbId        = 0;
    this.pcbsCompleted       = 0;
    this.productionStartTime = null;

    // Station tracking
    this.stationStates    = {};  // slaveId -> PlacementStatus value
    this.pcbAtStation     = {};  // slaveId -> pcbId
    this.cycleStartTimes  = {};  // slaveId -> Date.now()
    this.cycleTimes       = {};  // slaveId -> number[]
    this.readFailures     = {};  // slaveId -> consecutive failure count
    this.pendingTrigger   = {};  // nextSlaveId -> { pcbId, srcSlaveId }

    // Button monitoring
    this.buttonMonitorActive = false;
    this.buttonWasPressed    = false;

    // ── Poll loop state ───────────────────────────────────────────────────
    // We use a self-rescheduling loop (setTimeout) instead of setInterval
    // so that a slow poll never overlaps the next one.
    this._pollRunning  = false;   // true while a poll iteration is executing
    this._pollScheduled = false;  // true while a setTimeout is pending
    this._pollIntervalMs = 100;
    this._pollTimeoutRef = null;

    // Guard: track whether setup has already been activated so repeated
    // POST /api/setup/start-button calls are harmless.
    this._setupActive = false;

    this._initTracking();
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────────────

  _initTracking() {
    for (const sid of this.stationSequence) {
      this.stationStates[sid]   = PlacementStatus.IDLE_WAITING_FOR_NEW_PCB;
      this.pcbAtStation[sid]    = 0;
      this.cycleTimes[sid]      = [];
      this.readFailures[sid]    = 0;
    }
  }

  getStationName(slaveId) {
    return slaveId === this.loaderStationId ? 'Loader' : `P&P ${slaveId}`;
  }

  // ─── POLL LOOP (self-rescheduling — never overlaps) ───────────────────────

  _startPolling(intervalMs = 100) {
    this._pollIntervalMs = intervalMs;
    this._stopPolling();           // cancel any previous loop
    this._scheduleNextPoll();
  }

  _stopPolling() {
    if (this._pollTimeoutRef) {
      clearTimeout(this._pollTimeoutRef);
      this._pollTimeoutRef  = null;
    }
    this._pollScheduled = false;
  }

  _scheduleNextPoll() {
    if (this._pollScheduled) return;   // already queued
    this._pollScheduled  = true;
    this._pollTimeoutRef = setTimeout(async () => {
      this._pollScheduled = false;
      this._pollTimeoutRef = null;

      if (!this._pollRunning) {
        this._pollRunning = true;
        try {
          await this._poll();
        } catch (err) {
          console.error('[Manager] Unhandled poll error:', err.message);
        } finally {
          this._pollRunning = false;
        }
      }

      // Schedule the next iteration (unless _stopPolling was called inside _poll)
      if (!this._pollScheduled && this._pollTimeoutRef === null) {
        // Only reschedule if we still have a reason to poll
        if (this.buttonMonitorActive || this.productionActive) {
          this._scheduleNextPoll();
        }
      }
    }, this._pollIntervalMs);
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────────

  /**
   * Called when all components are distributed.
   * Safe to call multiple times — idempotent.
   */
  async onSetupComplete() {
    if (this._setupActive) {
      // Already in setup-monitoring mode — ignore repeated calls
      return;
    }
    this._setupActive = true;

    this._initTracking();

    // Clear is_next_station_busy on all except the last station
    for (let i = 0; i < this.stationSequence.length - 1; i++) {
      const sid = this.stationSequence[i];
      await this.mh.setNextStationBusy(sid, false);
      console.log(
        `[Manager] Cleared is_next_station_busy on ${this.getStationName(sid)}`
      );
    }

    this.buttonMonitorActive = true;
    this.buttonWasPressed    = false;

    this._startPolling(100);
    console.log('[Manager] Physical start button monitoring enabled');
    this.emit({ type: 'setupComplete' });
  }

  /**
   * Called when setup is no longer complete (user changed distribution).
   * Stops monitoring so the loop doesn't run while disabled.
   */
  onSetupIncomplete() {
    if (!this._setupActive) return;
    this._setupActive        = false;
    this.buttonMonitorActive = false;
    this._stopPolling();
    console.log('[Manager] Setup monitoring stopped (distribution changed)');
  }

  /** Start production. */
  async startProduction(totalPcbs) {
    // Prevent duplicate starts
    if (this.productionActive) {
      console.warn('[Manager] startProduction called while already active — ignored');
      return;
    }

    this.totalPcbs           = totalPcbs;
    this.currentPcbId        = 0;
    this.pcbsCompleted       = 0;
    this.productionActive    = true;
    this.productionStartTime = Date.now();
    this._setupActive        = false;   // no longer in setup mode

    // Stop any existing poll loop before reconfiguring state
    this._stopPolling();

    this.buttonMonitorActive = false;

    // Deactivate physical button
    await this.mh.setStartButtonActive(this.loaderStationId, false);

    // Reset all tracking
    this.cycleStartTimes = {};
    this.pendingTrigger  = {};
    for (const sid of this.stationSequence) {
      this.pcbAtStation[sid]  = 0;
      this.readFailures[sid]  = 0;
      this.stationStates[sid] = PlacementStatus.IDLE_WAITING_FOR_NEW_PCB;
    }

    console.log(`[Manager] Production started: ${totalPcbs} PCBs`);
    this.emit({ type: 'productionStarted', totalPcbs });

    // Start poll loop then trigger first PCB
    this._startPolling(100);
    await this._triggerNextPcb();
  }

  /** Stop production. */
  async stopProduction() {
    this.productionActive = false;
    this._setupActive     = false;
    this._stopPolling();
    console.log('[Manager] Production stopped');
    this.emit({ type: 'productionStopped' });
    await this._returnToSetup();
  }

  /** Get current snapshot for UI polling. */
  getSnapshot() {
    const elapsed = this.productionStartTime
      ? (Date.now() - this.productionStartTime) / 1000
      : 0;

    const stationRows = this.stationSequence.map((sid) => {
      const avgArr = this.cycleTimes[sid] ?? [];
      const avg    = avgArr.length > 0
        ? avgArr.reduce((a, b) => a + b, 0) / avgArr.length
        : null;
      const cycleTime = this.cycleStartTimes[sid]
        ? (Date.now() - this.cycleStartTimes[sid]) / 1000
        : null;
      return {
        slaveId:      sid,
        name:         this.getStationName(sid),
        status:       this.stationStates[sid] ?? null,
        statusName:   PlacementStatus.getName(
          this.stationStates[sid] ?? PlacementStatus.IDLE_WAITING_FOR_NEW_PCB
        ),
        pcbId:        this.pcbAtStation[sid] ?? 0,
        cycleTime,
        avgCycleTime: avg,
      };
    });

    return {
      productionActive:  this.productionActive,
      totalPcbs:         this.totalPcbs,
      currentPcbId:      this.currentPcbId,
      pcbsCompleted:     this.pcbsCompleted,
      elapsedSeconds:    elapsed,
      throughputPerMin:  this.pcbsCompleted > 0 && elapsed > 0
        ? (this.pcbsCompleted / elapsed) * 60
        : 0,
      stationRows,
    };
  }

  // ─── POLL IMPLEMENTATION ──────────────────────────────────────────────────

  async _poll() {
    if (!this.mh.connected) return;

    // ── PHYSICAL BUTTON MONITORING ────────────────────────────────────────
    if (this.buttonMonitorActive && !this.productionActive) {
      try {
        const pressed = await this.mh.checkStartButtonPressed(this.loaderStationId);

        if (pressed && !this.buttonWasPressed) {
          // Rising edge — fire once then permanently disable monitoring
          console.log('[Manager] Physical start button pressed – starting production in 1 s');
          this.buttonMonitorActive = false;   // ← disable BEFORE emitting
          this.buttonWasPressed    = true;
          this._stopPolling();               // stop loop while we wait
          this.emit({ type: 'buttonPressed' });
          // The server's managerEmit will call startProduction() after 1 s
          return;
        }

        this.buttonWasPressed = pressed;
      } catch (err) {
        console.error('[Manager] Button read error:', err.message);
      }
      return; // Don't poll stations while in button-monitoring mode
    }

    // ── STATION POLLING (production active) ───────────────────────────────
    if (!this.productionActive) return;

    for (let idx = 0; idx < this.stationSequence.length; idx++) {
      const slaveId = this.stationSequence[idx];

      // Read with up to 3 attempts
      let statusData = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        statusData = await this.mh.getAllStatus(slaveId);
        if (statusData) break;
      }

      if (!statusData) {
        this.readFailures[slaveId] = (this.readFailures[slaveId] ?? 0) + 1;
        if (this.readFailures[slaveId] === 3) {
          console.warn(
            `[Manager] ${this.getStationName(slaveId)}: 3 consecutive read failures`
          );
        }
        continue;
      }
      this.readFailures[slaveId] = 0;

      const statusCode = statusData.statusCode;
      const oldStatus  = this.stationStates[slaveId]
        ?? PlacementStatus.IDLE_WAITING_FOR_NEW_PCB;
      const stationName = this.getStationName(slaveId);

      // ── RESOLVE PENDING TRIGGER ─────────────────────────────────────────
      if (
        slaveId in this.pendingTrigger &&
        statusCode === PlacementStatus.IDLE_WAITING_FOR_NEW_PCB
      ) {
        const { pcbId, srcSlaveId } = this.pendingTrigger[slaveId];
        delete this.pendingTrigger[slaveId];
        console.log(`[Manager] Resolving pending trigger: ${stationName} ← PCB ${pcbId}`);
        await this._triggerStation(slaveId, pcbId, srcSlaveId);
      }

      // ── STATE TRANSITION ────────────────────────────────────────────────
      if (oldStatus !== statusCode) {
        const oldName = PlacementStatus.getName(oldStatus);
        const newName = PlacementStatus.getName(statusCode);
        console.log(`[Manager] ${stationName}: ${oldName} → ${newName}`);
        this.stationStates[slaveId] = statusCode;

        this.emit({
          type:        'stateChange',
          slaveId,
          stationName,
          oldStatus,
          newStatus:   statusCode,
          statusName:  newName,
        });

        // Trigger next station when this one starts unloading
        if (statusCode === PlacementStatus.UNLOADING_POPULATED_PCB) {
          const pcbId = this.pcbAtStation[slaveId] ?? 0;
          if (pcbId > 0) {
            await this._triggerNextStation(idx, slaveId, pcbId);
          } else {
            console.warn(`[Manager] ${stationName} unloading but pcbAtStation=0`);
          }
        }

        // Manage is_next_station_busy
        if (idx > 0) {
          const prevId   = this.stationSequence[idx - 1];
          const prevName = this.getStationName(prevId);

          if (
            oldStatus === PlacementStatus.IDLE_WAITING_FOR_NEW_PCB &&
            statusCode !== PlacementStatus.IDLE_WAITING_FOR_NEW_PCB
          ) {
            const ok = await this.mh.setNextStationBusy(prevId, true);
            console.log(
              ok
                ? `[Manager] is_next_station_busy=TRUE  on ${prevName} (${stationName} busy)`
                : `[Manager] FAILED set is_next_station_busy=TRUE on ${prevName}`
            );
          } else if (
            oldStatus !== PlacementStatus.IDLE_WAITING_FOR_NEW_PCB &&
            statusCode === PlacementStatus.IDLE_WAITING_FOR_NEW_PCB
          ) {
            const ok = await this.mh.setNextStationBusy(prevId, false);
            console.log(
              ok
                ? `[Manager] is_next_station_busy=FALSE on ${prevName} (${stationName} idle)`
                : `[Manager] FAILED set is_next_station_busy=FALSE on ${prevName}`
            );
          }
        }

        // Completion / cycle-time tracking
        if (statusCode === PlacementStatus.IDLE_WAITING_FOR_NEW_PCB) {
          const pcbId = this.pcbAtStation[slaveId] ?? 0;

          if (slaveId in this.cycleStartTimes) {
            const cycleTime = (Date.now() - this.cycleStartTimes[slaveId]) / 1000;
            this.cycleTimes[slaveId].push(cycleTime);
            delete this.cycleStartTimes[slaveId];
            this.pcbAtStation[slaveId] = 0;

            const isLastStation =
              slaveId === this.stationSequence[this.stationSequence.length - 1];

            if (isLastStation) {
              this.pcbsCompleted++;
              console.log(
                `[Manager] PCB ${pcbId} COMPLETED at ${stationName} in ${cycleTime.toFixed(1)}s`
              );
              this.emit({
                type:          'pcbCompleted',
                pcbId,
                stationName,
                cycleTime,
                pcbsCompleted: this.pcbsCompleted,
                totalPcbs:     this.totalPcbs,
              });
            } else {
              console.log(
                `[Manager] PCB ${pcbId} done at ${stationName} in ${cycleTime.toFixed(1)}s`
              );
            }
          }

          // Fallback trigger
          if (pcbId > 0 && (this.pcbAtStation[slaveId] ?? 0) === 0) {
            if (idx < this.stationSequence.length - 1) {
              const nextId        = this.stationSequence[idx + 1];
              const alreadyQueued  = nextId in this.pendingTrigger;
              const alreadyHasPcb  = (this.pcbAtStation[nextId] ?? 0) > 0;
              if (!alreadyQueued && !alreadyHasPcb) {
                console.log(`[Manager] FALLBACK: ${stationName} → IDLE with PCB ${pcbId}`);
                await this._triggerNextStation(idx, slaveId, pcbId);
              }
            }
          }
        }
      }

      // Loader idle → try to load next PCB every cycle
      if (
        slaveId === this.loaderStationId &&
        statusCode === PlacementStatus.IDLE_WAITING_FOR_NEW_PCB
      ) {
        await this._triggerNextPcb();
      }

      // Emit snapshot
      this.emit({ type: 'snapshot', data: this.getSnapshot() });

      // Check production complete
      if (this.productionActive && this.pcbsCompleted >= this.totalPcbs) {
        await this._productionComplete();
        return; // stop iterating — production is over
      }
    }
  }

  // ─── TRIGGER HELPERS ──────────────────────────────────────────────────────

  async _triggerNextPcb() {
    if (!this.productionActive)              return;
    if (this.currentPcbId >= this.totalPcbs) return;

    const loaderId   = this.loaderStationId;
    const statusCode = await this.mh.getPlacementStatus(loaderId);
    if (statusCode !== PlacementStatus.IDLE_WAITING_FOR_NEW_PCB) return;

    const isNextBusy = await this.mh.checkNextStationBusy(loaderId);
    if (isNextBusy) return;

    const started = await this.mh.checkProcessStarted(loaderId);
    if (started) return;

    this.currentPcbId++;
    this.pcbAtStation[loaderId] = this.currentPcbId;
    await this.mh.setPcbId(loaderId, this.currentPcbId);
    await sleep(10);
    await this.mh.startPcbPopulation(loaderId);
    this.cycleStartTimes[loaderId] = Date.now();
    console.log(`[Manager] PCB ${this.currentPcbId} loaded on Loader`);
  }

  async _triggerNextStation(idx, sourceSlaveId, pcbId) {
    if (idx >= this.stationSequence.length - 1) return;

    const nextId   = this.stationSequence[idx + 1];
    const nextName = this.getStationName(nextId);
    const srcId    = sourceSlaveId === this.loaderStationId ? null : sourceSlaveId;

    const nextStatus = await this.mh.getPlacementStatus(nextId);
    if (nextStatus === PlacementStatus.IDLE_WAITING_FOR_NEW_PCB) {
      console.log(
        `[Manager] → Triggering ${nextName} with PCB ${pcbId} ` +
        `(from ${this.getStationName(sourceSlaveId)})`
      );
      await this._triggerStation(nextId, pcbId, srcId);
    } else {
      console.log(`[Manager] → ${nextName} busy, queuing PCB ${pcbId} as pending trigger`);
      this.pendingTrigger[nextId] = { pcbId, srcSlaveId: srcId };
    }
  }

  async _triggerStation(slaveId, pcbId, sourceSlaveId = null) {
    const stationName = this.getStationName(slaveId);
    const mh          = this.mh;

    // Forward populated component state
    if (sourceSlaveId !== null) {
      const populated = await mh.getOutputPopulatedCoils(sourceSlaveId);
      if (populated !== null) {
        const ok = await mh.setInputPopulatedCoils(slaveId, populated);
        console.log(
          ok
            ? `[Manager] Populated state forwarded to ${stationName}`
            : `[Manager] FAILED to forward populated coils to ${stationName}`
        );
      } else {
        await mh.setInputPopulatedCoils(slaveId, new Array(14).fill(false));
        console.warn(
          `[Manager] Could not read output coils from ` +
          `${this.getStationName(sourceSlaveId)}; clearing input coils on ${stationName}`
        );
      }
    } else {
      // First P&P or directly after loader — blank PCB
      await mh.setInputPopulatedCoils(slaveId, new Array(14).fill(false));
    }

    await mh.setPcbId(slaveId, pcbId);
    await sleep(10);
    await mh.startPcbPopulation(slaveId);
    this.pcbAtStation[slaveId]    = pcbId;
    this.cycleStartTimes[slaveId] = Date.now();
    console.log(`[Manager] ✓ Triggered ${stationName} with PCB ${pcbId}`);
  }

  // ─── PRODUCTION LIFECYCLE ─────────────────────────────────────────────────

  async _productionComplete() {
    this.productionActive = false;
    this._stopPolling();

    const totalTime = (Date.now() - this.productionStartTime) / 1000;
    console.log(
      `[Manager] Production complete: ${this.totalPcbs} PCBs in ${totalTime.toFixed(1)}s`
    );
    this.emit({
      type:             'productionComplete',
      totalPcbs:        this.totalPcbs,
      totalTime,
      throughputPerMin: (this.totalPcbs / totalTime) * 60,
    });
    await this._returnToSetup();
  }

  async _returnToSetup() {
    const allStations = [this.loaderStationId, ...this.pnpStations];
    for (const sid of allStations) {
      await this.mh.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
    }
    console.log('[Manager] All stations returned to setup page');
    this.emit({ type: 'returnedToSetup' });
  }
}

module.exports = StationManager;