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

/**
 * GET /api/v1/lockers
 */
function getLockers(req, res) {
  const { db, helpers } = getCtx(req);
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
    return res.status(400).json({
      success: false,
      message: 'Sensor reports an item in an AVAILABLE locker; locker set to MAINTENANCE',
    });
  }

  const shipment_id = helpers.generateShipmentId();
  const qr_token = helpers.generateQrToken();

  const shipment = {
    shipment_id,
    locker_id: lockerId,
    sender_phone: sender_phone.trim(),
    recipient_phone: recipient_phone.trim(),
    qr_token,
    created_at: Date.now(),
    occupied_at: null,
    completed_at: null,
  };

  db.shipments.set(shipment_id, shipment);

  locker.shipment_id = shipment_id;
  locker.sender_phone = shipment.sender_phone;
  locker.recipient_phone = shipment.recipient_phone;
  locker.qr_token = qr_token;
  helpers.applyStatus(locker, constants.LOCKER_STATUS.RESERVED);

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

  return res.status(200).json({
    success: true,
    action: 'UNLOCK_SERVO',
    locker_id: lockerId,
  });
}

/**
 * POST /api/v1/shipments/verify-otp
 * Validate recipient OTP (6-digit, 5-minute TTL) and unlock for pickup.
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
  const otpRecord = db.otps.get(code);

  if (!otpRecord || otpRecord.used || otpRecord.recipient_phone !== phone) {
    return res.status(404).json({
      success: false,
      message: 'OTP not found',
    });
  }

  if (otpRecord.expires_at <= Date.now()) {
    db.otps.delete(code);
    return res.status(404).json({
      success: false,
      message: 'OTP expired',
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
  helpers.applyStatus(locker, constants.LOCKER_STATUS.PICKING);

  return res.status(200).json({
    success: true,
    action: 'UNLOCK_SERVO',
    locker_id: locker.locker_id,
  });
}

function clearLockerShipment(locker) {
  locker.shipment_id = null;
  locker.sender_phone = null;
  locker.recipient_phone = null;
  locker.qr_token = null;
}

/**
 * POST /api/v1/telemetry/update
 * Hardware loop: apply double-check rules for OCCUPIED and AVAILABLE.
 */
async function updateTelemetry(req, res) {
  const { db, helpers, constants } = getCtx(req);
  const { locker_id } = req.body || {};

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

    // Do not block the hardware telemetry loop on the Android SMS gateway.
    if (locker.recipient_phone) {
      helpers.sendSMSViaAndroid(locker.recipient_phone, otp);
    }

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

    clearLockerShipment(locker);
    helpers.applyStatus(locker, S.AVAILABLE);

    return res.status(200).json({
      success: true,
      current_status: locker.status,
      led_color: locker.led_color,
    });
  }

  // AVAILABLE locker reporting a sealed item is treated as a sensor/hardware fault.
  if (locker.status === S.AVAILABLE && locker.door_closed && locker.has_item) {
    helpers.applyStatus(locker, S.MAINTENANCE);
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
