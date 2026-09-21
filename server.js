/**
 * Smart Box API Gateway
 * 3-compartment IoT locker backend: in-memory store, LCD preview, SMS gateway.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const PORT = process.env.PORT || 3000;
const SMS_GATEWAY_URL =
  process.env.SMS_GATEWAY_URL || 'http://192.168.43.1:8080/send-sms';
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LCD_WIDTH = 20;

const LOCKER_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  DEPOSITING: 'DEPOSITING',
  OCCUPIED: 'OCCUPIED',
  PICKING: 'PICKING',
  MAINTENANCE: 'MAINTENANCE',
});

const LCD_STATUS_VI = Object.freeze({
  AVAILABLE: 'TRONG',
  RESERVED: 'GIU CHO',
  DEPOSITING: 'DANG GUI',
  OCCUPIED: 'CO HANG',
  PICKING: 'DANG LAY',
  MAINTENANCE: 'BAO TRI',
});

const SERVO = Object.freeze({
  UNLOCKED: 0,
  LOCKED: 90,
});

// ---------------------------------------------------------------------------
// In-memory data store (no database)
// ---------------------------------------------------------------------------
const db = {
  lockers: new Map(),
  shipments: new Map(),
  otps: new Map(),
};

function createLocker(lockerId, size) {
  return {
    locker_id: lockerId,
    size,
    status: LOCKER_STATUS.AVAILABLE,
    door_closed: true,
    has_item: false,
    led_color: 'GREEN',
    led_blink: false,
    servo_angle: SERVO.LOCKED,
    shipment_id: null,
    sender_phone: null,
    recipient_phone: null,
    qr_token: null,
  };
}

function seedLockers() {
  db.lockers.set(1, createLocker(1, 'S'));
  db.lockers.set(2, createLocker(2, 'M'));
  db.lockers.set(3, createLocker(3, 'L'));
}

seedLockers();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ledForStatus(status) {
  switch (status) {
    case LOCKER_STATUS.AVAILABLE:
      return { led_color: 'GREEN', led_blink: false };
    case LOCKER_STATUS.RESERVED:
      return { led_color: 'YELLOW', led_blink: true };
    case LOCKER_STATUS.DEPOSITING:
    case LOCKER_STATUS.PICKING:
      return { led_color: 'YELLOW', led_blink: false };
    case LOCKER_STATUS.OCCUPIED:
      return { led_color: 'RED', led_blink: false };
    case LOCKER_STATUS.MAINTENANCE:
    default:
      return { led_color: 'OFF', led_blink: false };
  }
}

function applyStatus(locker, status) {
  locker.status = status;
  const led = ledForStatus(status);
  locker.led_color = led.led_color;
  locker.led_blink = led.led_blink;

  if (status === LOCKER_STATUS.DEPOSITING || status === LOCKER_STATUS.PICKING) {
    locker.servo_angle = SERVO.UNLOCKED;
  } else {
    locker.servo_angle = SERVO.LOCKED;
  }
}

function padLcdLine(text) {
  const raw = String(text ?? '');
  if (raw.length >= LCD_WIDTH) return raw.slice(0, LCD_WIDTH);
  return raw + ' '.repeat(LCD_WIDTH - raw.length);
}

function lockerLcdToken(locker) {
  const label = LCD_STATUS_VI[locker.status] || '????';
  return `N${locker.locker_id}:${label}`;
}

function joinLcdTokens(left, right) {
  const gap = Math.max(1, LCD_WIDTH - left.length - right.length);
  return padLcdLine(`${left}${' '.repeat(gap)}${right}`);
}

/**
 * Dynamic 20x04 LCD preview (exactly 20 chars per line).
 * Line 1: brand, Line 2: lockers 1–2, Line 3: locker 3, Line 4: prompt.
 */
function generateLcdPreview() {
  const l1 = db.lockers.get(1);
  const l2 = db.lockers.get(2);
  const l3 = db.lockers.get(3);

  return {
    line1: padLcdLine('--- TU SMART BOX ---'),
    line2: joinLcdTokens(lockerLcdToken(l1), lockerLcdToken(l2)),
    line3: padLcdLine(lockerLcdToken(l3)),
    line4: padLcdLine('> QUET QR/NHAP OTP <'),
  };
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function generateQrToken() {
  return `TOKEN_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function generateShipmentId() {
  let id;
  do {
    id = `SB-${String(crypto.randomInt(0, 10_000)).padStart(4, '0')}`;
  } while (db.shipments.has(id));
  return id;
}

function publicLockerView(locker) {
  const view = {
    locker_id: locker.locker_id,
    size: locker.size,
    status: locker.status,
    door_closed: locker.door_closed,
    has_item: locker.has_item,
    led_color: locker.led_color,
  };

  if (locker.recipient_phone && locker.status !== LOCKER_STATUS.AVAILABLE) {
    view.recipient_phone = locker.recipient_phone;
  }

  return view;
}

/**
 * Send OTP SMS through the local Android SMS gateway.
 * Failures are logged and returned; callers should not roll back locker state.
 */
async function sendSMSViaAndroid(phone, otp) {
  const payload = {
    phone_number: phone,
    message: `SmartBox: Ma mo tu o cua ban la ${otp}`,
  };

  try {
    const response = await axios.post(SMS_GATEWAY_URL, payload, {
      timeout: 3000,
      headers: { 'Content-Type': 'application/json' },
    });
    return { sent: true, status: response.status };
  } catch (error) {
    const detail = error.response
      ? `HTTP ${error.response.status}`
      : error.message;
    console.error(`[SMS] Failed to send OTP to ${phone}: ${detail}`);
    return { sent: false, error: detail };
  }
}

function purgeExpiredOtps(now = Date.now()) {
  for (const [key, record] of db.otps.entries()) {
    if (record.used || record.expires_at <= now) {
      db.otps.delete(key);
    }
  }
}

// Periodic OTP cleanup
setInterval(() => purgeExpiredOtps(), 30_000).unref();

// ---------------------------------------------------------------------------
// Express application
// ---------------------------------------------------------------------------
const app = express();

app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.locals.db = db;
app.locals.constants = {
  LOCKER_STATUS,
  OTP_TTL_MS,
  SERVO,
};
app.locals.helpers = {
  applyStatus,
  generateLcdPreview,
  generateOtpCode,
  generateQrToken,
  generateShipmentId,
  publicLockerView,
  sendSMSViaAndroid,
  purgeExpiredOtps,
};

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'smart-box-api', uptime_s: Math.round(process.uptime()) });
});

app.use('/api/v1', require('./routes/api'));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, _req, res, _next) => {
  console.error('[API] Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Smart Box API Gateway listening on port ${PORT}`);
    console.log(`SMS gateway: ${SMS_GATEWAY_URL}`);
  });
}

module.exports = {
  app,
  db,
  sendSMSViaAndroid,
  generateLcdPreview,
  applyStatus,
  LOCKER_STATUS,
  OTP_TTL_MS,
};
