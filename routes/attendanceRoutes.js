const express = require("express");
const router = express.Router();
const { bufferImage } = require("../helpers/fileUpload");

const { 
  attendancePunch, 
  getAttendanceSummary, 
  updateAttendanceDay,
  bulkUpdateAttendanceDay,
  deletePunch,
  deleteAttendanceDay,
  getAttendanceDayDetails,
  getMonthlyAttendance,
  getLeaveSummary
}  = require("../controllers/attendance/attendanceController");

router.post("/punch", bufferImage("image"), attendancePunch);
router.post("/summary", getAttendanceSummary);
router.post("/update-day", updateAttendanceDay);
router.post("/bulk-update-day", bulkUpdateAttendanceDay);
router.post("/delete-punch", deletePunch);
router.post("/delete-day", deleteAttendanceDay);
router.post("/details", getAttendanceDayDetails);
router.post("/monthly", getMonthlyAttendance);
router.post("/leave-summary", getLeaveSummary);

module.exports = router;