const express = require("express");
const router = express.Router();
const payrollController = require("../controllers/employee/payrollController");

router.post("/calculate", payrollController.calculateMonthlySalary);
router.post("/calculate-batch", payrollController.calculateBatchMonthlySalary);
router.post("/finalize", payrollController.finalizeMonthlySalary);

module.exports = router;
