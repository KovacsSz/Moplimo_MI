/**
 * Configuration Tab controller
 */

'use strict';

const ConfigurationTab = (() => {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('readConfigBtn').addEventListener('click', readConfiguration);
    document.getElementById('writeConfigBtn').addEventListener('click', writeConfiguration);
    document.getElementById('softResetBtn').addEventListener('click', softReset);
  });

  // ── Read ──────────────────────────────────────────────────────────────────
  async function readConfiguration() {
    if (!AppState.connected) { alert('Not connected to any stations'); return; }
    try {
      const cfg = await apiGet('/api/configuration');

      if (cfg.timing) {
        setValue('timing-transistor', cfg.timing.transistor);
        setValue('timing-diode',      cfg.timing.diode);
        setValue('timing-ic',         cfg.timing.ic);
        setValue('timing-capacitor',  cfg.timing.capacitor);
        setValue('timing-transport',  cfg.timing.transport);
      }

      if (cfg.led) {
        setRange('led-red',    cfg.led.red,    'led-red-val');
        setRange('led-yellow', cfg.led.yellow, 'led-yellow-val');
        setRange('led-green',  cfg.led.green,  'led-green-val');
        setRange('led-rgb',    cfg.led.rgb,    'led-rgb-val');
        setValue('thresh-yellow', cfg.led.thresholdYellow);
        setValue('thresh-red',    cfg.led.thresholdRed);
      }

      if (cfg.rfid) {
        cfg.rfid.forEach((box, i) => {
          setValue(`rfid-uid-high-${i}`, `0x${box.uidHigh.toString(16).toUpperCase().padStart(8, '0')}`);
          setValue(`rfid-uid-low-${i}`,  `0x${box.uidLow.toString(16).toUpperCase().padStart(8, '0')}`);
          setValue(`rfid-count-${i}`,    box.count);
        });
      }

      if (cfg.volume != null) {
        setRange('audio-volume', cfg.volume, 'audio-vol-val');
      }

      alert(`Configuration read from P&P Station ${AppState.pnpStations[0]}`);
    } catch (err) {
      alert(`Failed to read configuration: ${err.message}`);
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  async function writeConfiguration() {
    if (!AppState.connected) { alert('Not connected'); return; }
    if (!confirm('Write configuration to all stations?')) return;

    const rfid = Array.from({ length: 4 }, (_, i) => {
      const highStr = document.getElementById(`rfid-uid-high-${i}`)?.value ?? '0';
      const lowStr  = document.getElementById(`rfid-uid-low-${i}`)?.value  ?? '0';
      return {
        uidHigh: parseInt(highStr, 16) || 0,
        uidLow:  parseInt(lowStr,  16) || 0,
        count:   parseInt(document.getElementById(`rfid-count-${i}`)?.value ?? '0') || 0,
      };
    });

    const body = {
      timing: {
        transistor: getNumber('timing-transistor'),
        diode:      getNumber('timing-diode'),
        ic:         getNumber('timing-ic'),
        capacitor:  getNumber('timing-capacitor'),
        transport:  getNumber('timing-transport'),
      },
      led: {
        red:            getNumber('led-red'),
        yellow:         getNumber('led-yellow'),
        green:          getNumber('led-green'),
        rgb:            getNumber('led-rgb'),
        thresholdYellow: getNumber('thresh-yellow'),
        thresholdRed:    getNumber('thresh-red'),
      },
      rfid,
      volume: getNumber('audio-volume'),
    };

    try {
      const res = await apiPost('/api/configuration', body);
      if (res.error) throw new Error(res.error);
      alert(`Configuration written to all ${AppState.availableStations.length} stations`);
    } catch (err) {
      alert(`Failed to write configuration: ${err.message}`);
    }
  }

  // ── Soft Reset ────────────────────────────────────────────────────────────
  async function softReset() {
    if (!AppState.connected) { alert('Not connected'); return; }
    if (!confirm(
      'This will soft reset ALL stations.\n\n' +
      'Stations will stop, reset to initial state, and return to setup page.\n\n' +
      'Any PCBs being processed may be lost.\n\nContinue?'
    )) return;

    try {
      const res = await apiPost('/api/configuration/soft-reset', {});
      if (res.error) throw new Error(res.error);
      alert(`All ${AppState.availableStations.length} stations reset successfully.`);
    } catch (err) {
      alert(`Failed to reset stations: ${err.message}`);
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function setValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  function setRange(id, val, labelId) {
    const el = document.getElementById(id);
    if (el) { el.value = val; }
    if (labelId) {
      const lbl = document.getElementById(labelId);
      if (lbl) lbl.textContent = val;
    }
  }

  function getNumber(id) {
    return parseInt(document.getElementById(id)?.value ?? '0') || 0;
  }

  return {};
})();