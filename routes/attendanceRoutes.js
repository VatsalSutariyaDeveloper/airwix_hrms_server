const express = require("express");
const router = express.Router();
const { bufferImage } = require("../helpers/fileUpload");

const attendanceController  = require("../controllers/attendance/attendanceController");

router.post("/punch", bufferImage("image"), attendanceController.attendancePunch);
router.post("/summary", attendanceController.getAttendanceSummary);
router.post("/update-day", attendanceController.updateAttendanceDay);
router.post("/bulk-update-day", attendanceController.bulkUpdateAttendanceDay);
router.post("/delete-punch", attendanceController.deletePunch);
router.post("/delete-day", attendanceController.deleteAttendanceDay);
router.post("/details", attendanceController.getAttendanceDayDetails);
router.post("/monthly", attendanceController.getMonthlyAttendance);
router.post("/leave-summary", attendanceController.getLeaveSummary);

module.exports = router;