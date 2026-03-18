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
router.post("/get-late-entry-report", attendanceController.getLateEntryReport);
router.post("/get-overtime-report", attendanceController.getOvertimeReport);
router.post("/monthly", attendanceController.getMonthlyAttendance);
router.post("/update-note", attendanceController.updateAttendanceNote);
router.post("/leave-summary", attendanceController.getLeaveSummary);
router.post("/report", attendanceController.getAttendanceReport);

module.exports = router;