const express = require("express");
const router = express.Router();
const canteenAttendanceController = require("../controllers/canteenAttendance/canteenAttendanceController.js");

router.post("/", canteenAttendanceController.create);
router.post("/summary", canteenAttendanceController.getSummary);
router.delete("/delete", canteenAttendanceController.delete);
router.put("/:id", canteenAttendanceController.update);

module.exports = router;
