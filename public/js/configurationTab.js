/**
 * Configuration Tab controller
 */

'use strict';

const ConfigurationTab = (() => {

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('readConfigBtn') ?.addEventListener('click', readConfiguration);
    document.getElementById('writeConfigBtn')?.addEventListener('click', writeConfiguration);
    document.getElementById('softResetBtn')  ?.addEventListener('click', softReset);
  });

  async function readConfiguration() {
    if (!AppState.connected) { alert('No stations connected'); return; }
    try {
      const cfg = await apiGet('/api/configuration');
      if (cfg.timing) {
        setVal('timing-transistor', cfg.timing.transistor);
        setVal('timing-diode',      cfg.timing.diode);
        setVal('timing-ic',         cfg.timing.ic);
        setVal('timing-capacitor',  cfg.timing.capacitor);
        setVal('timing-transport',  cfg.timing.transport);
      }
      if (cfg.led) {
        setRng('led-red',    cfg.led.red,    'led-red-val');
        setRng('led-yellow', cfg.led.yellow, 'led-yellow-val');
        setRng('led-green',  cfg.led.green,  'led-green-val');
        setRng('led-rgb',    cfg.led.rgb,    'led-rgb-val');
        setVal('thresh-yellow', cfg.led.thresholdYellow);
        setVal('thresh-red',    cfg.led.thresholdRed);
      }
      if (cfg.rfid) {
        cfg.rfid.forEach((box, i) => {
          setVal(`rfid-uid-high-${i}`,
            `0x${box.uidHigh.toString(16).toUpperCase().padStart(8,'0')}`);
          setVal(`rfid-uid-low-${i}`,
            `0x${box.uidLow.toString(16).toUpperCase().padStart(8,'0')}`);
          setVal(`rfid-count-${i}`, box.count);
        });
      }
      if (cfg.volume != null) setRng('audio-volume', cfg.volume, 'audio-vol-val');
      alert('Configuration read successfully');
    } catch (err) { alert(`Read failed: ${err.message}`); }
  }

  async function writeConfiguration() {
    if (!AppState.connected) { alert('No stations connected'); return; }
    if (!confirm('Write configuration to all stations?')) return;
    const rfid = Array.from({ length: 4 }, (_, i) => ({
      uidHigh: parseInt(document.getElementById(`rfid-uid-high-${i}`)?.value ?? '0', 16) || 0,
      uidLow:  parseInt(document.getElementById(`rfid-uid-low-${i}`)?.value  ?? '0', 16) || 0,
      count:   parseInt(document.getElementById(`rfid-count-${i}`)?.value    ?? '0') || 0,
    }));
    const body = {
      timing: {
        transistor: getNum('timing-transistor'), diode:     getNum('timing-diode'),
        ic:         getNum('timing-ic'),         capacitor: getNum('timing-capacitor'),
        transport:  getNum('timing-transport'),
      },
      led: {
        red:             getNum('led-red'),    yellow: getNum('led-yellow'),
        green:           getNum('led-green'),  rgb:    getNum('led-rgb'),
        thresholdYellow: getNum('thresh-yellow'),
        thresholdRed:    getNum('thresh-red'),
      },
      rfid,
      volume: getNum('audio-volume'),
    };
    try {
      const res = await apiPost('/api/configuration', body);
      if (res.error) throw new Error(res.error);
      alert('Configuration written to all stations');
    } catch (err) { alert(`Write failed: ${err.message}`); }
  }

  async function softReset() {
    if (!AppState.connected) { alert('No stations connected'); return; }
    if (!confirm(
      'Soft reset ALL stations?\nAny PCBs being processed may be lost.\nContinue?'
    )) return;
    try {
      const res = await apiPost('/api/configuration/soft-reset', {});
      if (res.error) throw new Error(res.error);
      alert('All stations reset successfully');
    } catch (err) { alert(`Reset failed: ${err.message}`); }
  }

  function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
  function setRng(id, val, lblId) {
    setVal(id, val);
    const lbl = document.getElementById(lblId);
    if (lbl) lbl.textContent = val;
  }
  function getNum(id) { return parseInt(document.getElementById(id)?.value ?? '0') || 0; }

  return {};
})();