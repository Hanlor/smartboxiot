/**
 * ESP32 SIMULATOR — Giả lập 1 thiết bị ESP32 gửi heartbeat lên server.
 * Dùng để test backend + admin UI trước khi có hardware thật.
 *
 * Cách chạy:
 *   node simulator/esp32-sim.js
 *   node simulator/esp32-sim.js --device ESP32-TEST --interval 10
 *   node simulator/esp32-sim.js --fail-door 3        (giả lập cảm biến cửa tủ 3 lỏng)
 *   node simulator/esp32-sim.js --fail-servo 2       (giả lập servo tủ 2 kẹt)
 *   node simulator/esp32-sim.js --offline-after 60   (sau 60s ngừng gửi → test offline detect)
 */

const axios = require('axios');

// ─── Parse args ───
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
function hasFlag(name) {
  return args.includes(name);
}

const DEVICE_ID = getArg('--device', 'ESP32-SIM-01');
const INTERVAL_S = parseInt(getArg('--interval', '30'));
const FAIL_DOOR = parseInt(getArg('--fail-door', '0'));       // 0 = không fail
const FAIL_SERVO = parseInt(getArg('--fail-servo', '0'));
const FAIL_ITEM = parseInt(getArg('--fail-item', '0'));
const OFFLINE_AFTER = parseInt(getArg('--offline-after', '0')); // 0 = không ngắt
const API_BASE = getArg('--api', process.env.API_BASE || 'https://smartboxiot-1.onrender.com');

console.log('═'.repeat(60));
console.log('  ESP32 SIMULATOR');
console.log('═'.repeat(60));
console.log(`  Device ID     : ${DEVICE_ID}`);
console.log(`  API Base      : ${API_BASE}`);
console.log(`  Interval      : ${INTERVAL_S}s`);
console.log(`  Fail Door     : ${FAIL_DOOR || 'không'}`);
console.log(`  Fail Servo    : ${FAIL_SERVO || 'không'}`);
console.log(`  Fail Item     : ${FAIL_ITEM || 'không'}`);
console.log(`  Offline After : ${OFFLINE_AFTER ? OFFLINE_AFTER + 's' : 'không'}`);
console.log('═'.repeat(60));
console.log('');

// ─── Boot self-test gửi 1 lần đầu ───
async function sendBootSelfTest() {
  const failed = [FAIL_SERVO, FAIL_DOOR, FAIL_ITEM].filter(x => x > 0).length;

  const selfTest = {
    passed: 8 - failed,
    failed,
    total: 8,
    details: {
      servo_1: FAIL_SERVO === 1 ? 'fail' : 'ok',
      servo_2: FAIL_SERVO === 2 ? 'fail' : 'ok',
      servo_3: FAIL_SERVO === 3 ? 'fail' : 'ok',
      door_1: FAIL_DOOR === 1 ? 'fail' : 'ok',
      door_2: FAIL_DOOR === 2 ? 'fail' : 'ok',
      door_3: FAIL_DOOR === 3 ? 'fail' : 'ok',
      lcd: 'ok',
      neopixel: 'ok',
    },
  };

  await sendHealth({ boot_self_test: selfTest });
  console.log(`[BOOT] Self-test: ${selfTest.passed}/${selfTest.total} passed`);
}

// ─── Fake sensor data ───
function fakeSensors() {
  const rand = () => Math.random();
  return {
    locker_1: {
      door: FAIL_DOOR === 1 ? 'flaky' : 'ok',
      item: FAIL_ITEM === 1 ? 'stuck' : 'ok',
      servo: FAIL_SERVO === 1 ? 'stuck' : 'ok',
    },
    locker_2: {
      door: FAIL_DOOR === 2 ? 'flaky' : 'ok',
      item: FAIL_ITEM === 2 ? 'stuck' : 'ok',
      servo: FAIL_SERVO === 2 ? 'slow' : 'ok',
    },
    locker_3: {
      door: FAIL_DOOR === 3 ? 'flaky' : 'ok',
      item: FAIL_ITEM === 3 ? 'stuck' : 'ok',
      servo: FAIL_SERVO === 3 ? 'stuck' : 'ok',
    },
  };
}

function buildWarnings() {
  const w = [];
  if (FAIL_DOOR) w.push(`locker_${FAIL_DOOR}.door_flaky`);
  if (FAIL_SERVO) w.push(`locker_${FAIL_SERVO}.servo_${FAIL_SERVO === 2 ? 'slow' : 'stuck'}`);
  if (FAIL_ITEM) w.push(`locker_${FAIL_ITEM}.item_stuck`);
  return w;
}

// ─── Health payload ───
let startTime = Date.now();
let heartbeatCount = 0;

async function sendHealth(extra = {}) {
  heartbeatCount++;
  const uptimeS = Math.floor((Date.now() - startTime) / 1000);

  // WiFi RSSI dao động nhẹ (-55 đến -70)
  const wifiRssi = Math.floor(-55 - Math.random() * 15);

  // RAM còn trống 120-180KB
  const freeRam = Math.floor(120000 + Math.random() * 60000);

  const payload = {
    device_id: DEVICE_ID,
    uptime_s: uptimeS,
    wifi_rssi: wifiRssi,
    free_ram: freeRam,
    sensors: fakeSensors(),
    warnings: buildWarnings(),
    ...extra,
  };

  try {
    const res = await axios.post(
      `${API_BASE}/api/v1/telemetry/health`,
      payload,
      { timeout: 15000 }
    );

    const icon = payload.warnings.length > 0 ? '⚠️ ' : '✅';
    console.log(
      `${icon} [#${heartbeatCount}] uptime=${uptimeS}s · RSSI=${wifiRssi}dBm · RAM=${Math.round(freeRam/1024)}KB · warns=${payload.warnings.length}`
    );

    if (payload.warnings.length > 0) {
      payload.warnings.forEach(w => console.log(`     ⚠️  ${w}`));
    }

    return true;
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status} - ${JSON.stringify(err.response.data)}`
      : err.message;
    console.error(`❌ [#${heartbeatCount}] Failed: ${detail}`);
    return false;
  }
}

// ─── Main loop ───
async function main() {
  // Boot self-test
  await sendBootSelfTest();
  console.log('');

  // Heartbeat loop
  const intervalMs = INTERVAL_S * 1000;
  const offlineAfterMs = OFFLINE_AFTER * 1000;
  const runStart = Date.now();

  const timer = setInterval(async () => {
    // Nếu bật offline-after → dừng gửi sau thời gian đó
    if (offlineAfterMs > 0 && (Date.now() - runStart) > offlineAfterMs) {
      console.log(`\n💤 [SIMULATOR] Ngừng gửi heartbeat (đã ${OFFLINE_AFTER}s). Test offline detection...`);
      clearInterval(timer);
      return;
    }

    await sendHealth();
  }, intervalMs);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Simulator stopped.');
    clearInterval(timer);
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});