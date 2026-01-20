const express = require("express");
const router = express.Router();

const { punchIn, punchOut } = require("../controllers/attendance/attendanceController.js");
const shiftController = require("../controllers/attendance/shiftController.js");
const { weeklyOffController } = require("../controllers/attendance/weeklyOffController.js");
const { ro } = require("@faker-js/faker");

router.post("/punch", attendancePunch);



// Weekly Off
// router.post("/weekly-off", weeklyOffController.setWeeklyOff);

//shift
router.post("/shift", shiftController.create);
router.get("/shift", shiftController.getAll);
router.get("/shift/:id", shiftController.getById);
router.put("/shift/:id", shiftController.update);
router.delete("/shift/", shiftController.delete);
router.put("/shift/", shiftController.updateStatus);

module.exports = router;