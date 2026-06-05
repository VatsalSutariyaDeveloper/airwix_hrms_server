const express = require("express");
const router = express.Router();
const { bufferImage } = require("../helpers/fileUpload");

const attendanceController  = require("../controllers/attendance/attendanceController");

router.post("/punch", bufferImage("image"), attendanceController.attendancePunch);
router.post("/sync-punches", attendanceController.syncPunches);
router.post("/summary", attendanceController.getAttendanceSummary);
router.post("/update-day", attendanceController.updateAttendanceDay);
router.post("/bulk-update-day", attendanceController.bulkUpdateAttendanceDay);
router.post("/delete-punch", attendanceController.deletePunch);
router.post("/delete-day", attendanceController.deleteAttendanceDay);
router.post("/details", attendanceController.getAttendanceDayDetails);
router.post("/monthly", attendanceController.getMonthlyAttendance);
router.post("/update-note", attendanceController.updateAttendanceNote);
router.post("/leave-summary", attendanceController.getLeaveSummary);
router.post("/irregularities", attendanceController.getIrregularities);
router.get("/irregularities-count", attendanceController.getIrregularitiesCount);
router.post("/self-irregularities", attendanceController.getSelfIrregularities);

// Face Recognition Errors Endpoints
router.post("/face-recognition-error", bufferImage("image"), attendanceController.storeFaceRecognitionError);
router.post("/face-recognition-errors/list", attendanceController.getFaceRecognitionErrors);
router.post("/face-recognition-errors/resolve", attendanceController.resolveFaceRecognitionError);
router.post("/face-recognition-errors/delete", attendanceController.deleteFaceRecognitionError);

module.exports = router;