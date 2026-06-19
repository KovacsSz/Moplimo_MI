/**
 * Modbus Register Definitions
 * Translated from modbus_params.h
 */

'use strict';

// UI Page Identifiers
const PageID = Object.freeze({
  STARTUP: 0,
  PLACEMENT_PARAMETERS_SETUP: 1,
  PICK_AND_PLACE_ANIMATION: 2,
  DEBUG_PARAMETERS: 3,
});

// Placement Status Codes
const PlacementStatus = Object.freeze({
  IDLE_WAITING_FOR_NEW_PCB: 0,
  LOADING_NEW_PCB: 1,
  LOADING_NEW_PCB_FINISHED: 2,
  COMPONENT_PLACEMENT_STARTED: 3,
  COMPONENT_PLACEMENT_FINISHED: 4,
  WAITING_TO_START_UNLOADING_PCB: 5,
  UNLOADING_POPULATED_PCB: 6,
  UNLOADING_FINISHED: 7,
  ERROR: 99,
  // Reverse lookup helper
  getName(code) {
    return (
      Object.entries(this).find(
        ([key, val]) => typeof val === 'number' && val === code
      )?.[0] ?? String(code)
    );
  },
});

// Coil (Read/Write Bits) Addresses
const CoilAddresses = Object.freeze({
  START_PCB_POPULATION_PROCESS: 0,
  IS_NEXT_STATION_BUSY: 1,
  INPUT_TRANSISTOR_1_IS_POPULATED: 2,
  INPUT_TRANSISTOR_2_IS_POPULATED: 3,
  INPUT_TRANSISTOR_3_IS_POPULATED: 4,
  INPUT_TRANSISTOR_4_IS_POPULATED: 5,
  INPUT_TRANSISTOR_5_IS_POPULATED: 6,
  INPUT_DIODE_1_IS_POPULATED: 7,
  INPUT_DIODE_2_IS_POPULATED: 8,
  INPUT_DIODE_3_IS_POPULATED: 9,
  INPUT_DIODE_4_IS_POPULATED: 10,
  INPUT_IC_1_IS_POPULATED: 11,
  INPUT_IC_2_IS_POPULATED: 12,
  INPUT_IC_3_IS_POPULATED: 13,
  INPUT_CAPACITOR_1_IS_POPULATED: 14,
  INPUT_CAPACITOR_2_IS_POPULATED: 15,
  SOFT_RESET: 16,
  IS_START_BUTTON_ACTIVE: 17,
});

// Discrete Input (Read-Only Bits) Addresses
const DiscreteInputAddresses = Object.freeze({
  IS_UI_LOADED: 0,
  OUTPUT_TRANSISTOR_1_IS_POPULATED: 1,
  OUTPUT_TRANSISTOR_2_IS_POPULATED: 2,
  OUTPUT_TRANSISTOR_3_IS_POPULATED: 3,
  OUTPUT_TRANSISTOR_4_IS_POPULATED: 4,
  OUTPUT_TRANSISTOR_5_IS_POPULATED: 5,
  OUTPUT_DIODE_1_IS_POPULATED: 6,
  OUTPUT_DIODE_2_IS_POPULATED: 7,
  OUTPUT_DIODE_3_IS_POPULATED: 8,
  OUTPUT_DIODE_4_IS_POPULATED: 9,
  OUTPUT_IC_1_IS_POPULATED: 10,
  OUTPUT_IC_2_IS_POPULATED: 11,
  OUTPUT_IC_3_IS_POPULATED: 12,
  OUTPUT_CAPACITOR_1_IS_POPULATED: 13,
  OUTPUT_CAPACITOR_2_IS_POPULATED: 14,
  IS_START_BUTTON_PRESSED: 15,
});

// Holding Register (Read/Write 16-bit) Addresses
const HoldingRegisterAddresses = Object.freeze({
  ACTIVE_PAGE_ID: 0,
  INPUT_PCB_ID: 1,
  TOTAL_TRANSISTOR_POSITIONS: 2,
  TOTAL_DIODE_POSITIONS: 3,
  TOTAL_IC_POSITIONS: 4,
  TOTAL_CAPACITOR_POSITIONS: 5,
  TRANSISTOR_PLACEMENT_DURATION_MS: 6,
  DIODE_PLACEMENT_DURATION_MS: 7,
  IC_PLACEMENT_DURATION_MS: 8,
  CAPACITOR_PLACEMENT_DURATION_MS: 9,
  PCB_TRANSPORT_DURATION_MS: 10,
  BRIGHTNESS_RED_LED: 11,
  BRIGHTNESS_YELLOW_LED: 12,
  BRIGHTNESS_GREEN_LED: 13,
  BRIGHTNESS_RGB_STATUS_LED: 14,
  THRESHOLD_YELLOW_LED: 15,
  THRESHOLD_RED_LED: 16,
  RFID_BOX_UID_START: 17,
  RFID_BOX_COUNT_START: 25,
  SPEAKER_VOLUME: 29,
});

// Input Register (Read-Only 16-bit) Addresses
const InputRegisterAddresses = Object.freeze({
  CURRENT_PLACEMENT_STATUS_CODE: 0,
  STATION_ID: 1,
  NUM_TRANSISTORS_TO_PLACE: 2,
  NUM_DIODES_TO_PLACE: 3,
  NUM_ICS_TO_PLACE: 4,
  NUM_CAPACITORS_TO_PLACE: 5,
  NUM_TRANSISTORS_AVAILABLE: 6,
  NUM_DIODES_AVAILABLE: 7,
  NUM_ICS_AVAILABLE: 8,
  NUM_CAPACITORS_AVAILABLE: 9,
});

// Default component counts per PCB
const DefaultComponentCounts = Object.freeze({
  transistors: 5,
  diodes: 4,
  ics: 3,
  capacitors: 2,
});

// Default timing configuration (ms)
const DefaultTimingConfig = Object.freeze({
  transistorPlacementDurationMs: 500,
  diodePlacementDurationMs: 400,
  icPlacementDurationMs: 800,
  capacitorPlacementDurationMs: 600,
  pcbTransportDurationMs: 1000,
});

// Default LED configuration
const DefaultLEDConfig = Object.freeze({
  brightnessRedLed: 2048,
  brightnessYellowLed: 2048,
  brightnessGreenLed: 2048,
  brightnessRgbStatusLed: 2048,
  thresholdYellowLed: 1000,
  thresholdRedLed: 500,
});

// Default audio configuration
const DefaultAudioConfig = Object.freeze({
  speakerVolume: 50,
});

// Modbus communication parameters
const MODBUS_BAUDRATE = 115200;
const MODBUS_PARITY = 'N';
const MODBUS_DATA_BITS = 8;
const MODBUS_STOP_BITS = 1;
const MODBUS_TIMEOUT = 1000; // milliseconds

// Slave IDs
const PCB_LOADER_SLAVE_ID = 5;
const MAX_STATIONS = 4;
const SLAVE_IDS = [1, 2, 3, 4];
const ALL_SLAVE_IDS = [PCB_LOADER_SLAVE_ID, ...SLAVE_IDS];

module.exports = {
  PageID,
  PlacementStatus,
  CoilAddresses,
  DiscreteInputAddresses,
  HoldingRegisterAddresses,
  InputRegisterAddresses,
  DefaultComponentCounts,
  DefaultTimingConfig,
  DefaultLEDConfig,
  DefaultAudioConfig,
  MODBUS_BAUDRATE,
  MODBUS_PARITY,
  MODBUS_DATA_BITS,
  MODBUS_STOP_BITS,
  MODBUS_TIMEOUT,
  PCB_LOADER_SLAVE_ID,
  MAX_STATIONS,
  SLAVE_IDS,
  ALL_SLAVE_IDS,
};