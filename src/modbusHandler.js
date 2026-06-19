/**
 * Modbus Communication Handler
 * Handles all Modbus RTU communication with Pick and Place machines
 */

'use strict';

const ModbusRTU = require('modbus-serial');
const {
  MODBUS_BAUDRATE,
  MODBUS_PARITY,
  MODBUS_DATA_BITS,
  MODBUS_STOP_BITS,
  MODBUS_TIMEOUT,
  SLAVE_IDS,
  CoilAddresses,
  DiscreteInputAddresses,
  HoldingRegisterAddresses,
  InputRegisterAddresses,
} = require('./modbusDefinitions');

const PARITY_MAP = { N: 'none', E: 'even', O: 'odd' };

// Inter-frame gap on RS-485 bus (ms) — keep short but non-zero
const BUS_GAP_MS = 20;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class ModbusHandler {
  /**
   * @param {string} port  Serial port name (e.g. 'COM1', '/dev/ttyUSB0')
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=1000]   Per-request timeout
   * @param {number} [opts.retries=2]        Automatic retries on timeout/error
   * @param {number} [opts.retryDelayMs=200] Delay between retries
   */
  constructor(port, opts = {}) {
    this.port          = port;
    this.timeoutMs     = opts.timeoutMs    ?? 1000;
    this.retries       = opts.retries      ?? 2;
    this.retryDelayMs  = opts.retryDelayMs ?? 200;

    this.client    = new ModbusRTU();
    this.connected = false;

    // Serialize all Modbus transactions — one at a time on shared RS-485 bus
    this._queue = Promise.resolve();
  }

  // ─── INTERNAL HELPERS ─────────────────────────────────────────────────────

  /**
   * Enqueue a Modbus transaction so requests never overlap.
   * Adds a small inter-frame gap after each transaction.
   */
  _enqueue(fn) {
    this._queue = this._queue
      .then(fn, fn)                        // run even if previous failed
      .then(
        (v) => sleep(BUS_GAP_MS).then(() => v),
        (e) => sleep(BUS_GAP_MS).then(() => { throw e; })
      );
    return this._queue;
  }

  /**
   * Execute a Modbus operation with automatic retries.
   * @param {() => Promise<T>} op
   * @returns {Promise<T|null>}  null on all-retries-exhausted
   */
  async _withRetry(op) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await sleep(this.retryDelayMs);
        }
      }
    }
    throw lastErr;
  }

  // ─── CONNECTION ───────────────────────────────────────────────────────────

  async connect() {
    try {
      await this.client.connectRTUBuffered(this.port, {
        baudRate: MODBUS_BAUDRATE,
        parity:   PARITY_MAP[MODBUS_PARITY] ?? 'none',
        stopBits: MODBUS_STOP_BITS,
        dataBits: MODBUS_DATA_BITS,
      });
      this.client.setTimeout(this.timeoutMs);
      this.connected = true;
      console.log(`[Modbus] Connected on ${this.port}`);
      return true;
    } catch (err) {
      console.error(`[Modbus] Connection error on ${this.port}:`, err.message);
      this.connected = false;
      return false;
    }
  }

  disconnect() {
    try {
      if (this.client.isOpen) this.client.close(() => {});
    } catch { /* ignore */ }
    this.connected = false;
    console.log(`[Modbus] Disconnected from ${this.port}`);
  }

  // ─── STATION DETECTION ────────────────────────────────────────────────────

  /**
   * Ping a station — returns true if it responds within timeoutMs.
   * Uses a dedicated short timeout so detection is fast.
   */
  async pingStation(slaveId) {
    if (!this.connected) return false;
    return this._enqueue(async () => {
      try {
        this.client.setID(slaveId);
        await this.client.readInputRegisters(InputRegisterAddresses.STATION_ID, 1);
        return true;
      } catch {
        return false;
      }
    });
  }

  async detectStations() {
    const available = [];
    for (const id of SLAVE_IDS) {
      if (await this.pingStation(id)) available.push(id);
      await sleep(50);
    }
    console.log(`[Modbus] Detected stations: ${available}`);
    return available;
  }

  // ─── COIL OPERATIONS ─────────────────────────────────────────────────────

  async writeCoil(slaveId, address, value) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          await this.client.writeCoil(address, value);
          return true;
        });
      } catch (err) {
        console.error(`[Modbus] writeCoil(slave=${slaveId} addr=${address}): ${err.message}`);
        return false;
      }
    });
  }

  async readCoils(slaveId, address, count) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          const result = await this.client.readCoils(address, count);
          return result.data.slice(0, count);
        });
      } catch (err) {
        console.error(`[Modbus] readCoils(slave=${slaveId} addr=${address}): ${err.message}`);
        return null;
      }
    });
  }

  async softReset(slaveId) {
    return this.writeCoil(slaveId, CoilAddresses.SOFT_RESET, true);
  }

  /**
   * Check if soft reset is complete.
   * Returns true  → reset done (coil back to false)
   * Returns false → still resetting OR comms failure
   */
  async checkSoftResetComplete(slaveId) {
    const coils = await this.readCoils(slaveId, CoilAddresses.SOFT_RESET, 1);
    if (coils === null) return false;   // timeout = still booting, treat as not done
    return !coils[0];
  }

  async startPcbPopulation(slaveId) {
    return this.writeCoil(slaveId, CoilAddresses.START_PCB_POPULATION_PROCESS, true);
  }

  async checkProcessStarted(slaveId) {
    const coils = await this.readCoils(
      slaveId, CoilAddresses.START_PCB_POPULATION_PROCESS, 1
    );
    return coils !== null && coils[0];
  }

  async setNextStationBusy(slaveId, busy) {
    return this.writeCoil(slaveId, CoilAddresses.IS_NEXT_STATION_BUSY, busy);
  }

  async checkNextStationBusy(slaveId) {
    const coils = await this.readCoils(slaveId, CoilAddresses.IS_NEXT_STATION_BUSY, 1);
    return coils !== null && coils[0];
  }

  async setStartButtonActive(slaveId, active) {
    return this.writeCoil(slaveId, CoilAddresses.IS_START_BUTTON_ACTIVE, active);
  }

  async getOutputPopulatedCoils(slaveId) {
    return this.readDiscreteInputs(
      slaveId,
      DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED,
      14
    );
  }

  async setInputPopulatedCoils(slaveId, populated) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          await this.client.writeCoils(
            CoilAddresses.INPUT_TRANSISTOR_1_IS_POPULATED,
            populated
          );
          return true;
        });
      } catch (err) {
        console.error(
          `[Modbus] setInputPopulatedCoils(slave=${slaveId}): ${err.message}`
        );
        return false;
      }
    });
  }

  // ─── DISCRETE INPUT OPERATIONS ────────────────────────────────────────────

  async readDiscreteInputs(slaveId, address, count) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          const result = await this.client.readDiscreteInputs(address, count);
          return result.data.slice(0, count);
        });
      } catch (err) {
        console.error(
          `[Modbus] readDiscreteInputs(slave=${slaveId} addr=${address}): ${err.message}`
        );
        return null;
      }
    });
  }

  /**
   * Check if UI is loaded — with extended timeout for post-reset boot.
   * Polls up to `maxWaitMs` with `intervalMs` between attempts.
   */
  async checkUiLoaded(slaveId, maxWaitMs = 0, intervalMs = 500) {
    const deadline = Date.now() + maxWaitMs;
    do {
      const inputs = await this.readDiscreteInputs(
        slaveId, DiscreteInputAddresses.IS_UI_LOADED, 1
      );
      if (inputs !== null && inputs[0]) return true;
      if (Date.now() < deadline) await sleep(intervalMs);
    } while (Date.now() < deadline);
    return false;
  }

  async checkStartButtonPressed(slaveId) {
    const inputs = await this.readDiscreteInputs(
      slaveId, DiscreteInputAddresses.IS_START_BUTTON_PRESSED, 1
    );
    return inputs !== null && inputs[0];
  }

  async getOutputComponentStatus(slaveId) {
    const inputs = await this.readDiscreteInputs(
      slaveId,
      DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED,
      14
    );
    if (!inputs) return null;
    return {
      transistors: inputs.slice(0, 5),
      diodes:      inputs.slice(5, 9),
      ics:         inputs.slice(9, 12),
      capacitors:  inputs.slice(12, 14),
    };
  }

  // ─── HOLDING REGISTER OPERATIONS ─────────────────────────────────────────

  async writeHoldingRegister(slaveId, address, value) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          await this.client.writeRegister(address, value);
          return true;
        });
      } catch (err) {
        console.error(
          `[Modbus] writeHoldingRegister(slave=${slaveId} addr=${address}): ${err.message}`
        );
        return false;
      }
    });
  }

  async writeHoldingRegisters(slaveId, address, values) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          await this.client.writeRegisters(address, values);
          return true;
        });
      } catch (err) {
        console.error(
          `[Modbus] writeHoldingRegisters(slave=${slaveId} addr=${address}): ${err.message}`
        );
        return false;
      }
    });
  }

  async readHoldingRegisters(slaveId, address, count) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          const result = await this.client.readHoldingRegisters(address, count);
          return result.data;
        });
      } catch (err) {
        console.error(
          `[Modbus] readHoldingRegisters(slave=${slaveId} addr=${address}): ${err.message}`
        );
        return null;
      }
    });
  }

  async setActivePage(slaveId, pageId) {
    return this.writeHoldingRegister(
      slaveId, HoldingRegisterAddresses.ACTIVE_PAGE_ID, pageId
    );
  }

  async setPcbId(slaveId, pcbId) {
    return this.writeHoldingRegister(
      slaveId, HoldingRegisterAddresses.INPUT_PCB_ID, pcbId
    );
  }

  async setTotalPositions(slaveId, transistors, diodes, ics, capacitors) {
    return this.writeHoldingRegisters(
      slaveId,
      HoldingRegisterAddresses.TOTAL_TRANSISTOR_POSITIONS,
      [transistors, diodes, ics, capacitors]
    );
  }

  async setTimingConfig(slaveId, transistorMs, diodeMs, icMs, capacitorMs, transportMs) {
    return this.writeHoldingRegisters(
      slaveId,
      HoldingRegisterAddresses.TRANSISTOR_PLACEMENT_DURATION_MS,
      [transistorMs, diodeMs, icMs, capacitorMs, transportMs]
    );
  }

  async setLedConfig(slaveId, red, yellow, green, rgb, thresholdYellow, thresholdRed) {
    return this.writeHoldingRegisters(
      slaveId,
      HoldingRegisterAddresses.BRIGHTNESS_RED_LED,
      [red, yellow, green, rgb, thresholdYellow, thresholdRed]
    );
  }

  async setSpeakerVolume(slaveId, volume) {
    return this.writeHoldingRegister(
      slaveId, HoldingRegisterAddresses.SPEAKER_VOLUME, volume
    );
  }

  // ─── INPUT REGISTER OPERATIONS ────────────────────────────────────────────

  async readInputRegisters(slaveId, address, count) {
    return this._enqueue(async () => {
      try {
        return await this._withRetry(async () => {
          this.client.setID(slaveId);
          const result = await this.client.readInputRegisters(address, count);
          return result.data;
        });
      } catch (err) {
        console.error(
          `[Modbus] readInputRegisters(slave=${slaveId} addr=${address}): ${err.message}`
        );
        return null;
      }
    });
  }

  async getStationId(slaveId) {
    const regs = await this.readInputRegisters(
      slaveId, InputRegisterAddresses.STATION_ID, 1
    );
    return regs ? regs[0] : null;
  }

  async getPlacementStatus(slaveId) {
    const regs = await this.readInputRegisters(
      slaveId, InputRegisterAddresses.CURRENT_PLACEMENT_STATUS_CODE, 1
    );
    return regs ? regs[0] : null;
  }

  async getComponentsToPlace(slaveId) {
    const regs = await this.readInputRegisters(
      slaveId, InputRegisterAddresses.NUM_TRANSISTORS_TO_PLACE, 4
    );
    return regs ?? null;
  }

  async getComponentsAvailable(slaveId) {
    const regs = await this.readInputRegisters(
      slaveId, InputRegisterAddresses.NUM_TRANSISTORS_AVAILABLE, 4
    );
    return regs ?? null;
  }

  async getAllStatus(slaveId) {
    const regs = await this.readInputRegisters(
      slaveId, InputRegisterAddresses.CURRENT_PLACEMENT_STATUS_CODE, 10
    );
    if (!regs) return null;
    return {
      statusCode: regs[0],
      stationId:  regs[1],
      toPlace: {
        transistors: regs[2],
        diodes:      regs[3],
        ics:         regs[4],
        capacitors:  regs[5],
      },
      available: {
        transistors: regs[6],
        diodes:      regs[7],
        ics:         regs[8],
        capacitors:  regs[9],
      },
    };
  }
}

module.exports = ModbusHandler;