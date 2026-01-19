const express = require("express");
const router = express.Router();
const holidayController = require("../controllers/holiday/holidayController.js");

router.post("/", holidayController.create);
router.put("/:id", holidayController.update);
router.post("/get-transactions", holidayController.getAll);
router.post("/dropdown-list", holidayController.dropdownList);
router.get("/:id", holidayController.getById);
router.delete("/:id", holidayController.delete);
router.patch("/status", holidayController.updateStatus);

module.exports = router;
