const express = require("express");
const router = express.Router();

const { attendancePunch } = require("../controllers/attendance/attendanceController.js");
const { shiftController } = require("../controllers/attendance/shiftController.js");
const { weeklyOffController } = require("../controllers/attendance/weeklyOffController.js");

router.post("/punch", attendancePunch);

// Shift
// router.post("/shift", shiftController.createShift);
// router.post("/shift/assign", shiftController.assignShift);

// Weekly Off
// router.post("/weekly-off", weeklyOffController.setWeeklyOff);
module.exports = router;