/**
 * Smart Box API Gateway
 * 3-compartment IoT locker backend: SQLite store, LCD preview, SMS gateway.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

// 1. Khởi tạo Express App (CHỈ KHAI BÁO 1 LẦN DUY NHẤT Ở ĐÂY)
const app = express();

// 2. Cấu hình CORS mở rộng (Cho phép v0.dev & mọi Client gọi vào không bị chặn)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 3. KẾT NỐI DATABASE SQLITE
const sqliteDb = require('./database');

const PORT = process.env.PORT || 3000;
const SMS_GATEWAY_URL = 'http://192.168.1.5:8080/message';
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESERVATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_FAILURES = 5;
const OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const LCD_WIDTH = 20;
const STATE_FILE = path.join(__dirname, 'state.json');

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

const LOCKER_DEFAULTS = [
  { locker_id: 1, size: 'S' },
  { locker_id: 2, size: 'M' },
  { locker_id: 3, size: 'L' },
];

// ---------------------------------------------------------------------------
// In-memory data store
// ---------------------------------------------------------------------------
const db = {
  lockers: new Map(),
  shipments: new Map(),
  otps: new Map(),
  otpSecurity: new Map(),
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
    reserved_at: null,
  };
}

function seedLockers() {
  for (const spec of LOCKER_DEFAULTS) {
    db.lockers.set(spec.locker_id, createLocker(spec.locker_id, spec.size));
  }
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

function clearLockerShipment(locker) {
  locker.shipment_id = null;
  locker.sender_phone = null;
  locker.recipient_phone = null;
  locker.qr_token = null;
  locker.reserved_at = null;
}

function padLcdLine(text) {
  const raw = String(text ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, LCD_WIDTH);
  return raw.padEnd(LCD_WIDTH, ' ');
}

function lockerLcdToken(locker) {
  const label = LCD_STATUS_VI[locker.status] || '????';
  return `N${locker.locker_id}:${label}`;
}

function joinLcdTokens(left, right) {
  const maxGap = LCD_WIDTH - left.length - right.length;
  const gap = Math.max(1, maxGap);
  return `${left}${' '.repeat(gap)}${right}`;
}

function generateLcdPreview() {
  const l1 = db.lockers.get(1);
  const l2 = db.lockers.get(2);
  const l3 = db.lockers.get(3);

  return {
    line1: padLcdLine('--- TU SMART BOX ---'),
    line2: padLcdLine(joinLcdTokens(lockerLcdToken(l1), lockerLcdToken(l2))),
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

async function sendSMSViaAndroid(phone, otp) {
  const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1/messages';
  const USERNAME = process.env.SMS_GATEWAY_USER || '-B-12Y';
  const PASSWORD = process.env.SMS_GATEWAY_PASS || 'xme1yle6eczm2t';

  const authHeader = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

  const payload = {
    phoneNumbers: [phone],
    textMessage: {
      text: `SmartBox: Ma OTP mo tu o cua ban la ${otp}. Ma co hieu luc trong 5 phut.`,
    }
  };

  try {
    const response = await axios.post(SMS_GATEWAY_URL, payload, {
      timeout: 10000,
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
    });

    console.log(`📱 [SMS CLOUD SUCCESS] Đã gửi mã OTP (${otp}) tới SĐT: ${phone}`);
    return { sent: true, status: response.status };
  } catch (error) {
    const detail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`[SMS] Failed to send OTP to ${phone}: ${detail}`);
    return { sent: false, error: detail };
  }
}

function mapFromEntries(entries) {
  return new Map(Array.isArray(entries) ? entries : []);
}

function serializeState() {
  return {
    version: 1,
    saved_at: Date.now(),
    lockers: [...db.lockers.entries()],
    shipments: [...db.shipments.entries()],
    otps: [...db.otps.entries()],
    otpSecurity: [...db.otpSecurity.entries()],
  };
}

function saveStateToFile() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(serializeState(), null, 2), 'utf8');

    for (const [id, locker] of db.lockers.entries()) {
      sqliteDb.run(
        `INSERT INTO lockers (id, status, door_closed, has_item) 
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET 
           status = excluded.status,
           door_closed = excluded.door_closed,
           has_item = excluded.has_item`,
        [id, locker.status, locker.door_closed ? 1 : 0, locker.has_item ? 1 : 0]
      );
    }
  } catch (error) {
    console.error('[STATE] Failed to write state/database:', error.message);
  }
}

function loadStateFromFile() {
  if (!fs.existsSync(STATE_FILE)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const lockers = mapFromEntries(parsed.lockers);
    const shipments = mapFromEntries(parsed.shipments);
    const otps = mapFromEntries(parsed.otps);
    const otpSecurity = mapFromEntries(parsed.otpSecurity);

    for (const spec of LOCKER_DEFAULTS) {
      const loaded = lockers.get(spec.locker_id) || lockers.get(String(spec.locker_id));
      const base = createLocker(spec.locker_id, spec.size);
      db.lockers.set(spec.locker_id, loaded ? { ...base, ...loaded, locker_id: spec.locker_id, size: spec.size } : base);
    }

    db.shipments = shipments;
    db.otps = otps;
    db.otpSecurity = otpSecurity;

    console.log(`[STATE] Restored state.json (${db.lockers.size} lockers, ${db.shipments.size} shipments)`);
    return true;
  } catch (error) {
    console.error('[STATE] Failed to load state.json, using seed data:', error.message);
    seedLockers();
    db.shipments = new Map();
    db.otps = new Map();
    db.otpSecurity = new Map();
    return false;
  }
}

function persistState() {
  saveStateToFile();

  if (!sqliteDb) return;

  for (const [id, locker] of db.lockers.entries()) {
    sqliteDb.run(`
      INSERT INTO lockers (id, status, door_closed, has_item, shipment_id, sender_phone, recipient_phone, qr_token, reserved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, door_closed=excluded.door_closed, has_item=excluded.has_item,
        shipment_id=excluded.shipment_id, sender_phone=excluded.sender_phone,
        recipient_phone=excluded.recipient_phone, qr_token=excluded.qr_token, reserved_at=excluded.reserved_at
    `, [
      locker.locker_id || id,
      locker.status,
      locker.door_closed ? 1 : 0,
      locker.has_item ? 1 : 0,
      locker.shipment_id || null,
      locker.sender_phone || null,
      locker.recipient_phone || null,
      locker.qr_token || null,
      locker.reserved_at || null
    ]);
  }

  for (const [shipment_id, s] of db.shipments.entries()) {
    sqliteDb.run(`
      INSERT INTO shipments (shipment_id, locker_id, sender_phone, recipient_phone, qr_token, status, created_at, occupied_at, completed_at, aborted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shipment_id) DO UPDATE SET
        status=excluded.status, occupied_at=excluded.occupied_at, completed_at=excluded.completed_at, aborted_at=excluded.aborted_at
    `, [
      s.shipment_id,
      s.locker_id,
      s.sender_phone,
      s.recipient_phone,
      s.qr_token,
      s.status || 'PENDING',
      s.created_at,
      s.occupied_at,
      s.completed_at,
      s.aborted_at
    ]);
  }

  for (const [code, otp] of db.otps.entries()) {
    sqliteDb.run(`
      INSERT INTO otps (otp_code, locker_id, shipment_id, recipient_phone, expires_at, used)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(otp_code) DO UPDATE SET used=excluded.used, expires_at=excluded.expires_at
    `, [
      otp.otp_code,
      otp.locker_id,
      otp.shipment_id,
      otp.recipient_phone,
      otp.expires_at,
      otp.used ? 1 : 0
    ]);
  }
}

function getOtpSecurity(phone) {
  if (!db.otpSecurity.has(phone)) {
    db.otpSecurity.set(phone, { failed_attempts: 0, locked_until: 0 });
  }
  return db.otpSecurity.get(phone);
}

function invalidateOtpsForPhone(phone) {
  for (const [key, record] of db.otps.entries()) {
    if (record.recipient_phone === phone) {
      db.otps.delete(key);
    }
  }
}

function purgeExpiredOtps(now = Date.now()) {
  let changed = false;
  for (const [key, record] of db.otps.entries()) {
    if (record.used || record.expires_at <= now) {
      db.otps.delete(key);
      changed = true;
    }
  }
  return changed;
}

function expireReservedLockers(now = Date.now()) {
  let changed = false;

  for (const locker of db.lockers.values()) {
    if (locker.status !== LOCKER_STATUS.RESERVED) continue;

    const reservedAt = locker.reserved_at
      || (locker.shipment_id && db.shipments.get(locker.shipment_id)?.created_at)
      || 0;

    if (!reservedAt || now - reservedAt < RESERVATION_TTL_MS) continue;

    console.log(
      `[RESERVATION] Locker ${locker.locker_id} reservation expired after 10 minutes`
    );

    if (locker.shipment_id && db.shipments.has(locker.shipment_id)) {
      const shipment = db.shipments.get(locker.shipment_id);
      shipment.expired_at = now;
      shipment.status = 'EXPIRED';
    }

    clearLockerShipment(locker);
    applyStatus(locker, LOCKER_STATUS.AVAILABLE);
    changed = true;
  }

  if (changed) persistState();
  return changed;
}

function sweepTransientState() {
  const otpChanged = purgeExpiredOtps();
  const reservedChanged = expireReservedLockers();
  if (otpChanged && !reservedChanged) persistState();
}

loadStateFromFile();
sweepTransientState();

setInterval(() => sweepTransientState(), 15_000).unref();

// ---------------------------------------------------------------------------
// Setup App Locals & Routes
// ---------------------------------------------------------------------------

app.locals.db = db;
app.locals.sqliteDb = sqliteDb;
app.locals.constants = {
  LOCKER_STATUS,
  OTP_TTL_MS,
  RESERVATION_TTL_MS,
  OTP_MAX_FAILURES,
  OTP_LOCKOUT_MS,
  SERVO,
  LCD_WIDTH,
};
app.locals.helpers = {
  applyStatus,
  clearLockerShipment,
  generateLcdPreview,
  generateOtpCode,
  generateQrToken,
  generateShipmentId,
  publicLockerView,
  sendSMSViaAndroid,
  purgeExpiredOtps,
  expireReservedLockers,
  saveStateToFile,
  loadStateFromFile,
  persistState,
  getOtpSecurity,
  invalidateOtpsForPhone,
  padLcdLine,
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
    console.log(`🚀 Smart Box API Gateway listening on port ${PORT}`);
    console.log(`📱 SMS gateway: ${SMS_GATEWAY_URL}`);
    console.log(`💾 State file: ${STATE_FILE}`);
  });
}

module.exports = {
  app,
  db,
  sqliteDb,
  sendSMSViaAndroid,
  generateLcdPreview,
  applyStatus,
  saveStateToFile,
  loadStateFromFile,
  padLcdLine,
  expireReservedLockers,
  LOCKER_STATUS,
  OTP_TTL_MS,
  RESERVATION_TTL_MS,
  OTP_MAX_FAILURES,
  OTP_LOCKOUT_MS,
  STATE_FILE,
};
