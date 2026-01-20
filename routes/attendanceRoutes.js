const express = require("express");
const router = express.Router();

// const attendancePunch  = require("../controllers/attendance/attendanceController.js");
const deviceMasterController = require("../controllers/settings/deviceMasterController.js");
const weeklyOffController = require("../controllers/attendance/weeklyOffController.js");

//weekly-off
router.get("/weekly-off/:id", weeklyOffController.getById);
router.post("/weekly-off/get-transactions", weeklyOffController.getAll);
router.post("/weekly-off", weeklyOffController.create);
router.put("/weekly-off/:id", weeklyOffController.update);
router.delete("/weekly-off", weeklyOffController.delete);
router.patch("/weekly-off/status", weeklyOffController.updateStatus);
router.post("/weekly-off/dropdown-list", weeklyOffController.dropdownList);

// router.post("/punch", attendancePunch);

module.exports = router;