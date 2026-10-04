const express = require('express');
const lockerController = require('../controllers/lockerController');
const router = express.Router();

router.get('/lockers', lockerController.getLockers);

// ═══ P2P Flow ═══
router.get('/shipments/mine', lockerController.getMyShipments);
router.post('/shipments/create', lockerController.createShipment);
router.post('/shipments/verify-sender', lockerController.verifySender);
router.post('/shipments/resend-sender-otp', lockerController.resendSenderOtp);
router.post('/shipments/open-deposit', lockerController.openDeposit);
router.post('/shipments/verify-otp', lockerController.verifyOtp);
router.post('/shipments/resend-otp', lockerController.resendOtp);
router.post('/shipments/resend-otp-by-phone', lockerController.resendOtpByPhone);
router.post('/shipments/cancel', lockerController.cancelShipment);

// ═══ Extension + Return ═══
router.post('/shipments/request-extension-otp', lockerController.requestExtensionOtp);
router.post('/shipments/extend', lockerController.extendShipment);
router.post('/shipments/verify-return-otp', lockerController.verifyReturnOtp);

// ═══ Telemetry ═══
router.post('/telemetry/update', lockerController.updateTelemetry);

// ═══ Admin ═══
router.post('/admin/emergency-unlock', lockerController.emergencyUnlock);
router.post('/admin/verify', lockerController.verifyAdminKey);

module.exports = router;