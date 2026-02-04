const express = require("express");
const router = express.Router();
const payrollController = require("../controllers/employee/payrollController");
const employeeIncentive = require("../controllers/employee/employeeIncentiveController");

router.post("/calculate", payrollController.calculateMonthlySalary);
router.post("/calculate-batch", payrollController.calculateBatchMonthlySalary);
router.post("/finalize", payrollController.finalizeMonthlySalary);
router.post("/get-employee-payslip-list", payrollController.getEmployeePayslipList);
router.post("/get-calculation-history", payrollController.getCalculationHistory);
router.post("/get-available-months", payrollController.getAvailableMonthsForCalculation);
router.post("/get-payslip-details", payrollController.getPayslipById);

// ==========================
// EMPLOYEE_INCENTIVE
// ==========================
// Base Path: /employee-incentive
router.post("/employee-incentive", employeeIncentive.create);
router.post("/employee-incentive/get-transactions", employeeIncentive.getAll);
router.post("/employee-incentive/dropdown-list", employeeIncentive.dropdownList);
router.get("/employee-incentive/:id", employeeIncentive.getById);
router.put("/employee-incentive/:id", employeeIncentive.update);
router.delete("/employee-incentive", employeeIncentive.delete);
router.patch("/employee-incentive/status", employeeIncentive.updateStatus);

module.exports = router;
