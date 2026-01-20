const express = require("express");
const router = express.Router();

const { attendancePunch } = require("../controllers/attendance/attendanceController.js");

router.post("/punch", attendancePunch);



// Weekly Off
// router.post("/weekly-off", weeklyOffController.setWeeklyOff);
module.exports = router;