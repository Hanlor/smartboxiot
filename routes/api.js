const express = require('express');
const lockerController = require('../controllers/lockerController');

const router = express.Router();

router.get('/lockers', lockerController.getLockers);
router.post('/shipments/create', lockerController.createShipment);
router.post('/shipments/open-deposit', lockerController.openDeposit);
router.post('/shipments/verify-otp', lockerController.verifyOtp);
router.post('/telemetry/update', lockerController.updateTelemetry);

module.exports = router;
