/**
 * Locker business logic and edge-case handling for the 3-compartment Smart Box.
 * File: controllers/lockerController.js
 */

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function getCtx(req) {
  return {
    db: req.app.locals.db,
    helpers: req.app.locals.helpers,
    constants: req.app.locals.constants,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /api/v1/lockers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /api/v1/shipments/create
// Reserve an AVAILABLE locker and issue a QR token for deposit.
// ---------------------------------------------------------------------------

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

  // ── Chuẩn hóa SĐT về dạng quốc tế +84... ──
  const senderIntl = helpers.normalizePhoneVN(sender_phone);
  const recipientIntl = helpers.normalizePhoneVN(recipient_phone);

  if (!senderIntl || !recipientIntl) {
    return res.status(400).json({
      success: false,
      message: 'SĐT không hợp lệ. Vui lòng dùng định dạng 0xxxxxxxxx hoặc +84xxxxxxxxx',
    });
  }

  const shipment_id = helpers.generateShipmentId();
  const qr_token = helpers.generateQrToken();
  const now = Date.now();

  const shipment = {
    shipment_id,
    locker_id: lockerId,
    sender_phone: senderIntl,
    recipient_phone: recipientIntl,
    qr_token,
    created_at: now,
    occupied_at: null,
    completed_at: null,
    aborted_at: null,
    expired_at: null,
    status: 'PENDING',
  };

  db.shipments.set(shipment_id, shipment);

  locker.shipment_id = shipment_id;
  locker.sender_phone = senderIntl;
  locker.recipient_phone = recipientIntl;
  locker.qr_token = qr_token;
  locker.reserved_at = now;

  helpers.applyStatus(locker, constants.LOCKER_STATUS.RESERVED);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    shipment_id,
    qr_token,
    sender_phone: senderIntl,
    recipient_phone: recipientIntl,
    message: 'Ô đã được giữ chỗ',
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/shipments/open-deposit
// Validate QR token and unlock servo for deposit.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /api/v1/shipments/verify-otp
// Validate recipient OTP (6-digit, 5-minute TTL) and unlock for pickup.
// 5 failed attempts per phone -> lockout 15 minutes (HTTP 429).
// ---------------------------------------------------------------------------

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

  // ── Chuẩn hóa SĐT về dạng quốc tế +84... ──
  const phone = helpers.normalizePhoneVN(recipient_phone);
  const code = otp_code.trim();
  const now = Date.now();

  if (!phone) {
    return res.status(400).json({
      success: false,
      message: 'SĐT không hợp lệ',
    });
  }

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

// ---------------------------------------------------------------------------
// POST /api/v1/shipments/resend-otp
// Re-issue OTP for an OCCUPIED locker (use when first SMS failed).
// ---------------------------------------------------------------------------

async function resendOtp(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { locker_id } = req.body || {};

  const lockerId = parseLockerId(locker_id);
  if (!lockerId) {
    return res.status(400).json({
      success: false,
      message: 'locker_id must be 1, 2, or 3',
    });
  }

  const locker = db.lockers.get(lockerId);

  if (locker.status !== constants.LOCKER_STATUS.OCCUPIED) {
    return res.status(400).json({
      success: false,
      message: 'Chỉ gửi lại OTP khi tủ đang OCCUPIED',
      current_status: locker.status,
    });
  }

  if (!locker.recipient_phone) {
    return res.status(400).json({
      success: false,
      message: 'Tủ chưa có thông tin người nhận',
    });
  }

  // Xóa OTP cũ của SĐT này (nếu còn)
  helpers.invalidateOtpsForPhone(locker.recipient_phone);

  const otp = helpers.generateOtpCode();
  db.otps.set(otp, {
    otp_code: otp,
    locker_id: locker.locker_id,
    shipment_id: locker.shipment_id,
    recipient_phone: locker.recipient_phone,
    expires_at: Date.now() + constants.OTP_TTL_MS,
    used: false,
  });

  // Reset lockout khi gửi lại OTP
  const security = helpers.getOtpSecurity(locker.recipient_phone);
  security.failed_attempts = 0;
  security.locked_until = 0;

  const smsResult = await helpers.sendSMSViaAndroid(locker.recipient_phone, otp);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    message: smsResult.sent ? 'Đã gửi lại OTP' : 'Không gửi được SMS, vui lòng thử lại',
    otp_sent: smsResult.sent,
    otp_send_error: smsResult.sent ? null : smsResult.error,
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/telemetry/update
// Hardware loop: apply double-check rules for OCCUPIED, abort, and AVAILABLE.
// ---------------------------------------------------------------------------

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

  // ── Xử lý đóng tủ sau khi Admin Mở khẩn cấp ──
  if (locker.status === 'EMERGENCY') {
    locker.door_closed = door.value;
    locker.has_item = item.value;

    if (locker.door_closed) {
      const newStatus = locker.has_item
        ? constants.LOCKER_STATUS.OCCUPIED
        : constants.LOCKER_STATUS.AVAILABLE;

      helpers.applyStatus(locker, newStatus);
      helpers.persistState();

      console.log(`✅ [ADMIN RESET] Ô Tủ #${lockerId} đã đóng cửa & khóa an toàn.`);
    }

    return res.status(200).json({
      success: true,
      current_status: locker.status,
      led_color: locker.led_color,
    });
  }

  locker.door_closed = door.value;
  locker.has_item = item.value;
  const { LOCKER_STATUS: S } = constants;

  // ── DEPOSITING -> OCCUPIED (đóng cửa + có hàng) ──
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
      const shipment = db.shipments.get(locker.shipment_id);
      shipment.occupied_at = Date.now();
      shipment.status = 'OCCUPIED';
    }

    let smsResult = { sent: false, error: 'no recipient phone' };

    if (locker.recipient_phone) {
      const security = helpers.getOtpSecurity(locker.recipient_phone);
      security.failed_attempts = 0;
      security.locked_until = 0;

      // ✅ await để biết SMS thật sự gửi được hay không
      smsResult = await helpers.sendSMSViaAndroid(locker.recipient_phone, otp);
    }

    helpers.persistState();

    return res.status(200).json({
      success: true,
      current_status: locker.status,
      led_color: locker.led_color,
      otp_sent: smsResult.sent,
      otp_send_error: smsResult.sent ? null : smsResult.error,
    });
  }

  // ── Deposit abort: đóng tủ rỗng khi DEPOSITING ──
  if (locker.status === S.DEPOSITING && locker.door_closed && !locker.has_item) {
    console.log(`[DEPOSIT ABORTED] Locker #${lockerId}`);

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

  // ── PICKING -> AVAILABLE (đóng cửa + hết hàng) ──
  if (locker.status === S.PICKING && locker.door_closed && !locker.has_item) {
    if (locker.shipment_id && db.shipments.has(locker.shipment_id)) {
      const shipment = db.shipments.get(locker.shipment_id);
      shipment.completed_at = Date.now();
      shipment.status = 'COMPLETED';
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

  // ── AVAILABLE + đóng cửa + có hàng => lỗi cảm biến ──
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

// ---------------------------------------------------------------------------
// POST /api/v1/admin/emergency-unlock
// Admin mở khóa khẩn cấp 1 ô hoặc toàn bộ ô tủ.
// ---------------------------------------------------------------------------

function emergencyUnlock(req, res) {
  const { db, helpers } = getCtx(req);
  const { adminKey, locker_id, unlockAll } = req.body || {};

  // 1. Kiểm tra mật khẩu Admin
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';
  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({
      success: false,
      message: '❌ Mật khẩu khẩn cấp Admin không đúng!',
    });
  }

  // 2. Xử lý mở tủ khẩn cấp
  if (unlockAll === true) {
    for (const locker of db.lockers.values()) {
      locker.servo_angle = 0;
      locker.status = 'EMERGENCY';
      locker.led_color = 'RED';
      locker.led_blink = true;
    }
    console.log('🚨 [ADMIN EMERGENCY] ĐÃ KÍCH HOẠT MỞ KHẨN CẤP TOÀN BỘ 3 Ô TỦ!');

  } else if (locker_id !== undefined && locker_id !== null) {
    const lockerId = parseLockerId(locker_id);
    if (!lockerId) {
      return res.status(400).json({
        success: false,
        message: 'locker_id phải là 1, 2, hoặc 3',
      });
    }

    const locker = db.lockers.get(lockerId);
    if (!locker) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tủ',
      });
    }

    locker.servo_angle = 0;
    locker.status = 'EMERGENCY';
    locker.led_color = 'RED';
    locker.led_blink = true;

    console.log(`🚨 [ADMIN EMERGENCY] Đã kích hoạt mở khẩn cấp Ô Tủ #${lockerId}`);

  } else {
    return res.status(400).json({
      success: false,
      message: 'Vui lòng truyền locker_id (1-3) hoặc unlockAll: true',
    });
  }

  helpers.persistState();

  const lockersList = [1, 2, 3].map((id) => helpers.publicLockerView(db.lockers.get(id)));

  return res.status(200).json({
    success: true,
    message: '⚡ Lệnh mở khóa khẩn cấp đã được phát thành công!',
    lockers: lockersList,
    lcd_preview: helpers.generateLcdPreview(),
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getLockers,
  createShipment,
  openDeposit,
  verifyOtp,
  resendOtp,
  updateTelemetry,
  emergencyUnlock,
};