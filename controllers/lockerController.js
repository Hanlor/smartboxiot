/**
 * Locker business logic and edge-case handling for the 3-compartment Smart Box.
 */

function getCtx(req) {
  return {
    db: req.app.locals.db,
    helpers: req.app.locals.helpers,
    constants: req.app.locals.constants,
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseLockerId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > 3) return null;
  return id;
}

function parseBoolean(value, field) {
  if (typeof value === 'boolean') return { ok: true, value };
  return { ok: false, message: `${field} must be a boolean` };
}

function lockoutResponse(res, lockedUntil) {
  const retryAfterSec = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
  res.set('Retry-After', String(retryAfterSec));
  return res.status(429).json({
    success: false,
    message: 'Too many failed OTP attempts. Recipient is locked out for 15 minutes.',
    locked_until: lockedUntil,
    retry_after_seconds: retryAfterSec,
  });
}

/**
 * GET /api/v1/lockers
 */
function getLockers(req, res) {
  const { db, helpers } = getCtx(req);
  helpers.expireReservedLockers();

  const lockers = [1, 2, 3].map((id) => helpers.publicLockerView(db.lockers.get(id)));

  return res.status(200).json({
    success: true,
    lockers,
    lcd_preview: helpers.generateLcdPreview(),
  });
}

/**
 * POST /api/v1/shipments/create
 * Reserve an AVAILABLE locker and issue a QR token for deposit.
 */
function createShipment(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { sender_phone, recipient_phone, locker_id } = req.body || {};

  helpers.expireReservedLockers();

  if (!isNonEmptyString(sender_phone) || !isNonEmptyString(recipient_phone)) {
    return res.status(400).json({
      success: false,
      message: 'sender_phone and recipient_phone are required strings',
    });
  }

  const lockerId = parseLockerId(locker_id);
  if (!lockerId) {
    return res.status(400).json({
      success: false,
      message: 'locker_id must be 1, 2, or 3',
    });
  }

  const locker = db.lockers.get(lockerId);

  if (locker.status === constants.LOCKER_STATUS.MAINTENANCE) {
    return res.status(400).json({
      success: false,
      message: 'Locker is in maintenance and cannot be reserved',
    });
  }

  if (locker.status !== constants.LOCKER_STATUS.AVAILABLE) {
    return res.status(400).json({
      success: false,
      message: 'Locker is occupied or otherwise unavailable',
      current_status: locker.status,
    });
  }

  if (!locker.door_closed) {
    return res.status(400).json({
      success: false,
      message: 'Locker door must be closed before reservation',
    });
  }

  if (locker.has_item) {
    helpers.applyStatus(locker, constants.LOCKER_STATUS.MAINTENANCE);
    helpers.persistState();
    return res.status(400).json({
      success: false,
      message: 'Sensor reports an item in an AVAILABLE locker; locker set to MAINTENANCE',
    });
  }

  const shipment_id = helpers.generateShipmentId();
  const qr_token = helpers.generateQrToken();
  const now = Date.now();

  const shipment = {
    shipment_id,
    locker_id: lockerId,
    sender_phone: sender_phone.trim(),
    recipient_phone: recipient_phone.trim(),
    qr_token,
    created_at: now,
    occupied_at: null,
    completed_at: null,
  };

  db.shipments.set(shipment_id, shipment);

  locker.shipment_id = shipment_id;
  locker.sender_phone = shipment.sender_phone;
  locker.recipient_phone = shipment.recipient_phone;
  locker.qr_token = qr_token;
  locker.reserved_at = now;
  helpers.applyStatus(locker, constants.LOCKER_STATUS.RESERVED);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    shipment_id,
    qr_token,
    message: 'Ô đã được giữ chỗ',
  });
}

/**
 * POST /api/v1/shipments/open-deposit
 * Validate QR token and unlock servo for deposit.
 */
function openDeposit(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { locker_id, qr_token } = req.body || {};

  helpers.expireReservedLockers();

  const lockerId = parseLockerId(locker_id);
  if (!lockerId) {
    return res.status(400).json({
      success: false,
      message: 'locker_id must be 1, 2, or 3',
    });
  }

  if (!isNonEmptyString(qr_token)) {
    return res.status(400).json({
      success: false,
      message: 'qr_token is required',
    });
  }

  const locker = db.lockers.get(lockerId);

  if (locker.status !== constants.LOCKER_STATUS.RESERVED) {
    return res.status(400).json({
      success: false,
      message: 'Locker is not reserved for deposit',
      current_status: locker.status,
    });
  }

  if (locker.qr_token !== qr_token.trim()) {
    return res.status(400).json({
      success: false,
      message: 'Invalid QR token for this locker',
    });
  }

  helpers.applyStatus(locker, constants.LOCKER_STATUS.DEPOSITING);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    action: 'UNLOCK_SERVO',
    locker_id: lockerId,
  });
}

/**
 * POST /api/v1/shipments/verify-otp
 * Validate recipient OTP (6-digit, 5-minute TTL) and unlock for pickup.
 * 5 failed attempts per phone invalidate the OTP and lock out for 15 minutes (429).
 */
function verifyOtp(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { recipient_phone, otp_code } = req.body || {};

  if (!isNonEmptyString(recipient_phone) || !isNonEmptyString(otp_code)) {
    return res.status(400).json({
      success: false,
      message: 'recipient_phone and otp_code are required',
    });
  }

  helpers.purgeExpiredOtps();

  const phone = recipient_phone.trim();
  const code = otp_code.trim();
  const now = Date.now();
  const security = helpers.getOtpSecurity(phone);

  if (security.locked_until && security.locked_until > now) {
    return lockoutResponse(res, security.locked_until);
  }

  if (security.locked_until && security.locked_until <= now) {
    security.locked_until = 0;
    security.failed_attempts = 0;
  }

  const otpRecord = db.otps.get(code);
  const otpValid = Boolean(
    otpRecord
    && !otpRecord.used
    && otpRecord.recipient_phone === phone
    && otpRecord.expires_at > now
  );

  if (!otpValid) {
    security.failed_attempts += 1;

    if (security.failed_attempts >= constants.OTP_MAX_FAILURES) {
      helpers.invalidateOtpsForPhone(phone);
      security.failed_attempts = constants.OTP_MAX_FAILURES;
      security.locked_until = now + constants.OTP_LOCKOUT_MS;
      helpers.persistState();
      return lockoutResponse(res, security.locked_until);
    }

    helpers.persistState();

    const expired = otpRecord
      && otpRecord.recipient_phone === phone
      && otpRecord.expires_at <= now;

    if (expired) {
      db.otps.delete(code);
      helpers.persistState();
      return res.status(404).json({
        success: false,
        message: 'OTP expired',
        remaining_attempts: constants.OTP_MAX_FAILURES - security.failed_attempts,
      });
    }

    return res.status(404).json({
      success: false,
      message: 'OTP not found',
      remaining_attempts: constants.OTP_MAX_FAILURES - security.failed_attempts,
    });
  }

  const locker = db.lockers.get(otpRecord.locker_id);
  if (!locker || locker.status !== constants.LOCKER_STATUS.OCCUPIED) {
    return res.status(400).json({
      success: false,
      message: 'Associated locker is not ready for pickup',
      current_status: locker ? locker.status : null,
    });
  }

  otpRecord.used = true;
  db.otps.delete(code);
  security.failed_attempts = 0;
  security.locked_until = 0;
  helpers.applyStatus(locker, constants.LOCKER_STATUS.PICKING);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    action: 'UNLOCK_SERVO',
    locker_id: locker.locker_id,
  });
}

/**
 * POST /api/v1/telemetry/update
 * Hardware loop: apply double-check rules for OCCUPIED, abort, and AVAILABLE.
 */
async function updateTelemetry(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { locker_id } = req.body || {};

  helpers.expireReservedLockers();

  const lockerId = parseLockerId(locker_id);
  if (!lockerId) {
    return res.status(400).json({
      success: false,
      message: 'locker_id must be 1, 2, or 3',
    });
  }

  const door = parseBoolean(req.body.door_closed, 'door_closed');
  if (!door.ok) {
    return res.status(400).json({ success: false, message: door.message });
  }

  const item = parseBoolean(req.body.has_item, 'has_item');
  if (!item.ok) {
    return res.status(400).json({ success: false, message: item.message });
  }

  const locker = db.lockers.get(lockerId);
  locker.door_closed = door.value;
  locker.has_item = item.value;

  const { LOCKER_STATUS: S } = constants;

  // Double-check: DEPOSITING -> OCCUPIED only if door closed AND item present.
  if (locker.status === S.DEPOSITING && locker.door_closed && locker.has_item) {
    helpers.applyStatus(locker, S.OCCUPIED);

    const otp = helpers.generateOtpCode();
    db.otps.set(otp, {
      otp_code: otp,
      locker_id: locker.locker_id,
      shipment_id: locker.shipment_id,
      recipient_phone: locker.recipient_phone,
      expires_at: Date.now() + constants.OTP_TTL_MS,
      used: false,
    });

    if (locker.shipment_id && db.shipments.has(locker.shipment_id)) {
      db.shipments.get(locker.shipment_id).occupied_at = Date.now();
    }

    if (locker.recipient_phone) {
      const security = helpers.getOtpSecurity(locker.recipient_phone);
      security.failed_attempts = 0;
      security.locked_until = 0;
      helpers.sendSMSViaAndroid(locker.recipient_phone, otp);
    }

    helpers.persistState();

    return res.status(200).json({
      success: true,
      current_status: locker.status,
      led_color: locker.led_color,
    });
  }

  // Deposit abort: user closed an empty locker during DEPOSITING.
  if (locker.status === S.DEPOSITING && locker.door_closed && !locker.has_item) {
    console.log('Deposit aborted by user');

    if (locker.shipment_id && db.shipments.has(locker.shipment_id)) {
      const shipment = db.shipments.get(locker.shipment_id);
      shipment.aborted_at = Date.now();
      shipment.status = 'ABORTED';
    }

    helpers.clearLockerShipment(locker);
    helpers.applyStatus(locker, S.AVAILABLE);
    helpers.persistState();

    return res.status(200).json({
      success: true,
      current_status: locker.status,
      led_color: locker.led_color,
    });
  }

  // Double-check: PICKING -> AVAILABLE only if door closed AND no item.
  if (locker.status === S.PICKING && locker.door_closed && !locker.has_item) {
    if (locker.shipment_id && db.shipments.has(locker.shipment_id)) {
      db.shipments.get(locker.shipment_id).completed_at = Date.now();
    }

    for (const [key, record] of db.otps.entries()) {
      if (record.locker_id === locker.locker_id) {
        db.otps.delete(key);
      }
    }

    helpers.clearLockerShipment(locker);
    helpers.applyStatus(locker, S.AVAILABLE);
    helpers.persistState();

    return res.status(200).json({
      success: true,
      current_status: locker.status,
      led_color: locker.led_color,
    });
  }

  // AVAILABLE locker reporting a sealed item is treated as a sensor/hardware fault.
  if (locker.status === S.AVAILABLE && locker.door_closed && locker.has_item) {
    helpers.applyStatus(locker, S.MAINTENANCE);
    helpers.persistState();
  } else {
    helpers.persistState();
  }

  return res.status(200).json({
    success: true,
    current_status: locker.status,
    led_color: locker.led_color,
  });
}

module.exports = {
  getLockers,
  createShipment,
  openDeposit,
  verifyOtp,
  updateTelemetry,
};
// Dán hàm này trực tiếp vào controllers/lockerController.js
// 1. Kiểm tra lại IP trên màn hình App điện thoại (Tab HOME) để lấy đúng IP
// Nếu trên App ghi 192.168.1.5 thì điền đúng 192.168.1.5
const SMS_GATEWAY_URL = 'http://192.168.1.5:8080/message'; // Dùng /message thay vì /send-sms
const USERNAME = 'sms';
const PASSWORD = 'o4uAdpeJ';

async function sendOTP_SMS(recipientPhone, otpCode) {
  const authHeader = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');

  // Khai báo Controller để tăng timeout lên 10 giây (10000ms)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); 

  try {
    const response = await fetch(SMS_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      signal: controller.signal,
      body: JSON.stringify({
        phoneNumbers: [recipientPhone],
        textMessage: {
          text: `[SMART BOX] Ma OTP nhan hang cua ban la: ${otpCode}. Ma co hieu luc trong 5 phut.`
        }
      })
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      console.log(`📱 [SMS SUCCESS] Đã gửi OTP (${otpCode}) tới SĐT: ${recipientPhone}`);
    } else {
      console.error(`❌ [SMS ERROR] HTTP Status: ${response.status}`);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('❌ [SMS ERROR] Lỗi Timeout 10s: Điện thoại không phản hồi!');
    } else {
      console.error('❌ [SMS ERROR] Không thể kết nối điện thoại:', error.message);
    }
  }
}