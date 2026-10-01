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
// Rate limit config
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false';
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;   // 1 giờ
const RATE_LIMIT_MAX_ATTEMPTS = 5;              // 5 đơn/giờ/SĐT
const rateLimitStore = new Map();               // phone -> [timestamps]
const SMS_GATEWAY_URL = 'http://192.168.1.5:8080/message';
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
// ═══════════════════════════════════════════════════════════
// RETURN-TO-SENDER + EXTENSION CONFIG
// ═══════════════════════════════════════════════════════════
const RETURN_AFTER_HOURS       = Number(process.env.RETURN_AFTER_HOURS) || 24;
const WARNING_BEFORE_HOURS     = Number(process.env.WARNING_BEFORE_HOURS) || 4;
const EXTENSION_HOURS          = Number(process.env.EXTENSION_HOURS) || 24;
const MAX_EXTENSIONS           = Number(process.env.MAX_EXTENSIONS) || 1;
const RETURN_HOLD_HOURS        = Number(process.env.RETURN_HOLD_HOURS) || 48;

const RETURN_AFTER_MS   = RETURN_AFTER_HOURS * 3600 * 1000;
const WARNING_BEFORE_MS = WARNING_BEFORE_HOURS * 3600 * 1000;
const EXTENSION_MS      = EXTENSION_HOURS * 3600 * 1000;
const RETURN_HOLD_MS    = RETURN_HOLD_HOURS * 3600 * 1000;
const RESERVATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_FAILURES = 5;
const OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const LCD_WIDTH = 20;
const STATE_FILE = path.join(__dirname, 'state.json');

const LOCKER_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  PENDING_SENDER: 'PENDING_SENDER',
  RESERVED: 'RESERVED',
  DEPOSITING: 'DEPOSITING',
  OCCUPIED: 'OCCUPIED',
  EXPIRING: 'EXPIRING',               // <-- MỚI: sắp hết hạn
  RETURN_TO_SENDER: 'RETURN_TO_SENDER', // <-- MỚI: chờ sender lấy lại
  RETURN_PICKING: 'RETURN_PICKING',   // <-- MỚI: sender đang mở lấy hàng
  PICKING: 'PICKING',
  MAINTENANCE: 'MAINTENANCE',
});

const LCD_STATUS_VI = Object.freeze({
  AVAILABLE: 'TRONG',
  PENDING_SENDER: 'XAC THUC', 
  RESERVED: 'GIU CHO',
  DEPOSITING: 'DANG GUI',
  OCCUPIED: 'CO HANG',
  EXPIRING: 'SAP HET',              // <-- MỚI
  RETURN_TO_SENDER: 'CHO HOAN',     // <-- MỚI
  RETURN_PICKING: 'DANG HOAN',      // <-- MỚI
  PICKING: 'DANG LAY',
  MAINTENANCE: 'BAO TRI',
});

const SERVO = Object.freeze({
  UNLOCKED: 0,
  LOCKED: 90,
});

// ═══════════════════════════════════════════════════════════
// LOCKER CONFIG — Gán mục đích cho từng ngăn
// ═══════════════════════════════════════════════════════════
const LOCKER_PURPOSE = Object.freeze({
  DEDICATED: 'DEDICATED',   // Dành riêng cho 1 căn hộ
  SHARED:    'SHARED',      // Dùng chung — vãng lai
  HOLDING:   'HOLDING',     // Giữ hàng tồn (nếu cần)
});

// Cấu hình: ngăn nào dành cho ai
// Ngăn 1 → A-501, Ngăn 2 → A-502, Ngăn 3 → Shared
const LOCKER_CONFIG = {
  1: {
    purpose: LOCKER_PURPOSE.DEDICATED,
    apartment: 'A-501',
    owner_phone: null,  // Sẽ tự lookup từ residents
  },
  2: {
    purpose: LOCKER_PURPOSE.DEDICATED,
    apartment: 'A-502',
    owner_phone: null,
  },
  3: {
    purpose: LOCKER_PURPOSE.SHARED,
    apartment: null,
    owner_phone: null,
  },
};

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
  hardware: new Map(),   // <-- THÊM
   // ═══ V2 MỚI ═══
  residents: new Map(),      // SĐT → thông tin cư dân
  shippers: new Map(),        // shipper_code → thông tin shipper
  deliveryLogs: [],           // Mảng log giao hàng
};

function createLocker(lockerId, size) {
  return {
    // ═══ V1 — GIỮ NGUYÊN ═══
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

    // ═══ V2 — THÊM MỚI ═══
    slots: [
      { slot_id: 1, size: 'S', status: 'AVAILABLE', shipment_id: null },
      { slot_id: 2, size: 'M', status: 'AVAILABLE', shipment_id: null },
      { slot_id: 3, size: 'L', status: 'AVAILABLE', shipment_id: null },
    ],
    occupied_slots: 0,
    total_slots: 3,
    available_slots: 3,
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
    case LOCKER_STATUS.PENDING_SENDER:   // <-- THÊM
    case LOCKER_STATUS.RESERVED:
      return { led_color: 'YELLOW', led_blink: true };
    case LOCKER_STATUS.DEPOSITING:
    case LOCKER_STATUS.PICKING:
      return { led_color: 'YELLOW', led_blink: false };
     case LOCKER_STATUS.EXPIRING:                 // <-- MỚI
      return { led_color: 'YELLOW', led_blink: true };
    case LOCKER_STATUS.RETURN_TO_SENDER:         // <-- MỚI
    case LOCKER_STATUS.RETURN_PICKING:           // <-- MỚI
      return { led_color: 'YELLOW', led_blink: true };  
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

    if (status === LOCKER_STATUS.DEPOSITING
      || status === LOCKER_STATUS.PICKING
      || status === LOCKER_STATUS.RETURN_PICKING) {   // <-- MỚI
    locker.servo_angle = SERVO.UNLOCKED;
  } else {
    locker.servo_angle = SERVO.LOCKED;
  }
}
// ═══════════════════════════════════════════════════════════
// V2 SLOT HELPERS
// ═══════════════════════════════════════════════════════════

/**
 * Tìm slot trống đầu tiên trong locker
 * Ưu tiên slot có size khớp với shipment (nếu có)
 */
function findAvailableSlot(locker, preferredSize = null) {
  if (!locker.slots || !Array.isArray(locker.slots)) return null;

  if (preferredSize) {
    const sized = locker.slots.find(s => s.status === 'AVAILABLE' && s.size === preferredSize);
    if (sized) return sized;
  }

  return locker.slots.find(s => s.status === 'AVAILABLE') || null;
}

/**
 * Đánh dấu slot đã có hàng
 */
function occupySlot(locker, slotId, shipmentId) {
  if (!locker.slots) return false;
  const slot = locker.slots.find(s => s.slot_id === slotId);
  if (!slot) return false;

  slot.status = 'OCCUPIED';
  slot.shipment_id = shipmentId;
  syncLockerSlotCounts(locker);
  return true;
}

/**
 * Giải phóng slot
 */
function releaseSlot(locker, slotId) {
  if (!locker.slots) return false;
  const slot = locker.slots.find(s => s.slot_id === slotId);
  if (!slot) return false;

  slot.status = 'AVAILABLE';
  slot.shipment_id = null;
  syncLockerSlotCounts(locker);
  return true;
}

/**
 * Đồng bộ số liệu tổng hợp từ slots
 */
function syncLockerSlotCounts(locker) {
  if (!locker.slots) return;
  const occupied = locker.slots.filter(s => s.status === 'OCCUPIED').length;
  locker.occupied_slots = occupied;
  locker.total_slots = locker.slots.length;
  locker.available_slots = locker.slots.length - occupied;
}

/**
 * Migration — thêm slots[] cho locker cũ (từ state.json version 1)
 */
function migrateLockerToV2(locker) {
  if (!locker.slots) {
    locker.slots = [
      {
        slot_id: 1,
        size: 'S',
        status: locker.status === 'OCCUPIED' ? 'OCCUPIED' : 'AVAILABLE',
        shipment_id: locker.shipment_id || null,
      },
      { slot_id: 2, size: 'M', status: 'AVAILABLE', shipment_id: null },
      { slot_id: 3, size: 'L', status: 'AVAILABLE', shipment_id: null },
    ];
  }
  syncLockerSlotCounts(locker);
  return locker;
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
/**
 * Chuẩn hóa SĐT Việt Nam về dạng quốc tế +84.
 * - "0769259051"   -> "+84769259051"
 * - "84769259051"   -> "+84769259051"
 * - "+84769259051"  -> "+84769259051"
 * - "0769 259 051"  -> "+84769259051"
 * Trả về null nếu không hợp lệ.
 */
function normalizePhoneVN(phone) {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, ''); // bỏ mọi ký tự không phải số

  if (digits.length < 9 || digits.length > 12) return null;

  // Đã có mã quốc tế 84
  if (digits.startsWith('84') && digits.length >= 11) {
    return '+' + digits;
  }
  // SĐT nội địa bắt đầu bằng 0
  if (digits.startsWith('0') && digits.length === 10) {
    return '+84' + digits.slice(1);
  }
  // Trường hợp đã là số mobile 9-10 chữ không có 0 đầu (hiếm)
  if (digits.length === 9) {
    return '+84' + digits;
  }
  return null;
}
// ═══════════════════════════════════════════════════════════
// HARDWARE ONLINE CHECK
// ═══════════════════════════════════════════════════════════
// Trả về true nếu có BẤT KỲ ESP32 nào gửi heartbeat trong 60s qua
function isHardwareOnline() {
  const now = Date.now();
  const timeout = 60 * 1000;  // khớp HEALTH_TIMEOUT_MS
  for (const h of db.hardware.values()) {
    if (now - h.last_seen < timeout) return true;
  }
  return false;
}

// Trả về thông tin chi tiết để frontend dùng
function getHardwareStatus() {
  const now = Date.now();
  const timeout = 60 * 1000;
  const devices = [];

  for (const [id, h] of db.hardware.entries()) {
    const age = now - h.last_seen;
    devices.push({
      device_id: id,
      online: age < timeout,
      age_s: Math.round(age / 1000),
      warnings: h.warnings || [],
    });
  }

  return {
    online: devices.some(d => d.online),
    device_count: devices.length,
    devices,
  };
}
function publicLockerView(locker) {
  const hwOnline = isHardwareOnline();

  const view = {
    locker_id: locker.locker_id,
    size: locker.size,
    status: locker.status,
    door_closed: locker.door_closed,
    has_item: locker.has_item,
    led_color: locker.led_color,
    hardware_online: hwOnline,     // <-- THÊM
     // ═══ V2 MỚI — Slots ═══
    slots: locker.slots || [],
    occupied_slots: locker.occupied_slots || 0,
    total_slots: locker.total_slots || 3,
    available_slots: locker.available_slots || 3,
  };

  if (locker.recipient_phone && locker.status !== LOCKER_STATUS.AVAILABLE) {
    view.recipient_phone = locker.recipient_phone;
  }

  return view;
}

/**
 * Gửi OTP qua SMS Gateway (Cloud hoặc Local đều dùng chung env).
 * Env: SMS_GATEWAY_URL, SMS_GATEWAY_USER, SMS_GATEWAY_PASS
 */
async function sendSMSViaAndroid(phone, otp) {
  const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL || 'https://api.sms-gate.app/3rdparty/v1/messages';
  const USERNAME = process.env.SMS_GATEWAY_USER || '-B-12Y';
  const PASSWORD = process.env.SMS_GATEWAY_PASS || 'xme1yle6eczm2t';

  const authHeader = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

  // Backward-compatible: nếu là OTP 6 số → dùng template cũ
  // Nếu là message đầy đủ → gửi raw
  const messageText = /^\d{6}$/.test(String(otp).trim())
    ? `[SMARTBOX] Ma xac thuc: ${otp}. Hieu luc 5 phut. Hotline: 0356297703(KHUYEN)`
    : String(otp);

  const payload = {
    phoneNumbers: [phone],
    textMessage: { text: messageText },
  };

  try {
    const response = await axios.post(SMS_GATEWAY_URL, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
    });
    console.log(`📱 [SMS] → ${phone} | "${messageText.substring(0, 60)}..."`);
    return { sent: true, status: response.status };
  } catch (error) {
    const detail = error.response
      ? `HTTP ${error.response.status} - ${JSON.stringify(error.response.data)}`
      : error.message;
    console.error(`❌ [SMS] Failed to ${phone}: ${detail}`);
    return { sent: false, error: detail };
  }
}

/**
 * SMS Templates — xây message chuyên nghiệp
 */
function buildSenderOtpMessage(otp, shipmentId, lockerId) {
  const size = { 1: 'S', 2: 'M', 3: 'L' }[lockerId] || '?';
  return `[SMARTBOX] Ma xac thuc GUI HANG: ${otp}\n` +
         `Don: ${shipmentId} | Tu: #${lockerId} (size ${size})\n` +
         `Ma co hieu luc trong 5 phut\n` +
         `Hotline: 0356 297 703 (anh Khuyen)`;
}

function buildRecipientOtpMessage(otp, senderPhone, lockerId) {
  // Mask SĐT sender: +84912345678 → 0912***678
  const masked = (senderPhone || '')
    .replace(/^\+84/, '0')
    .replace(/(\d{4})\d+(\d{3})/, '$1***$2');

  return `[SMARTBOX] Ban co 1 kien hang tu ${masked}.\n` +
         `Vi tri: Tu #${lockerId} - Smart Box\n` +
         `Ma lay hang: ${otp}\n` +
         `Ma co hieu luc trong 5 phut\n` +
         `Hotline: 0356 297 703 (anh Khuyen)`;
}

function buildPickupConfirmMessage(shipmentId, lockerId) {
  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')} ` +
                  `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `[SMARTBOX] Don ${shipmentId} da duoc nguoi nhan lay thanh cong!\n` +
         `Thoi gian: ${dateStr}\n` +
         `Cam on ban da su dung dich vu.`;
}

function buildReminderMessage(otp, lockerId, minutesLeft) {
  return `[SMARTBOX] Nhac nho: Kien hang tai Tu #${lockerId} chua duoc lay.\n` +
         `Ma OTP: ${otp} (con ${minutesLeft} phut)\n` +
         `Vui long den ngay!`;
}

function mapFromEntries(entries) {
  return new Map(Array.isArray(entries) ? entries : []);
}

function serializeState() {
  return {
    version: 2,                 // Đánh dấu V2
    saved_at: Date.now(),
    lockers: [...db.lockers.entries()],
    shipments: [...db.shipments.entries()],
    otps: [...db.otps.entries()],
    otpSecurity: [...db.otpSecurity.entries()],
    // ═══ V2 MỚI ═══
    residents: [...db.residents.entries()],
    shippers: [...db.shippers.entries()],
    deliveryLogs: db.deliveryLogs.slice(-1000),  // Chỉ lưu 1000 log gần nhất
  };
}

function saveStateToFile() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(serializeState(), null, 2), 'utf8');
  } catch (error) {
    console.error('[STATE] Failed to write state.json:', error.message);
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
      const merged = loaded
        ? { ...base, ...loaded, locker_id: spec.locker_id, size: spec.size }
        : base;

      // Migration: thêm slots[] cho locker cũ
      migrateLockerToV2(merged);

      db.lockers.set(spec.locker_id, merged);
    }

    db.shipments = shipments;
    db.otps = otps;
    db.otpSecurity = otpSecurity;
       // ═══ V2 MỚI ═══
    db.residents = mapFromEntries(parsed.residents);
    db.shippers = mapFromEntries(parsed.shippers);
    db.deliveryLogs = Array.isArray(parsed.deliveryLogs) ? parsed.deliveryLogs : [];

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
  // SQLite disabled — chỉ dùng state.json
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
    // <-- SỬA: thêm PENDING_SENDER
    if (locker.status !== LOCKER_STATUS.RESERVED
        && locker.status !== LOCKER_STATUS.PENDING_SENDER) continue;

    const reservedAt = locker.reserved_at
      || (locker.shipment_id && db.shipments.get(locker.shipment_id)?.created_at)
      || 0;

    if (!reservedAt || now - reservedAt < RESERVATION_TTL_MS) continue;

    console.log(
      `[RESERVATION] Locker ${locker.locker_id} (${locker.status}) expired after 10 minutes`
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
// ═══════════════════════════════════════════════════════════
// BACKGROUND JOB: Check deadlines & send warnings
// Chạy mỗi 60 giây
// ═══════════════════════════════════════════════════════════
setInterval(() => checkOccupiedDeadlines(), 60_000).unref();

function checkOccupiedDeadlines() {
  const now = Date.now();
  let changed = false;

  for (const locker of db.lockers.values()) {
    if (!locker.shipment_id || !db.shipments.has(locker.shipment_id)) continue;

    const shipment = db.shipments.get(locker.shipment_id);

    // ═══ Case 1: OCCUPIED — check deadline ═══
    if (locker.status === LOCKER_STATUS.OCCUPIED) {
      const deadline = shipment.deadline_at
        || (shipment.occupied_at || 0) + RETURN_AFTER_MS;

      if (!deadline) continue;

      // Sắp hết hạn → EXPIRING + gửi cảnh báo
      if (now >= deadline - WARNING_BEFORE_MS
          && now < deadline
          && locker.status === LOCKER_STATUS.OCCUPIED) {

        applyStatus(locker, LOCKER_STATUS.EXPIRING);

        // Gửi cảnh báo cho recipient + sender
        const hoursLeft = Math.ceil((deadline - now) / 3600000);
        sendDeadlineWarning(shipment, hoursLeft);

        console.log(`⏰ [DEADLINE] Locker ${locker.locker_id} → EXPIRING (${hoursLeft}h left)`);
        changed = true;
      }

      // Quá hạn → chuyển RETURN_TO_SENDER
      if (now >= deadline) {
        applyStatus(locker, LOCKER_STATUS.RETURN_TO_SENDER);
        shipment.status = 'RETURN_TO_SENDER';
        shipment.return_initiated_at = now;

        // Gửi OTP cho sender để họ lấy hàng về
        sendReturnOtpToSender(locker, shipment);

        console.log(`🔄 [RETURN] Locker ${locker.locker_id} → RETURN_TO_SENDER`);
        changed = true;
      }
    }

    // ═══ Case 2: RETURN_TO_SENDER — check return hold ═══
    if (locker.status === LOCKER_STATUS.RETURN_TO_SENDER) {
      const returnDeadline = shipment.return_initiated_at
        ? shipment.return_initiated_at + RETURN_HOLD_MS
        : now;

      if (now >= returnDeadline) {
        applyStatus(locker, LOCKER_STATUS.MAINTENANCE);
        shipment.status = 'RETURN_EXPIRED';
        console.warn(`🚨 [RETURN] Locker ${locker.locker_id} → MAINTENANCE (sender không đến lấy)`);
        changed = true;
      }
    }

    // ═══ Case 3: EXPIRING → quá deadline rồi vẫn chưa xử lý ═══
    if (locker.status === LOCKER_STATUS.EXPIRING) {
      const deadline = shipment.deadline_at
        || (shipment.occupied_at || 0) + RETURN_AFTER_MS;

      if (now >= deadline) {
        applyStatus(locker, LOCKER_STATUS.RETURN_TO_SENDER);
        shipment.status = 'RETURN_TO_SENDER';
        shipment.return_initiated_at = now;

        sendReturnOtpToSender(locker, shipment);

        console.log(`🔄 [RETURN] Locker ${locker.locker_id} → RETURN_TO_SENDER`);
        changed = true;
      }
    }
  }

  if (changed) persistState();
}

async function sendDeadlineWarning(shipment, hoursLeft) {
  // Gửi cho recipient
  if (shipment.recipient_phone) {
    const msg = `[SMARTBOX] Nhac nho: Kien hang cua ban con ${hoursLeft} gio de lay.\n` +
                `Vi tri: Tu #${shipment.locker_id}\n` +
                `Neu qua han, hang se duoc hoan ve nguoi gui.\n` +
                `Hotline: 0356 297 703`;
    await sendSMSViaAndroid(shipment.recipient_phone, msg);
  }

  // Gửi cho sender (thông báo)
  if (shipment.sender_phone) {
    const msg = `[SMARTBOX] Don ${shipment.shipment_id} chua duoc nhan lay.\n` +
                `Nguoi nhan con ${hoursLeft} gio de den lay.\n` +
                `Sau do hang se duoc hoan ve ban.`;
    await sendSMSViaAndroid(shipment.sender_phone, msg);
  }
}

async function sendReturnOtpToSender(locker, shipment) {
  const otp = generateOtpCode();
  db.otps.set(otp, {
    otp_code: otp,
    otp_type: 'return',
    locker_id: locker.locker_id,
    shipment_id: shipment.shipment_id,
    recipient_phone: shipment.sender_phone,  // gửi cho SENDER
    expires_at: Date.now() + OTP_TTL_MS * 6, // TTL 30 phút cho return
    used: false,
  });

  const msg = `[SMARTBOX] Don ${shipment.shipment_id} chua duoc nguoi nhan lay.\n` +
              `Vui long den Tu #${locker.locker_id} lay lai hang.\n` +
              `Ma xac thuc: ${otp}\n` +
              `Het han sau ${RETURN_HOLD_HOURS} gio.\n` +
              `Hotline: 0356 297 703`;
  await sendSMSViaAndroid(shipment.sender_phone, msg);
}
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
  // ═══ V2 MỚI ═══
  findAvailableSlot,
  occupySlot,
  releaseSlot,
  syncLockerSlotCounts,
  // ... giữ các helper cũ
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
  normalizePhoneVN,
  buildSenderOtpMessage,        // <-- THÊM
  buildRecipientOtpMessage,     // <-- THÊM
  buildPickupConfirmMessage,    // <-- THÊM
  buildReminderMessage,         // <-- THÊM 
  checkRateLimit,   // <-- THÊM
  getRateLimitStatus,
   // ═══ ĐẢM BẢO CÓ 4 DÒNG NÀY ═══
  RETURN_AFTER_MS,
  EXTENSION_HOURS,
  EXTENSION_MS,
  MAX_EXTENSIONS,
  isHardwareOnline,
  getHardwareStatus,
};
// ═══════════════════════════════════════════════════════════
// V2 — SHIPPER REGISTRATION + LOGIN
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/v1/shipper/register
 * Sàn đăng ký shipper (thường do admin sàn gọi)
 */
app.post('/api/v1/shipper/register', (req, res) => {
  try {
    const { shipper_code, phone, name, carrier, carrier_contract_id } = req.body || {};

    if (!shipper_code || !phone || !carrier || !name) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu shipper_code, phone, name hoặc carrier',
      });
    }

    const normalized = normalizePhoneVN(phone);
    if (!normalized) {
      return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
    }

    const code = String(shipper_code).trim().toUpperCase();

    // Check trùng mã
    if (db.shippers.has(code)) {
      return res.status(400).json({
        success: false,
        message: 'Mã shipper đã tồn tại',
      });
    }

    // Check SĐT đã dùng bởi shipper khác chưa
    for (const s of db.shippers.values()) {
      if (s.phone === normalized) {
        return res.status(400).json({
          success: false,
          message: 'SĐT đã đăng ký cho shipper khác',
          existing_code: s.code,
        });
      }
    }

    const shipper = {
      code,
      phone: normalized,
      name: String(name).trim(),
      carrier: String(carrier).trim().toUpperCase(),
      carrier_contract_id: carrier_contract_id || null,
      status: 'ACTIVE',                   // ACTIVE | SUSPENDED | TERMINATED
      registered_at: Date.now(),
      last_login: null,
      total_deliveries: 0,
      total_disputes: 0,
      incidents: [],
    };

    db.shippers.set(code, shipper);
    persistState();

    console.log(`✅ [SHIPPER] Đăng ký: ${code} (${shipper.carrier}) - ${shipper.name}`);

    return res.json({
      success: true,
      message: 'Đăng ký shipper thành công',
      shipper: {
        code: shipper.code,
        name: shipper.name,
        carrier: shipper.carrier,
        status: shipper.status,
      },
    });
  } catch (err) {
    console.error('[SHIPPER REGISTER] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * POST /api/v1/shipper/login
 * Shipper login bằng mã + SĐT
 */
app.post('/api/v1/shipper/login', (req, res) => {
  try {
    const { shipper_code, phone } = req.body || {};

    if (!shipper_code || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu shipper_code hoặc phone',
      });
    }

    const code = String(shipper_code).trim().toUpperCase();
    const shipper = db.shippers.get(code);

    if (!shipper) {
      return res.status(404).json({
        success: false,
        message: 'Mã shipper không tồn tại',
      });
    }

    // ⚠️ RỦI RO CAO — check status trước
    if (shipper.status === 'TERMINATED') {
      console.warn(`🚫 [SHIPPER] Login bị chặn: ${code} đã nghỉ việc`);
      return res.status(403).json({
        success: false,
        message: 'Tài khoản shipper đã bị chấm dứt',
        status: shipper.status,
      });
    }

    if (shipper.status === 'SUSPENDED') {
      return res.status(403).json({
        success: false,
        message: 'Tài khoản shipper đang bị tạm khóa',
        status: shipper.status,
      });
    }

    // ⚠️ RỦI RO CAO — check SĐT khớp
    const normalized = normalizePhoneVN(phone);
    if (!normalized || normalized !== shipper.phone) {
      console.warn(`🚫 [SHIPPER] Login bị chặn: sai SĐT cho ${code}`);
      return res.status(403).json({
        success: false,
        message: 'SĐT không khớp với mã shipper',
      });
    }

    shipper.last_login = Date.now();
    persistState();

    console.log(`✅ [SHIPPER] Login: ${code} (${shipper.carrier})`);

    return res.json({
      success: true,
      message: 'Đăng nhập thành công',
      shipper: {
        code: shipper.code,
        name: shipper.name,
        carrier: shipper.carrier,
        status: shipper.status,
        total_deliveries: shipper.total_deliveries,
      },
    });
  } catch (err) {
    console.error('[SHIPPER LOGIN] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * POST /api/v1/carrier/notify-termination
 * Sàn thông báo shipper nghỉ việc
 */
app.post('/api/v1/carrier/notify-termination', (req, res) => {
  try {
    const { carrier, shipper_code, reason, terminated_at } = req.body || {};

    if (!carrier || !shipper_code) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu carrier hoặc shipper_code',
      });
    }

    const code = String(shipper_code).trim().toUpperCase();
    const shipper = db.shippers.get(code);

    if (!shipper) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy shipper',
      });
    }

    if (shipper.carrier !== String(carrier).trim().toUpperCase()) {
      return res.status(403).json({
        success: false,
        message: 'Sai sàn — không có quyền đánh dấu shipper này',
      });
    }

    shipper.status = 'TERMINATED';
    shipper.terminated_at = terminated_at || Date.now();
    shipper.termination_reason = reason || 'Không rõ';
    persistState();

    console.warn(`🚫 [SHIPPER] Đánh dấu nghỉ việc: ${code} (${carrier})`);

    return res.json({
      success: true,
      message: 'Đã đánh dấu shipper nghỉ việc. Log giao hàng vẫn được giữ để tra cứu.',
      shipper: {
        code: shipper.code,
        status: shipper.status,
        terminated_at: shipper.terminated_at,
      },
    });
  } catch (err) {
    console.error('[CARRIER NOTIFY] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * GET /api/v1/shipper/me?code=GHN-456
 * Lấy thông tin shipper (không cần auth, dùng cho demo)
 */
app.get('/api/v1/shipper/me', (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ success: false, message: 'Thiếu code' });

  const shipper = db.shippers.get(String(code).trim().toUpperCase());
  if (!shipper) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

  return res.json({
    success: true,
    shipper: {
      code: shipper.code,
      name: shipper.name,
      carrier: shipper.carrier,
      status: shipper.status,
      total_deliveries: shipper.total_deliveries,
      registered_at: shipper.registered_at,
      last_login: shipper.last_login,
    },
  });
});
/**
 * POST /api/v1/admin/reset-test-data
 * Xóa toàn bộ shippers + residents để test lại từ đầu
 */
app.post('/api/v1/admin/reset-test-data', (req, res) => {
  const { adminKey, confirm } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';

  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Sai mật khẩu' });
  }

  if (confirm !== 'RESET') {
    return res.status(400).json({
      success: false,
      message: 'Cần gửi confirm: "RESET" để xác nhận',
    });
  }

  const before = {
    shippers: db.shippers.size,
    residents: db.residents.size,
    delivery_logs: db.deliveryLogs?.length || 0,
  };

  db.shippers.clear();
  db.residents.clear();
  if (db.deliveryLogs) db.deliveryLogs = [];

  persistState();

  console.log('🧹 [ADMIN] Reset test data:', before);

  return res.json({
    success: true,
    message: 'Đã xóa toàn bộ shipper + resident',
    deleted: before,
  });
});
/**
 * GET /api/v1/admin/residents
 * Admin xem danh sách cư dân đã đăng ký
 */
app.get('/api/v1/admin/residents', (req, res) => {
  const list = [...db.residents.values()].map(r => ({
    phone: r.phone,
    phone_masked: maskPhone(r.phone),
    name: r.name,
    apartment: r.apartment,
    email: r.email,
    status: r.status,
    registered_at: r.registered_at,
    packages_received: r.packages_received || 0,
    packages_pending: r.packages_pending || 0,
  }));

  list.sort((a, b) => b.registered_at - a.registered_at);

  return res.json({
    success: true,
    residents: list,
    total: list.length,
  });
});
/**
 * POST /api/v1/admin/seed-demo
 * Tạo nhanh data demo: 3 shipper + 2 cư dân
 */
app.post('/api/v1/admin/seed-demo', (req, res) => {
  const { adminKey } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';

  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Sai mật khẩu' });
  }

  const now = Date.now();
  let added = { shippers: 0, residents: 0 };

  // ═══ 3 shipper ═══
  const demoShipPers = [
    { code: 'SPX-001', phone: '+84911111111', name: 'Lê Văn Ship', carrier: 'SHOPEE' },
    { code: 'GHN-001', phone: '+84922222222', name: 'Trần Văn Giao', carrier: 'GHN' },
    { code: 'LZD-001', phone: '+84933333333', name: 'Phạm Văn L', carrier: 'LAZADA' },
  ];

  demoShipPers.forEach(s => {
    if (!db.shippers.has(s.code)) {
      db.shippers.set(s.code, {
        code: s.code,
        phone: s.phone,
        name: s.name,
        carrier: s.carrier,
        carrier_contract_id: null,
        status: 'ACTIVE',
        registered_at: now,
        last_login: null,
        total_deliveries: 0,
        total_disputes: 0,
        incidents: [],
      });
      added.shippers++;
    }
  });

  // ═══ 2 cư dân ═══
  const demoResidents = [
    { phone: '+84769259051', name: 'Nguyễn Văn A', apartment: 'A-501' },
    { phone: '+84912345678', name: 'Trần Thị B', apartment: 'A-502' },
  ];

  demoResidents.forEach(r => {
    if (!db.residents.has(r.phone)) {
      db.residents.set(r.phone, {
        phone: r.phone,
        name: r.name,
        apartment: r.apartment,
        email: null,
        registered_at: now,
        status: 'ACTIVE',
        packages_received: 0,
        packages_pending: 0,
      });
      added.residents++;
    }
  });

  persistState();

  console.log('🌱 [SEED] Demo data created:', added);

  return res.json({
    success: true,
    message: 'Tạo data demo thành công',
    added,
  });
});
/**
 * POST /api/v1/admin/force-seed-demo
 * Xóa shipper + residents cũ, tạo lại data demo sạch
 */
app.post('/api/v1/admin/force-seed-demo', (req, res) => {
  const { adminKey } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';

  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Sai mật khẩu' });
  }

  const now = Date.now();

  // Xóa sạch
  db.shippers.clear();
  db.residents.clear();
  if (db.deliveryLogs) db.deliveryLogs = [];

  // Tạo 3 shipper
  const demoShipPers = [
    { code: 'SPX-001', phone: '+84911111111', name: 'Le Van Ship', carrier: 'SHOPEE' },
    { code: 'GHN-001', phone: '+84922222222', name: 'Tran Van Giao', carrier: 'GHN' },
    { code: 'LZD-001', phone: '+84933333333', name: 'Pham Van L', carrier: 'LAZADA' },
  ];

  demoShipPers.forEach(s => {
    db.shippers.set(s.code, {
      code: s.code,
      phone: s.phone,
      name: s.name,
      carrier: s.carrier,
      carrier_contract_id: null,
      status: 'ACTIVE',
      registered_at: now,
      last_login: null,
      total_deliveries: 0,
      total_disputes: 0,
      incidents: [],
    });
  });

  // Tạo 2 cư dân
  const demoResidents = [
    { phone: '+84769259051', name: 'Nguyen Van A', apartment: 'A-501' },
    { phone: '+84912345678', name: 'Tran Thi B', apartment: 'A-502' },
  ];

  demoResidents.forEach(r => {
    db.residents.set(r.phone, {
      phone: r.phone,
      name: r.name,
      apartment: r.apartment,
      email: null,
      registered_at: now,
      status: 'ACTIVE',
      packages_received: 0,
      packages_pending: 0,
    });
  });

  persistState();

  console.log('🌱 [FORCE SEED] Data reset + seed:', { shippers: 3, residents: 2 });

  return res.json({
    success: true,
    message: 'Đã reset + tạo lại data demo',
    shippers: 3,
    residents: 2,
  });
});
/**
 * GET /api/v1/admin/shippers
 * Admin xem danh sách shipper
 */
app.get('/api/v1/admin/shippers', (req, res) => {
  const list = [...db.shippers.values()].map(s => ({
    code: s.code,
    name: s.name,
    carrier: s.carrier,
    phone_masked: maskPhone(s.phone),
    status: s.status,
    total_deliveries: s.total_deliveries,
    registered_at: s.registered_at,
    last_login: s.last_login,
  }));

  list.sort((a, b) => b.registered_at - a.registered_at);

  return res.json({
    success: true,
    shippers: list,
    total: list.length,
  });
});
// ═══════════════════════════════════════════════════════════
// V2 — MOCK CARRIER ORDERS (giả lập đơn từ sàn)
// ═══════════════════════════════════════════════════════════
const MOCK_CARRIER_ORDERS = {
  'SPXVN001': { carrier: 'SHOPEE', recipient_phone: '+84912345678', apartment: 'A-501', size: 'S' },
  'SPXVN002': { carrier: 'SHOPEE', recipient_phone: '+84769259051', apartment: 'A-502', size: 'M' },
  'LZDVN001': { carrier: 'LAZADA', recipient_phone: '+84912345678', apartment: 'A-501', size: 'M' },
  'GHNVN001': { carrier: 'GHN',    recipient_phone: '+84987654321', apartment: 'B-201', size: 'L' },
  'GHNVN002': { carrier: 'GHN',    recipient_phone: '+84987654321', apartment: 'B-201', size: 'S' },
};

// Trạng thái đơn
const MOCK_ORDER_STATE = new Map(); // order_code -> { status, delivered_at, slot_id, shipper_code, locker_id }

// ═══════════════════════════════════════════════════════════
// V2 — SHIPPER VERIFY (xác minh đơn hàng với sàn)
// ═══════════════════════════════════════════════════════════
app.post('/api/v1/shipper/verify', (req, res) => {
  try {
    const { shipper_code, order_code, locker_id } = req.body || {};

    if (!shipper_code || !order_code) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu shipper_code hoặc order_code',
      });
    }

    // 1. Check shipper tồn tại + ACTIVE
    const shipper = db.shippers.get(String(shipper_code).trim().toUpperCase());
    if (!shipper) {
      return res.status(404).json({ success: false, message: 'Mã shipper không tồn tại' });
    }
    if (shipper.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        message: `Shipper không hoạt động (${shipper.status})`,
      });
    }

    // 2. Check đơn tồn tại
    const orderCode = String(order_code).trim().toUpperCase();
    const order = MOCK_CARRIER_ORDERS[orderCode];
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Đơn hàng không tồn tại trong hệ thống sàn',
      });
    }

    // 3. Check đơn thuộc sàn của shipper
    if (order.carrier !== shipper.carrier) {
      return res.status(403).json({
        success: false,
        message: `Đơn hàng thuộc ${order.carrier}, không phải ${shipper.carrier}`,
      });
    }

    // 4. Check đơn chưa giao
    const orderState = MOCK_ORDER_STATE.get(orderCode);
    if (orderState && orderState.status === 'DELIVERED') {
      return res.status(400).json({
        success: false,
        message: 'Đơn hàng đã được giao',
        delivered_at: orderState.delivered_at,
      });
    }

    // 5. Check người nhận đã đăng ký chưa
    const resident = db.residents.get(order.recipient_phone);
    if (!resident) {
      return res.status(400).json({
        success: false,
        message: 'Người nhận chưa đăng ký dịch vụ. Vui lòng yêu cầu cư dân đăng ký trước.',
        recipient_phone_masked: maskPhone(order.recipient_phone),
      });
    }
    if (resident.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        message: `Tài khoản cư dân không hoạt động (${resident.status})`,
      });
    }

    // 6. Check locker nếu có
    let locker = null;
    if (locker_id) {
      const lid = Number(locker_id);
      locker = db.lockers.get(lid);
      if (!locker) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy tủ' });
      }
      // Check còn slot trống
      const slot = findAvailableSlot(locker);
      if (!slot) {
        return res.status(503).json({
          success: false,
          message: 'Tủ đã đầy. Vui lòng chọn tủ khác.',
          available_slots: 0,
        });
      }
    }

    console.log(`✅ [VERIFY] ${shipper_code} verify đơn ${orderCode} cho ${resident.apartment}`);

    return res.json({
      success: true,
      message: 'Xác minh đơn hàng thành công',
      order: {
        order_code: orderCode,
        carrier: order.carrier,
        size: order.size,
        recipient_apartment: resident.apartment,
        recipient_name: resident.name,
      },
      shipper: {
        code: shipper.code,
        name: shipper.name,
        carrier: shipper.carrier,
      },
      available_slot: locker ? findAvailableSlot(locker) : null,
    });
  } catch (err) {
    console.error('[SHIPPER VERIFY] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════
// V2 — SHIPPER DEPOSIT (bỏ hàng vào slot + ghi log)
// ═══════════════════════════════════════════════════════════
app.post('/api/v1/shipper/deposit', (req, res) => {
  try {
    const { shipper_code, order_code, locker_id } = req.body || {};

    if (!shipper_code || !order_code || !locker_id) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu shipper_code, order_code hoặc locker_id',
      });
    }

    // Verify shipper
    const shipper = db.shippers.get(String(shipper_code).trim().toUpperCase());
    if (!shipper || shipper.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'Shipper không hợp lệ' });
    }

    const orderCode = String(order_code).trim().toUpperCase();
    const order = MOCK_CARRIER_ORDERS[orderCode];
    if (!order) {
      return res.status(404).json({ success: false, message: 'Đơn hàng không tồn tại' });
    }

    if (order.carrier !== shipper.carrier) {
      return res.status(403).json({ success: false, message: 'Đơn không thuộc sàn của shipper' });
    }

    // ⚠️ TÌM NGĂN PHÙ HỢP — ĐÂY LÀ LOGIC MỚI
    const resident = db.residents.get(order.recipient_phone);
    let targetLocker = null;
    let targetSlotId = null;

    if (resident && resident.status === 'ACTIVE') {
      // Cư dân đã đăng ký → tìm ngăn DEDICATED của căn hộ đó
      for (const [lid, config] of Object.entries(LOCKER_CONFIG)) {
        if (config.purpose === 'DEDICATED' && config.apartment === resident.apartment) {
          targetLocker = db.lockers.get(Number(lid));
          targetSlotId = Number(lid);   // Ngăn 1 cho A-501, ngăn 2 cho A-502
          break;
        }
      }
    }

    // Không tìm thấy (vãng lai) → dùng ngăn SHARED
    if (!targetLocker) {
      const sharedLockerId = Object.entries(LOCKER_CONFIG)
        .find(([_, c]) => c.purpose === 'SHARED')?.[0];

      if (sharedLockerId) {
        targetLocker = db.lockers.get(Number(sharedLockerId));
        targetSlotId = Number(sharedLockerId);
      }
    }

    if (!targetLocker || !targetSlotId) {
      return res.status(503).json({ success: false, message: 'Không tìm được ngăn phù hợp' });
    }

    // Check ngăn trống
    const slot = targetLocker.slots.find(s => s.slot_id === targetSlotId);
    if (!slot || slot.status !== 'AVAILABLE') {
      return res.status(503).json({
        success: false,
        message: `Ngăn ${targetSlotId} đã có hàng. Vui lòng thử lại sau.`,
        slot_status: slot ? slot.status : 'unknown',
      });
    }

    // Check đã giao chưa
    const existing = MOCK_ORDER_STATE.get(orderCode);
    if (existing && existing.status === 'DELIVERED') {
      return res.status(400).json({ success: false, message: 'Đơn đã được giao rồi' });
    }

    const now = Date.now();
    const logId = `LOG-${now}-${Math.random().toString(36).substr(2, 6)}`;

    // Đánh dấu slot
    slot.status = 'OCCUPIED';
    slot.shipment_id = orderCode;

    // Update order state
    MOCK_ORDER_STATE.set(orderCode, {
      status: 'DELIVERED',
      delivered_at: now,
      slot_id: targetSlotId,
      locker_id: targetLocker.locker_id,
      shipper_code: shipper.code,
      log_id: logId,
      apartment: resident ? resident.apartment : null,
    });

    // Log
    const logEntry = {
      log_id: logId,
      order_code: orderCode,
      carrier: order.carrier,
      shipper_code: shipper.code,
      shipper_name: shipper.name,
      locker_id: targetLocker.locker_id,
      slot_id: targetSlotId,
      size: order.size,
      recipient_phone: order.recipient_phone,
      recipient_apartment: resident ? resident.apartment : 'Vãng lai',
      resident_name: resident ? resident.name : 'Khách vãng lai',
      delivered_at: now,
      verified_chain: true,
      locker_purpose: LOCKER_CONFIG[targetLocker.locker_id].purpose,
    };

    if (!db.deliveryLogs) db.deliveryLogs = [];
    db.deliveryLogs.push(logEntry);
    if (db.deliveryLogs.length > 1000) {
      db.deliveryLogs = db.deliveryLogs.slice(-1000);
    }

    // Stats
    shipper.total_deliveries += 1;
    if (resident) {
      resident.packages_received = (resident.packages_received || 0) + 1;
      resident.packages_pending = (resident.packages_pending || 0) + 1;
    }

    persistState();

    console.log(`📦 [DEPOSIT] ${shipper.code} → Ngăn ${targetSlotId} (${LOCKER_CONFIG[targetLocker.locker_id].purpose}) — đơn ${orderCode}`);

    return res.json({
      success: true,
      message: 'Ghi nhận giao hàng thành công',
      log: {
        log_id: logId,
        order_code: orderCode,
        locker_id: targetLocker.locker_id,
        slot_id: targetSlotId,
        locker_purpose: LOCKER_CONFIG[targetLocker.locker_id].purpose,
        delivered_at: now,
      },
      resident_notified: !!resident,
    });
  } catch (err) {
    console.error('[SHIPPER DEPOSIT] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════
// V2 — DELIVERY LOGS (bằng chứng tranh chấp)
// ═══════════════════════════════════════════════════════════
app.get('/api/v1/admin/delivery-logs', (req, res) => {
  const { shipper_code, carrier, order_code, from_date, to_date, limit } = req.query;

  let logs = [...(db.deliveryLogs || [])];

  if (shipper_code) logs = logs.filter(l => l.shipper_code === String(shipper_code).toUpperCase());
  if (carrier) logs = logs.filter(l => l.carrier === String(carrier).toUpperCase());
  if (order_code) logs = logs.filter(l => l.order_code === String(order_code).toUpperCase());
  if (from_date) {
    const from = new Date(from_date).getTime();
    logs = logs.filter(l => l.delivered_at >= from);
  }
  if (to_date) {
    const to = new Date(to_date).getTime();
    logs = logs.filter(l => l.delivered_at <= to);
  }

  // Sort mới nhất trước
  logs.sort((a, b) => b.delivered_at - a.delivered_at);

  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sliced = logs.slice(0, lim);

  return res.json({
    success: true,
    logs: sliced,
    total: logs.length,
    showing: sliced.length,
  });
});

// ═══════════════════════════════════════════════════════════
// V2 — ORDER STATE (tra cứu đơn hàng mock)
// ═══════════════════════════════════════════════════════════
app.get('/api/v1/admin/mock-orders', (req, res) => {
  const orders = Object.entries(MOCK_CARRIER_ORDERS).map(([code, info]) => {
    const state = MOCK_ORDER_STATE.get(code);
    const resident = db.residents.get(info.recipient_phone);
    return {
      order_code: code,
      carrier: info.carrier,
      recipient_phone: maskPhone(info.recipient_phone),
      recipient_registered: !!resident,
      apartment: resident ? resident.apartment : null,
      size: info.size,
      status: state ? state.status : 'PENDING',
      delivered_at: state ? state.delivered_at : null,
      slot_id: state ? state.slot_id : null,
    };
  });

  return res.json({
    success: true,
    orders,
    total: orders.length,
  });
});
// ═══════════════════════════════════════════════════════════
// V2 — RESIDENT REGISTRATION
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/v1/resident/request-otp
 * Bước 1: Cư dân nhập SĐT + tên + căn hộ → nhận OTP
 */
app.post('/api/v1/resident/request-otp', async (req, res) => {
  try {
    const { phone, name, apartment, email } = req.body || {};

    // Validate
    if (!phone || !name || !apartment) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu thông tin: phone, name, apartment',
      });
    }

    const normalized = normalizePhoneVN(phone);
    if (!normalized) {
      return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
    }

    // Check đã đăng ký chưa
    const existing = db.residents.get(normalized);
    if (existing && existing.status === 'ACTIVE') {
      return res.status(400).json({
        success: false,
        message: 'SĐT đã đăng ký dịch vụ',
        apartment: existing.apartment,
      });
    }

    // Rate limit: 3 lần/giờ/SĐT
    const now = Date.now();
    const key = 'resident_otp:' + normalized;
    const timestamps = (db._residentRateLimit?.get(key) || []).filter(t => now - t < 3600000);

    if (timestamps.length >= 3) {
      return res.status(429).json({
        success: false,
        message: 'Bạn đã yêu cầu OTP quá nhiều lần. Vui lòng thử lại sau 1 giờ.',
      });
    }

    if (!db._residentRateLimit) db._residentRateLimit = new Map();
    timestamps.push(now);
    db._residentRateLimit.set(key, timestamps);

    // Xóa OTP cũ của SĐT này (nếu có)
    for (const [code, otp] of db.otps.entries()) {
      if (otp.otp_type === 'resident_register' && otp.recipient_phone === normalized) {
        db.otps.delete(code);
      }
    }

    // Sinh OTP mới
    const otp = generateOtpCode();
    db.otps.set(otp, {
      otp_code: otp,
      otp_type: 'resident_register',
      recipient_phone: normalized,
      expires_at: now + OTP_TTL_MS,
      used: false,
      metadata: {
        name: String(name).trim(),
        apartment: String(apartment).trim().toUpperCase(),
        email: email ? String(email).trim() : null,
      },
    });

    // Gửi SMS
    const msg = `[SMARTBOX] Ma xac thuc dang ky dich vu: ${otp}\n` +
                `Can ho: ${apartment}\n` +
                `Hieu luc 5 phut.\n` +
                `Hotline: 0356 297 703`;
    const smsResult = await sendSMSViaAndroid(normalized, msg);

    console.log(`📝 [RESIDENT] OTP gửi tới ${normalized} (${apartment})`);

    return res.json({
      success: true,
      message: smsResult.sent ? 'OTP đã gửi tới SĐT của bạn' : 'Không gửi được SMS',
      otp_sent: smsResult.sent,
      otp_send_error: smsResult.sent ? null : smsResult.error,
      phone_masked: maskPhone(normalized),
    });
  } catch (err) {
    console.error('[RESIDENT OTP] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * POST /api/v1/resident/verify-otp
 * Bước 2: Xác thực OTP → hoàn tất đăng ký
 */
app.post('/api/v1/resident/verify-otp', (req, res) => {
  try {
    const { phone, otp_code } = req.body || {};

    if (!phone || !otp_code) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu phone hoặc otp_code',
      });
    }

    const normalized = normalizePhoneVN(phone);
    if (!normalized) {
      return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
    }

    const code = String(otp_code).trim();
    const now = Date.now();

    // Security check
    const security = getOtpSecurity('resident:' + normalized);
    if (security.locked_until && security.locked_until > now) {
      const retryAfterSec = Math.ceil((security.locked_until - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        success: false,
        message: 'Quá nhiều lần sai. Vui lòng thử lại sau.',
        locked_until: security.locked_until,
      });
    }

    const otpRecord = db.otps.get(code);
    const valid = otpRecord
      && !otpRecord.used
      && otpRecord.otp_type === 'resident_register'
      && otpRecord.recipient_phone === normalized
      && otpRecord.expires_at > now;

    if (!valid) {
      security.failed_attempts += 1;

      if (security.failed_attempts >= OTP_MAX_FAILURES) {
        security.locked_until = now + OTP_LOCKOUT_MS;
        security.failed_attempts = OTP_MAX_FAILURES;
        return res.status(429).json({
          success: false,
          message: 'Quá nhiều lần sai. Khóa 15 phút.',
        });
      }

      return res.status(400).json({
        success: false,
        message: 'OTP không đúng hoặc đã hết hạn',
        remaining_attempts: OTP_MAX_FAILURES - security.failed_attempts,
      });
    }

    // Tạo resident
    const meta = otpRecord.metadata || {};
    const resident = {
      phone: normalized,
      name: meta.name || 'Cư dân',
      apartment: meta.apartment || '—',
      email: meta.email || null,
      registered_at: now,
      status: 'ACTIVE',
      packages_received: 0,
      packages_pending: 0,
    };

    db.residents.set(normalized, resident);

    // Xóa OTP
    otpRecord.used = true;
    db.otps.delete(code);

    // Reset security
    security.failed_attempts = 0;
    security.locked_until = 0;

    persistState();

    console.log(`✅ [RESIDENT] Đăng ký thành công: ${normalized} (${resident.apartment})`);

    return res.json({
      success: true,
      message: 'Đăng ký thành công',
      resident: {
        phone: resident.phone,
        name: resident.name,
        apartment: resident.apartment,
        status: resident.status,
      },
    });
  } catch (err) {
    console.error('[RESIDENT VERIFY] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * GET /api/v1/resident/check?phone=0912345678
 * Check SĐT đã đăng ký chưa
 */
app.get('/api/v1/resident/check', (req, res) => {
  const { phone } = req.query;

  const normalized = normalizePhoneVN(phone);
  if (!normalized) {
    return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
  }

  const resident = db.residents.get(normalized);

  if (!resident) {
    return res.json({
      success: true,
      registered: false,
      message: 'SĐT chưa đăng ký dịch vụ',
    });
  }

  // Mask tên
  const maskedName = resident.name.length > 2
    ? resident.name[0] + '***' + resident.name[resident.name.length - 1]
    : resident.name;

  return res.json({
    success: true,
    registered: true,
    resident: {
      name: maskedName,
      apartment: resident.apartment,
      status: resident.status,
      packages_pending: resident.packages_pending,
    },
  });
});
// ═══════════════════════════════════════════════════════════
// QR CODE GENERATOR (server-side, không phụ thuộc client)
// ═══════════════════════════════════════════════════════════
const QRCode = require('qrcode');

app.get('/api/v1/qr', async (req, res) => {
  try {
    const { data, size, format } = req.query;

    if (!data) {
      return res.status(400).json({
        success: false,
        message: 'Missing "data" query param',
      });
    }

    if (data.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'Data too long (max 500 chars)',
      });
    }

    const qrSize = Math.min(Math.max(Number(size) || 300, 100), 1000);
    const fmt = format === 'png' ? 'png' : 'svg';

    if (fmt === 'svg') {
      const svg = await QRCode.toString(data, {
        type: 'svg',
        width: qrSize,
        margin: 2,
        errorCorrectionLevel: 'H',
        color: { dark: '#0F172A', light: '#FFFFFF' },
      });

      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=86400'); // cache 1 ngày
      return res.send(svg);
    }

    // PNG
    const buffer = await QRCode.toBuffer(data, {
      type: 'png',
      width: qrSize,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#0F172A', light: '#FFFFFF' },
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);

  } catch (err) {
    console.error('[QR] Error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate QR',
    });
  }
});
// ═══════════════════════════════════════════════════════════
// ADMIN — Shipment History
// ═══════════════════════════════════════════════════════════

function maskPhone(phone) {
  if (!phone || phone.length < 8) return phone || '—';
  // +84912345678 → +8491***678
  const head = phone.slice(0, 6);
  const tail = phone.slice(-3);
  return `${head}***${tail}`;
}

app.get('/api/v1/admin/shipments', (req, res) => {
  const { limit = 100, status, locker_id } = req.query;

  let list = [...db.shipments.values()];

  // Sort mới nhất trước
  list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  // Filter theo status
  if (status) {
    list = list.filter(s => s.status === status);
  }

  // Filter theo locker_id
  if (locker_id) {
    const lid = Number(locker_id);
    list = list.filter(s => s.locker_id === lid);
  }

  // Limit
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  list = list.slice(0, lim);

  // Mask SĐT cho privacy
  const masked = list.map(s => ({
    shipment_id: s.shipment_id,
    locker_id: s.locker_id,
    sender_phone_masked: maskPhone(s.sender_phone),
    recipient_phone_masked: maskPhone(s.recipient_phone),
    status: s.status || 'UNKNOWN',
    created_at: s.created_at || null,
    verified_at: s.verified_at || null,
    occupied_at: s.occupied_at || null,
    completed_at: s.completed_at || null,
    aborted_at: s.aborted_at || null,
    cancelled_at: s.cancelled_at || null,
    expired_at: s.expired_at || null,
    duration_s: s.completed_at && s.created_at
      ? Math.round((s.completed_at - s.created_at) / 1000)
      : null,
  }));

  // Stats tổng hợp
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const stats = {
    total: db.shipments.size,
    today: [...db.shipments.values()].filter(s => (s.created_at || 0) >= todayStart).length,
    pending: [...db.shipments.values()].filter(s =>
      ['PENDING_SENDER', 'RESERVED', 'DEPOSITING', 'PENDING'].includes(s.status)).length,
    completed: [...db.shipments.values()].filter(s => s.status === 'COMPLETED').length,
    failed: [...db.shipments.values()].filter(s =>
      ['ABORTED', 'EXPIRED', 'CANCELLED', 'FAILED_VERIFY'].includes(s.status)).length,
  };

  return res.json({
    success: true,
    shipments: masked,
    stats,
    filters: { status: status || null, locker_id: locker_id || null, limit: lim },
  });
});
// ═══════════════════════════════════════════════════════════
// HARDWARE HEALTH MONITORING
// ═══════════════════════════════════════════════════════════
const HEALTH_TIMEOUT_MS = 60000;  // 60s không heartbeat = offline

/**
 * POST /api/v1/telemetry/health
 * ESP32 gửi định kỳ 30s
 */
app.post('/api/v1/telemetry/health', (req, res) => {
  try {
    const {
      device_id,
      uptime_s,
      wifi_rssi,
      free_ram,
      sensors,
      warnings,
      boot_self_test,
    } = req.body || {};

    if (!device_id) {
      return res.status(400).json({
        success: false,
        message: 'device_id is required',
      });
    }

    const now = Date.now();
    const prev = db.hardware.get(device_id);

    // Merge boot_self_test: giữ lần gần nhất nếu có, không xóa
    const selfTest = boot_self_test || (prev && prev.boot_self_test) || null;

    const report = {
      device_id,
      last_seen: now,
      first_seen: prev ? prev.first_seen : now,
      uptime_s: uptime_s || 0,
      wifi_rssi: wifi_rssi || -100,
      free_ram: free_ram || 0,
      sensors: sensors || {},
      warnings: warnings || [],
      boot_self_test: selfTest,
      heartbeat_count: prev ? (prev.heartbeat_count || 0) + 1 : 1,
      online: true,
    };

    db.hardware.set(device_id, report);

    console.log(`[HEALTH] ${device_id} · RSSI=${wifi_rssi}dBm · RAM=${Math.round(free_ram / 1024)}KB · Warns=${report.warnings.length}`);

    return res.status(200).json({
      success: true,
      message: 'Health recorded',
      next_heartbeat_s: 30,
    });
  } catch (err) {
    console.error('[HEALTH] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * GET /api/v1/admin/hardware-health
 * Trả về tất cả device đã đăng ký
 */
app.get('/api/v1/admin/hardware-health', (req, res) => {
  const now = Date.now();
  const list = [];

  for (const [id, h] of db.hardware.entries()) {
    const age = now - h.last_seen;
    const online = age < HEALTH_TIMEOUT_MS;
    const lastSeenDate = new Date(h.last_seen);

    // Format last_seen
    const hh = String(lastSeenDate.getHours()).padStart(2, '0');
    const mm = String(lastSeenDate.getMinutes()).padStart(2, '0');
    const lastSeenTime = `${hh}:${mm}`;

    // State rõ ràng
    let state = 'ONLINE';
    if (age > HEALTH_TIMEOUT_MS * 3) state = 'OFFLINE';       // > 3 phút
    else if (age > HEALTH_TIMEOUT_MS) state = 'STALE';        // 1-3 phút

    // Chẩn đoán
    const diagnosis = [];
    if (!online) {
      diagnosis.push(`Thiết bị không gửi heartbeat từ ${lastSeenTime}`);
      diagnosis.push('Nguyên nhân có thể: mất WiFi · mất điện · ESP32 treo');
    } else {
      if (h.wifi_rssi < -80) diagnosis.push(`WiFi yếu (${h.wifi_rssi} dBm < -80)`);
      else if (h.wifi_rssi < -70) diagnosis.push(`WiFi trung bình (${h.wifi_rssi} dBm)`);

      if (h.free_ram < 20000) diagnosis.push(`RAM thấp (${Math.round(h.free_ram/1024)} KB < 20 KB)`);
      else if (h.free_ram < 50000) diagnosis.push(`RAM trung bình (${Math.round(h.free_ram/1024)} KB)`);

      if (h.warnings && h.warnings.length) {
        h.warnings.forEach(w => diagnosis.push(`Sensor: ${w}`));
      }

      if (h.boot_self_test && h.boot_self_test.failed > 0) {
        diagnosis.push(`Boot self-test: ${h.boot_self_test.failed} module lỗi`);
      }

      if (diagnosis.length === 0) {
        diagnosis.push('Không phát hiện vấn đề');
      }
    }

    // Age display
    let ageDisplay;
    if (age < 60000) ageDisplay = `${Math.round(age / 1000)}s trước`;
    else if (age < 3600000) ageDisplay = `${Math.round(age / 60000)} phút trước`;
    else ageDisplay = `${Math.round(age / 3600000)} giờ trước`;

    list.push({
      device_id: id,
      online,
      state,                        // ONLINE | STALE | OFFLINE
      last_seen_ago_s: Math.round(age / 1000),
      last_seen_time: lastSeenTime, // "14:35"
      last_seen_ago_display: ageDisplay,
      data_is_fresh: online,        // chỉ true khi vừa nhận heartbeat

      uptime_s: h.uptime_s,
      wifi_rssi: h.wifi_rssi,
      free_ram_kb: Math.round(h.free_ram / 1024),
      sensors: h.sensors,
      warnings: h.warnings,
      boot_self_test: h.boot_self_test,
      heartbeat_count: h.heartbeat_count,
      first_seen: h.first_seen,
      health_score: calcHealthScore(h, online),
      diagnosis,                    // MỚI
    });
  }

  list.sort((a, b) => a.device_id.localeCompare(b.device_id));

  return res.json({
    success: true,
    devices: list,
    total: list.length,
    online: list.filter(d => d.online).length,
    warnings_total: list.reduce((s, d) => s + d.warnings.length, 0),
    server_time: now,
  });
});

/**
 * POST /api/v1/admin/clear-hardware
 * Xóa hết device (dùng khi test)
 */
app.post('/api/v1/admin/clear-hardware', (req, res) => {
  const { adminKey } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';
  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Sai mật khẩu' });
  }
  db.hardware.clear();
  return res.json({ success: true, message: 'Đã xóa toàn bộ hardware log' });
});

/**
 * Helper: tính health score 0-100
 */
function calcHealthScore(h, online) {
  if (!online) return 0;

  let score = 100;

  // WiFi yếu
  if (h.wifi_rssi < -80) score -= 20;
  else if (h.wifi_rssi < -70) score -= 10;

  // RAM thấp
  if (h.free_ram < 20000) score -= 30;
  else if (h.free_ram < 50000) score -= 15;

  // Warnings
  score -= h.warnings.length * 15;

  // Boot self-test failed
  if (h.boot_self_test && h.boot_self_test.failed > 0) {
    score -= h.boot_self_test.failed * 10;
  }

  return Math.max(0, Math.min(100, score));
}

// Auto-mark offline mỗi 10s — chỉ để log
setInterval(() => {
  const now = Date.now();
  for (const [id, h] of db.hardware.entries()) {
    const wasOnline = h.online;
    const isOnline = (now - h.last_seen) < HEALTH_TIMEOUT_MS;
    if (wasOnline && !isOnline) {
      console.warn(`⚠️  [HEALTH] ${id} went OFFLINE (last seen ${Math.round((now - h.last_seen) / 1000)}s ago)`);
    }
    h.online = isOnline;
  }
}, 10000).unref();
// ═══════════════════════════════════════════════════════════
// RATE LIMIT (cho /shipments/create)
// ═══════════════════════════════════════════════════════════

function checkRateLimit(phone) {
  if (!RATE_LIMIT_ENABLED) return { allowed: true, bypassed: true };

  const now = Date.now();
  const arr = (rateLimitStore.get(phone) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  if (arr.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    const oldest = arr[0];
    const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000);
    return { allowed: false, retryAfterSec, used: arr.length };
  }

  arr.push(now);
  rateLimitStore.set(phone, arr);
  return { allowed: true, remaining: RATE_LIMIT_MAX_ATTEMPTS - arr.length };
}

/**
 * Admin: bật/tắt rate limit runtime
 * POST /api/v1/admin/rate-limit  { adminKey, enabled }
 */
let rateLimitRuntimeOverride = null;  // null = dùng env

app.post('/api/v1/admin/rate-limit', (req, res) => {
  const { adminKey, enabled } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';

  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Sai mật khẩu' });
  }

  if (typeof enabled === 'boolean') {
    rateLimitRuntimeOverride = enabled;
    console.log(`[RATE LIMIT] Runtime override: ${enabled ? 'ON' : 'OFF'}`);
  } else {
    rateLimitRuntimeOverride = null;
    console.log('[RATE LIMIT] Reset về mặc định env');
  }

  return res.json({
    success: true,
    enabled: getRateLimitStatus(),
    env_default: RATE_LIMIT_ENABLED,
    runtime_override: rateLimitRuntimeOverride,
  });
});

function getRateLimitStatus() {
  if (rateLimitRuntimeOverride !== null) return rateLimitRuntimeOverride;
  return RATE_LIMIT_ENABLED;
}
// ═══════════════════════════════════════════════════════════
// SHIPMENT ARCHIVE + CLEANUP
// ═══════════════════════════════════════════════════════════
const ARCHIVE_FILE = path.join(__dirname, 'archived_shipments.json');
const ARCHIVE_AFTER_MS = 7 * 24 * 3600 * 1000;   // Archive sau 7 ngày
const ARCHIVE_TERMINAL_STATES = ['COMPLETED', 'ABORTED', 'EXPIRED', 'CANCELLED', 'FAILED_VERIFY'];

/**
 * Ghi shipments vào archive file (append)
 */
function archiveShipments(shipments) {
  if (!shipments.length) return;

  try {
    let existing = [];
    if (fs.existsSync(ARCHIVE_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
        if (!Array.isArray(existing)) existing = [];
      } catch (e) { existing = []; }
    }

    existing.push(...shipments.map(s => ({
      ...s,
      archived_at: Date.now(),
    })));

    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(existing, null, 2), 'utf8');
    console.log(`[ARCHIVE] Saved ${shipments.length} shipments → archive (total: ${existing.length})`);
  } catch (err) {
    console.error('[ARCHIVE] Failed:', err.message);
  }
}

/**
 * Cleanup: archive + xóa khỏi memory
 */
function cleanupOldShipments() {
  const now = Date.now();
  const toArchive = [];

  for (const [id, s] of db.shipments.entries()) {
    const age = now - (s.created_at || 0);
    if (age > ARCHIVE_AFTER_MS && ARCHIVE_TERMINAL_STATES.includes(s.status)) {
      toArchive.push(s);
    }
  }

  if (!toArchive.length) return 0;

  // 1. Archive vào file
  archiveShipments(toArchive);

  // 2. Xóa khỏi memory
  for (const s of toArchive) {
    db.shipments.delete(s.shipment_id);
  }

  console.log(`[CLEANUP] Removed ${toArchive.length} old shipments from memory (archived safely)`);
  return toArchive.length;
}

// Chạy cleanup mỗi 6 giờ
setInterval(cleanupOldShipments, 6 * 3600 * 1000).unref();

/**
 * Admin: xem archive
 * GET /api/v1/admin/shipments/archive?limit=50
 */
app.get('/api/v1/admin/shipments/archive', (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVE_FILE)) {
      return res.json({ success: true, shipments: [], total: 0 });
    }

    const all = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const sorted = all.sort((a, b) => (b.archived_at || 0) - (a.archived_at || 0));
    const sliced = sorted.slice(0, limit);

    return res.json({
      success: true,
      shipments: sliced,
      total: all.length,
      showing: sliced.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Admin: force cleanup ngay
 */
app.post('/api/v1/admin/cleanup', (req, res) => {
  const { adminKey } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';

  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Sai mật khẩu' });
  }

  const count = cleanupOldShipments();
  return res.json({
    success: true,
    archived: count,
    remaining_in_memory: db.shipments.size,
  });
});
/**
 * GET status
 */
app.get('/api/v1/admin/rate-limit', (req, res) => {
  return res.json({
    success: true,
    enabled: getRateLimitStatus(),
    env_default: RATE_LIMIT_ENABLED,
    runtime_override: rateLimitRuntimeOverride,
    window_minutes: RATE_LIMIT_WINDOW_MS / 60000,
    max_per_window: RATE_LIMIT_MAX_ATTEMPTS,
    active_phones: rateLimitStore.size,
  });
});

// Override checkRateLimit để dùng getRateLimitStatus()
const _originalCheckRateLimit = checkRateLimit;
checkRateLimit = function(phone) {
  if (!getRateLimitStatus()) return { allowed: true, bypassed: true };
  return _originalCheckRateLimit(phone);
};
// ═══════════════════════════════════════════════════════════
// EXTENSION — Sender gia hạn deadline
// ═══════════════════════════════════════════════════════════
app.post('/api/v1/shipments/extend', async (req, res) => {
  try {
    const { shipment_id, sender_phone, otp_code } = req.body || {};

    if (!shipment_id || !sender_phone || !otp_code) {
      return res.status(400).json({
        success: false,
        message: 'shipment_id, sender_phone, otp_code required',
      });
    }

    const shipment = db.shipments.get(shipment_id);
    if (!shipment) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' });
    }

    const normalized = normalizePhoneVN(sender_phone);
    if (normalized !== shipment.sender_phone) {
      return res.status(403).json({ success: false, message: 'SĐT không khớp người gửi' });
    }

    // Verify OTP
    const otpRecord = db.otps.get(otp_code);
    const valid = otpRecord
      && !otpRecord.used
      && otpRecord.recipient_phone === normalized
      && otpRecord.otp_type === 'extension'
      && otpRecord.shipment_id === shipment_id
      && otpRecord.expires_at > Date.now();

    if (!valid) {
      return res.status(400).json({ success: false, message: 'OTP không đúng' });
    }

    // Check max extension
    const count = shipment.extension_count || 0;
    if (count >= MAX_EXTENSIONS) {
      return res.status(400).json({
        success: false,
        message: `Chỉ được gia hạn tối đa ${MAX_EXTENSIONS} lần`,
      });
    }

    // Check state
    const locker = db.lockers.get(shipment.locker_id);
    if (!locker || ![LOCKER_STATUS.OCCUPIED, LOCKER_STATUS.EXPIRING].includes(locker.status)) {
      return res.status(400).json({
        success: false,
        message: 'Tủ không ở trạng thái có thể gia hạn',
      });
    }

    // Extend
    const oldDeadline = shipment.deadline_at || Date.now();
    shipment.deadline_at = oldDeadline + EXTENSION_MS;
    shipment.extension_count = count + 1;
    shipment.extended_at = Date.now();

    // Reset state về OCCUPIED nếu đang EXPIRING
    if (locker.status === LOCKER_STATUS.EXPIRING) {
      applyStatus(locker, LOCKER_STATUS.OCCUPIED);
    }

    otpRecord.used = true;
    db.otps.delete(otp_code);

    persistState();

    // Thông báo cho recipient
    const msg = `[SMARTBOX] Nguoi gui da gia han them ${EXTENSION_HOURS}h.\n` +
                `Ban co den ${new Date(shipment.deadline_at).toLocaleString('vi-VN')} de lay hang.\n` +
                `Don ${shipment.shipment_id} - Tu #${locker.locker_id}`;
    sendSMSViaAndroid(shipment.recipient_phone, msg);

    return res.json({
      success: true,
      message: `Đã gia hạn thêm ${EXTENSION_HOURS} giờ`,
      new_deadline_at: shipment.deadline_at,
      extension_count: shipment.extension_count,
      max_extensions: MAX_EXTENSIONS,
    });
  } catch (err) {
    console.error('[EXTEND] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * POST /api/v1/shipments/request-extension-otp
 * Sender bấm "Gia hạn" → hệ thống gửi OTP cho sender
 */
app.post('/api/v1/shipments/request-extension-otp', async (req, res) => {
  try {
    const { shipment_id } = req.body || {};
    if (!shipment_id) {
      return res.status(400).json({ success: false, message: 'shipment_id required' });
    }

    const shipment = db.shipments.get(shipment_id);
    if (!shipment) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' });
    }

    const locker = db.lockers.get(shipment.locker_id);
    if (!locker || ![LOCKER_STATUS.OCCUPIED, LOCKER_STATUS.EXPIRING].includes(locker.status)) {
      return res.status(400).json({
        success: false,
        message: 'Tủ không ở trạng thái có thể gia hạn',
      });
    }

    const count = shipment.extension_count || 0;
    if (count >= MAX_EXTENSIONS) {
      return res.status(400).json({
        success: false,
        message: `Chỉ được gia hạn tối đa ${MAX_EXTENSIONS} lần`,
      });
    }

    // Gửi OTP cho sender
    const otp = generateOtpCode();
    db.otps.set(otp, {
      otp_code: otp,
      otp_type: 'extension',
      locker_id: locker.locker_id,
      shipment_id,
      recipient_phone: shipment.sender_phone,
      expires_at: Date.now() + OTP_TTL_MS,
      used: false,
    });

    const msg = `[SMARTBOX] Ma xac thuc GIA HAN: ${otp}\n` +
                `Don ${shipment.shipment_id} - Tu #${locker.locker_id}\n` +
                `Hieu luc 5 phut.\n` +
                `Hotline: 0356 297 703`;
    await sendSMSViaAndroid(shipment.sender_phone, msg);

    return res.json({
      success: true,
      message: 'OTP gia hạn đã gửi tới SĐT người gửi',
      sender_phone_masked: maskPhone(shipment.sender_phone),
    });
  } catch (err) {
    console.error('[EXTEND OTP] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/**
 * POST /api/v1/shipments/verify-return-otp
 * Sender nhập OTP để mở tủ lấy lại hàng hoàn
 */
app.post('/api/v1/shipments/verify-return-otp', async (req, res) => {
  try {
    const { sender_phone, otp_code } = req.body || {};

    if (!sender_phone || !otp_code) {
      return res.status(400).json({ success: false, message: 'sender_phone và otp_code required' });
    }

    const phone = normalizePhoneVN(sender_phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
    }

    const otpRecord = db.otps.get(otp_code.trim());
    const valid = otpRecord
      && !otpRecord.used
      && otpRecord.otp_type === 'return'
      && otpRecord.recipient_phone === phone
      && otpRecord.expires_at > Date.now();

    if (!valid) {
      return res.status(400).json({ success: false, message: 'OTP không đúng hoặc hết hạn' });
    }

    const locker = db.lockers.get(otpRecord.locker_id);
    if (!locker || locker.status !== LOCKER_STATUS.RETURN_TO_SENDER) {
      return res.status(400).json({
        success: false,
        message: 'Tủ không ở trạng thái chờ hoàn',
        current_status: locker ? locker.status : null,
      });
    }

    otpRecord.used = true;
    db.otps.delete(otp_code);

    applyStatus(locker, LOCKER_STATUS.RETURN_PICKING);
    persistState();

    return res.json({
      success: true,
      action: 'UNLOCK_SERVO',
      locker_id: locker.locker_id,
      message: 'Đã mở tủ. Vui lòng lấy hàng và đóng cửa.',
    });
  } catch (err) {
    console.error('[VERIFY RETURN] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});
// ═══════════════════════════════════════════════════════════
// V2 — RESIDENT PICKUP (Cư dân nhận hàng TMĐT)
// ═══════════════════════════════════════════════════════════

app.post('/api/v1/resident/request-pickup', async (req, res) => {
  try {
    const { recipient_phone } = req.body || {};

    const phone = normalizePhoneVN(recipient_phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
    }

    const resident = db.residents.get(phone);
    if (!resident || resident.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: 'SĐT chưa đăng ký' });
    }

    // Tìm ngăn DEDICATED của cư dân này
    let targetLocker = null;
    for (const [lid, config] of Object.entries(LOCKER_CONFIG)) {
      if (config.purpose === 'DEDICATED' && config.apartment === resident.apartment) {
        const locker = db.lockers.get(Number(lid));
        const slot = locker.slots.find(s => s.slot_id === Number(lid));
        if (slot && slot.status === 'OCCUPIED') {
          targetLocker = locker;
          break;
        }
      }
    }

    if (!targetLocker) {
      return res.status(404).json({ success: false, message: 'Không có hàng chờ nhận' });
    }

    const otp = generateOtpCode();
    db.otps.set(otp, {
      otp_code: otp,
      otp_type: OTP_TYPES.RECIPIENT_CARRIER,
      locker_id: targetLocker.locker_id,
      shipment_id: targetLocker.slots.find(s => s.slot_id === targetLocker.locker_id)?.shipment_id,
      recipient_phone: phone,
      expires_at: Date.now() + OTP_TTL_MS,
      used: false,
    });

    const msg = `[SMARTBOX] Ma lay hang: ${otp}\nNgan: ${targetLocker.locker_id}\nHieu luc 5 phut.`;
    await sendSMSViaAndroid(phone, msg);
    persistState();

    return res.json({
      success: true,
      message: 'OTP đã gửi tới SĐT của bạn',
      locker_id: targetLocker.locker_id,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

app.post('/api/v1/resident/verify-pickup', (req, res) => {
  try {
    const { recipient_phone, otp_code } = req.body || {};

    const phone = normalizePhoneVN(recipient_phone);
    if (!phone) {
      return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
    }

    const code = String(otp_code).trim();
    const otpRecord = db.otps.get(code);
    const now = Date.now();

    const valid = otpRecord
      && !otpRecord.used
      && otpRecord.otp_type === OTP_TYPES.RECIPIENT_CARRIER
      && otpRecord.recipient_phone === phone
      && otpRecord.expires_at > now;

    if (!valid) {
      return res.status(400).json({ success: false, message: 'OTP không đúng' });
    }

    const locker = db.lockers.get(otpRecord.locker_id);
    if (!locker) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy ngăn' });
    }

    otpRecord.used = true;
    db.otps.delete(code);
    persistState();

    return res.json({
      success: true,
      action: 'UNLOCK_SERVO',
      locker_id: locker.locker_id,
      slot_id: locker.locker_id,
      message: 'Đã mở ngăn. Vui lòng lấy hàng và đóng cửa.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});
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
