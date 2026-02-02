const express = require("express");
const router = express.Router();
const payrollController = require("../controllers/employee/payrollController");

router.post("/calculate", payrollController.calculateMonthlySalary);
router.post("/calculate-batch", payrollController.calculateBatchMonthlySalary);
router.post("/finalize", payrollController.finalizeMonthlySalary);
router.post("/get-employee-payslip-list", payrollController.getEmployeePayslipList);
router.post("/get-calculation-history", payrollController.getCalculationHistory);
router.post("/get-available-months", payrollController.getAvailableMonthsForCalculation);

module.exports = router;
