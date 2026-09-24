const express = require('express');
const lockerController = require('../controllers/lockerController');

const router = express.Router();

router.get('/lockers', lockerController.getLockers);
router.post('/shipments/create', lockerController.createShipment);
router.post('/shipments/verify-sender', lockerController.verifySender);        // <-- MỚI
router.post('/shipments/resend-sender-otp', lockerController.resendSenderOtp); // <-- MỚI
router.post('/shipments/open-deposit', lockerController.openDeposit);
router.post('/shipments/verify-otp', lockerController.verifyOtp);
router.post('/shipments/resend-otp', lockerController.resendOtp);
router.post('/telemetry/update', lockerController.updateTelemetry);
router.post('/admin/verify', lockerController.verifyAdminKey);
router.post('/admin/emergency-unlock', lockerController.emergencyUnlock);
router.post('/shipments/cancel', lockerController.cancelShipment);
router.post('/shipments/resend-otp-by-phone', lockerController.resendOtpByPhone);

module.exports = router;