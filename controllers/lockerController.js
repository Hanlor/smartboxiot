/**
 * Locker business logic and edge-case handling for the 3-compartment Smart Box.
 * File: controllers/lockerController.js
 *
 * Flow: CREATE (sender OTP) -> VERIFY-SENDER -> OPEN-DEPOSIT
 *       -> TELEMETRY (recipient OTP) -> VERIFY-OTP -> reset
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
// Reserve a locker for a sender, but require OTP verification of sender phone
// before the locker becomes truly RESERVED.
// ---------------------------------------------------------------------------

async function createShipment(req, res) {
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

  // ── Chuẩn hóa SĐT ──
  const senderIntl = helpers.normalizePhoneVN(sender_phone);
  const recipientIntl = helpers.normalizePhoneVN(recipient_phone);

  if (!senderIntl || !recipientIntl) {
    return res.status(400).json({
      success: false,
      message: 'SĐT không hợp lệ. Vui lòng dùng định dạng 0xxxxxxxxx hoặc +84xxxxxxxxx',
    });
  }

  if (senderIntl === recipientIntl) {
    return res.status(400).json({
      success: false,
      message: 'SĐT người gửi và người nhận không được trùng nhau',
    });
  }
  // ── Rate limit theo SĐT sender ──
  if (helpers.checkRateLimit) {
    const rl = helpers.checkRateLimit(senderIntl);
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfterSec));
      return res.status(429).json({
        success: false,
        message: `Bạn đã tạo quá nhiều đơn. Vui lòng thử lại sau ${Math.ceil(rl.retryAfterSec / 60)} phút.`,
        retry_after_seconds: rl.retryAfterSec,
      });
    }
  }
  // ── Kiểm tra lockout gửi OTP cho sender ──
  const senderSecurity = helpers.getOtpSecurity('sender:' + senderIntl);
  if (senderSecurity.locked_until && senderSecurity.locked_until > Date.now()) {
    return lockoutResponse(res, senderSecurity.locked_until);
  }

  const shipment_id = helpers.generateShipmentId();
  const now = Date.now();

  const shipment = {
    shipment_id,
    locker_id: lockerId,
    sender_phone: senderIntl,
    recipient_phone: recipientIntl,
    qr_token: null, // chưa cấp — chỉ cấp sau khi verify sender
    created_at: now,
    occupied_at: null,
    completed_at: null,
    aborted_at: null,
    expired_at: null,
    status: 'PENDING_SENDER',
  };

  db.shipments.set(shipment_id, shipment);

  locker.shipment_id = shipment_id;
  locker.sender_phone = senderIntl;
  locker.recipient_phone = recipientIntl;
  locker.qr_token = null;
  locker.reserved_at = now;

  helpers.applyStatus(locker, constants.LOCKER_STATUS.PENDING_SENDER);

  // ── Sinh OTP gửi cho người gửi ──
  const senderOtp = helpers.generateOtpCode();
  db.otps.set(senderOtp, {
    otp_code: senderOtp,
    otp_type: 'sender',
    locker_id: lockerId,
    shipment_id,
    recipient_phone: senderIntl, // dùng field này để so khớp SĐT
    expires_at: now + constants.OTP_TTL_MS,
    used: false,
  });

  // Reset lockout khi tạo mới
  senderSecurity.failed_attempts = 0;

  helpers.persistState();

   // Gửi SMS với template chuyên nghiệp
  const senderMsg = helpers.buildSenderOtpMessage(senderOtp, shipment_id, lockerId);
  const smsResult = await helpers.sendSMSViaAndroid(senderIntl, senderMsg);

  return res.status(200).json({
    success: true,
    shipment_id,
    sender_phone: senderIntl,
    recipient_phone: recipientIntl,
    otp_sent: smsResult.sent,
    otp_send_error: smsResult.sent ? null : smsResult.error,
    message: smsResult.sent
      ? 'Đã gửi OTP tới SĐT người gửi. Vui lòng xác thực để nhận QR mở tủ.'
      : 'Không gửi được OTP. Vui lòng thử lại hoặc gọi hỗ trợ.',
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/shipments/verify-sender
// Verify sender's phone ownership via OTP. On success -> RESERVED + qr_token.
// ---------------------------------------------------------------------------

function verifySender(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { shipment_id, otp_code } = req.body || {};

  if (!isNonEmptyString(shipment_id) || !isNonEmptyString(otp_code)) {
    return res.status(400).json({
      success: false,
      message: 'shipment_id and otp_code are required',
    });
  }

  helpers.purgeExpiredOtps();

  const shipment = db.shipments.get(shipment_id.trim());
  if (!shipment) {
    return res.status(404).json({
      success: false,
      message: 'Không tìm thấy đơn hàng',
    });
  }

  if (shipment.status !== 'PENDING_SENDER') {
    return res.status(400).json({
      success: false,
      message: 'Đơn hàng không ở trạng thái chờ xác thực người gửi',
      current_status: shipment.status,
    });
  }

  const locker = db.lockers.get(shipment.locker_id);
  if (!locker || locker.status !== constants.LOCKER_STATUS.PENDING_SENDER) {
    return res.status(400).json({
      success: false,
      message: 'Tủ không còn sẵn sàng cho đơn này',
      current_status: locker ? locker.status : null,
    });
  }

  const code = otp_code.trim();
  const now = Date.now();
  const security = helpers.getOtpSecurity('sender:' + shipment.sender_phone);

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
      && otpRecord.otp_type === 'sender'
      && otpRecord.shipment_id === shipment.shipment_id
      && otpRecord.recipient_phone === shipment.sender_phone
      && otpRecord.expires_at > now
  );

  if (!otpValid) {
    security.failed_attempts += 1;

    if (security.failed_attempts >= constants.OTP_MAX_FAILURES) {
      // Xóa OTP, đưa tủ về AVAILABLE, shipment về FAILED
      helpers.invalidateOtpsForPhone(shipment.sender_phone);
      shipment.status = 'FAILED_VERIFY';
      shipment.expired_at = now;
      helpers.clearLockerShipment(locker);
      helpers.applyStatus(locker, constants.LOCKER_STATUS.AVAILABLE);

      security.failed_attempts = constants.OTP_MAX_FAILURES;
      security.locked_until = now + constants.OTP_LOCKOUT_MS;
      helpers.persistState();
      return lockoutResponse(res, security.locked_until);
    }

    helpers.persistState();

    return res.status(400).json({
      success: false,
      message: 'OTP không đúng',
      remaining_attempts: constants.OTP_MAX_FAILURES - security.failed_attempts,
    });
  }

  // ── Thành công ──
  otpRecord.used = true;
  db.otps.delete(code);

  security.failed_attempts = 0;
  security.locked_until = 0;

  const qr_token = helpers.generateQrToken();
  shipment.qr_token = qr_token;
  shipment.status = 'RESERVED';
  shipment.verified_at = now;

  locker.qr_token = qr_token;
  helpers.applyStatus(locker, constants.LOCKER_STATUS.RESERVED);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    shipment_id: shipment.shipment_id,
    qr_token,
    locker_id: locker.locker_id,
    message: 'Xác thực người gửi thành công. Sẵn sàng mở tủ gửi hàng.',
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/shipments/resend-sender-otp
// Re-issue sender OTP for a PENDING_SENDER shipment.
// ---------------------------------------------------------------------------

async function resendSenderOtp(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { shipment_id } = req.body || {};

  if (!isNonEmptyString(shipment_id)) {
    return res.status(400).json({
      success: false,
      message: 'shipment_id is required',
    });
  }

  const shipment = db.shipments.get(shipment_id.trim());
  if (!shipment) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' });
  }

  if (shipment.status !== 'PENDING_SENDER') {
    return res.status(400).json({
      success: false,
      message: 'Chỉ gửi lại OTP khi đơn đang chờ xác thực',
      current_status: shipment.status,
    });
  }

  // Xóa OTP cũ của SĐT sender này
  helpers.invalidateOtpsForPhone(shipment.sender_phone);

  const otp = helpers.generateOtpCode();
  db.otps.set(otp, {
    otp_code: otp,
    otp_type: 'sender',
    locker_id: shipment.locker_id,
    shipment_id: shipment.shipment_id,
    recipient_phone: shipment.sender_phone,
    expires_at: Date.now() + constants.OTP_TTL_MS,
    used: false,
  });

  const security = helpers.getOtpSecurity('sender:' + shipment.sender_phone);
  security.failed_attempts = 0;
  security.locked_until = 0;

  const smsResult = await helpers.sendSMSViaAndroid(shipment.sender_phone, otp);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    otp_sent: smsResult.sent,
    otp_send_error: smsResult.sent ? null : smsResult.error,
    message: smsResult.sent ? 'Đã gửi lại OTP' : 'Không gửi được SMS',
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/shipments/open-deposit
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

  if (locker.status === constants.LOCKER_STATUS.PENDING_SENDER) {
    return res.status(400).json({
      success: false,
      message: 'Người gửi chưa xác thực OTP',
      current_status: locker.status,
    });
  }

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
// POST /api/v1/shipments/verify-otp  (recipient side)
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
      && otpRecord.otp_type === 'recipient'
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
// POST /api/v1/shipments/resend-otp  (recipient side)
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

  helpers.invalidateOtpsForPhone(locker.recipient_phone);

  const otp = helpers.generateOtpCode();
  db.otps.set(otp, {
    otp_code: otp,
    otp_type: 'recipient',
    locker_id: locker.locker_id,
    shipment_id: locker.shipment_id,
    recipient_phone: locker.recipient_phone,
    expires_at: Date.now() + constants.OTP_TTL_MS,
    used: false,
  });

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

  // Xử lý đóng tủ sau khi Admin Mở khẩn cấp
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

  // DEPOSITING -> OCCUPIED
  if (locker.status === S.DEPOSITING && locker.door_closed && locker.has_item) {
    helpers.applyStatus(locker, S.OCCUPIED);

    const otp = helpers.generateOtpCode();
    db.otps.set(otp, {
      otp_code: otp,
      otp_type: 'recipient',
      locker_id: locker.locker_id,
      shipment_id: locker.shipment_id,
      recipient_phone: locker.recipient_phone,
      expires_at: Date.now() + constants.OTP_TTL_MS,
      used: false,
    });

        if (locker.shipment_id && db.shipments.has(locker.shipment_id)) {
      const shipment = db.shipments.get(locker.shipment_id);
      const now = Date.now();
      shipment.occupied_at = now;
      shipment.status = 'OCCUPIED';
      // ✅ Tính deadline
      shipment.deadline_at = now + (helpers.RETURN_AFTER_MS || 24 * 3600 * 1000);
      shipment.extension_count = 0;
    }

    let smsResult = { sent: false, error: 'no recipient phone' };

     if (locker.recipient_phone) {
      const security = helpers.getOtpSecurity(locker.recipient_phone);
      security.failed_attempts = 0;
      security.locked_until = 0;

      const recipientMsg = helpers.buildRecipientOtpMessage(
        otp,
        locker.sender_phone,
        locker.locker_id
      );
      smsResult = await helpers.sendSMSViaAndroid(locker.recipient_phone, recipientMsg);
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

  // Deposit abort
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
  // ── RETURN_PICKING -> AVAILABLE (sender lấy hàng hoàn xong) ──
  if (locker.status === S.RETURN_PICKING && locker.door_closed && !locker.has_item) {
    console.log(`[RETURN COMPLETE] Locker #${locker.locker_id} — sender đã lấy hàng hoàn`);

    if (locker.shipment_id && db.shipments.has(locker.shipment_id)) {
      const shipment = db.shipments.get(locker.shipment_id);
      shipment.return_completed_at = Date.now();
      shipment.status = 'RETURNED';
    }

    for (const [key, record] of db.otps.entries()) {
      if (record.locker_id === locker.locker_id) db.otps.delete(key);
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
    // ✅ Lấy info TRƯỚC khi clear locker
    const senderPhone = locker.sender_phone;
    const shipmentId = locker.shipment_id;
    const lockerId = locker.locker_id;

    if (shipmentId && db.shipments.has(shipmentId)) {
      const shipment = db.shipments.get(shipmentId);
      shipment.completed_at = Date.now();
      shipment.status = 'COMPLETED';
    }

    for (const [key, record] of db.otps.entries()) {
      if (record.locker_id === lockerId) {
        db.otps.delete(key);
      }
    }

    helpers.clearLockerShipment(locker);
    helpers.applyStatus(locker, S.AVAILABLE);
    helpers.persistState();

    // 🆕 Gửi SMS xác nhận cho NGƯỜI GỬI
    let smsConfirmSent = false;
    if (senderPhone && shipmentId) {
      try {
        const confirmMsg = helpers.buildPickupConfirmMessage(shipmentId, lockerId);
        const r = await helpers.sendSMSViaAndroid(senderPhone, confirmMsg);
        smsConfirmSent = r.sent;
      } catch (err) {
        console.error('[SMS CONFIRM] Failed:', err.message);
      }
    }

    return res.status(200).json({
      success: true,
      current_status: locker.status,
      led_color: locker.led_color,
      sender_notified: smsConfirmSent,
    });
  }
  // AVAILABLE + có hàng => lỗi cảm biến
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
/**
 * POST /api/v1/admin/verify
 * Chỉ kiểm tra mật khẩu admin, không làm gì khác.
 */
function verifyAdminKey(req, res) {
  const { adminKey } = req.body || {};
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';

  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({
      success: false,
      message: 'Mật khẩu không đúng',
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Xác thực thành công',
  });
}
/**
 * POST /api/v1/shipments/cancel
 * Hủy đơn ở các trạng thái PENDING_SENDER / RESERVED / DEPOSITING.
 */
function cancelShipment(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { shipment_id, locker_id } = req.body || {};

  let shipment = null;
  let locker = null;

  if (isNonEmptyString(shipment_id)) {
    shipment = db.shipments.get(shipment_id.trim());
    if (shipment) locker = db.lockers.get(shipment.locker_id);
  } else if (locker_id !== undefined && locker_id !== null) {
    const lockerId = parseLockerId(locker_id);
    if (lockerId) {
      locker = db.lockers.get(lockerId);
      if (locker && locker.shipment_id) {
        shipment = db.shipments.get(locker.shipment_id);
      }
    }
  }

  if (!locker) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy tủ' });
  }

  const cancellableStates = [
    constants.LOCKER_STATUS.PENDING_SENDER,
    constants.LOCKER_STATUS.RESERVED,
    constants.LOCKER_STATUS.DEPOSITING,
  ];

  if (!cancellableStates.includes(locker.status)) {
    return res.status(400).json({
      success: false,
      message: 'Không thể hủy ở trạng thái này',
      current_status: locker.status,
    });
  }

  if (shipment) {
    shipment.status = 'CANCELLED';
    shipment.cancelled_at = Date.now();
  }

  // Xóa mọi OTP của locker này
  for (const [key, otp] of db.otps.entries()) {
    if (otp.locker_id === locker.locker_id) db.otps.delete(key);
  }

  helpers.clearLockerShipment(locker);
  helpers.applyStatus(locker, constants.LOCKER_STATUS.AVAILABLE);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    message: 'Đã hủy đơn',
    locker_id: locker.locker_id,
  });
}

/**
 * POST /api/v1/shipments/resend-otp-by-phone
 * Gửi lại OTP người nhận dựa trên SĐT (khi user không biết locker_id).
 */
async function resendOtpByPhone(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { recipient_phone } = req.body || {};

  if (!isNonEmptyString(recipient_phone)) {
    return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
  }

  const phone = helpers.normalizePhoneVN(recipient_phone);
  if (!phone) {
    return res.status(400).json({ success: false, message: 'SĐT không hợp lệ' });
  }

  // Tìm tủ OCCUPIED khớp SĐT
  let targetLocker = null;
  for (const locker of db.lockers.values()) {
    if (locker.status === constants.LOCKER_STATUS.OCCUPIED
        && locker.recipient_phone === phone) {
      targetLocker = locker;
      break;
    }
  }

  if (!targetLocker) {
    return res.status(404).json({
      success: false,
      message: 'Không tìm thấy đơn đang chờ nhận với SĐT này',
    });
  }

  helpers.invalidateOtpsForPhone(phone);

  const otp = helpers.generateOtpCode();
  db.otps.set(otp, {
    otp_code: otp,
    otp_type: 'recipient',
    locker_id: targetLocker.locker_id,
    shipment_id: targetLocker.shipment_id,
    recipient_phone: phone,
    expires_at: Date.now() + constants.OTP_TTL_MS,
    used: false,
  });

  const security = helpers.getOtpSecurity(phone);
  security.failed_attempts = 0;
  security.locked_until = 0;

  const smsResult = await helpers.sendSMSViaAndroid(phone, otp);
  helpers.persistState();

  return res.status(200).json({
    success: true,
    message: smsResult.sent ? 'Đã gửi lại OTP' : 'Không gửi được SMS',
    otp_sent: smsResult.sent,
    otp_send_error: smsResult.sent ? null : smsResult.error,
  });
}
// ---------------------------------------------------------------------------
// POST /api/v1/admin/emergency-unlock
// ---------------------------------------------------------------------------

function emergencyUnlock(req, res) {
  const { db, helpers } = getCtx(req);
  const { adminKey, locker_id, unlockAll } = req.body || {};

  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || 'admin@smartbox123';
  if (adminKey !== ADMIN_SECRET) {
    return res.status(403).json({
      success: false,
      message: '❌ Mật khẩu khẩn cấp Admin không đúng!',
    });
  }

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
  verifySender,
  resendSenderOtp,
  openDeposit,
  verifyOtp,
  resendOtp,
  updateTelemetry,
  emergencyUnlock,
  verifyAdminKey, 
  resendOtpByPhone,      // <-- THÊM
  cancelShipment,  
  RETURN_AFTER_MS,              // <-- THÊM
  EXTENSION_HOURS,              // <-- THÊM
  MAX_EXTENSIONS,               // <-- THÊM
};