const express = require("express");
const router = express.Router();

const { attendancePunch }  = require("../controllers/attendance/attendanceController");

router.post("/punch", attendancePunch);

module.exports = router;