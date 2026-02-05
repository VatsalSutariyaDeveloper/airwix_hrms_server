const express = require("express");
const router = express.Router();
const payrollController = require("../controllers/employee/payrollController");
const employeeIncentiveController = require("../controllers/employee/employeeIncentiveController");
const employeeAdvanceController = require("../controllers/employee/EmployeeAdvanceController");

router.post("/calculate", payrollController.calculateMonthlySalary);
router.post("/calculate-batch", payrollController.calculateBatchMonthlySalary);
router.post("/finalize", payrollController.finalizeMonthlySalary);
router.post("/get-employee-payslip-list", payrollController.getEmployeePayslipList);
router.post("/get-calculation-history", payrollController.getCalculationHistory);
router.post("/get-available-months", payrollController.getAvailableMonthsForCalculation);
router.post("/get-payslip-details", payrollController.getPayslipById);
router.post("/get-salary-overview", payrollController.getSalaryOverview);

// ==========================
// EMPLOYEE_INCENTIVE
// ==========================
// Base Path: /employee-incentive
router.post("/employee-incentive", employeeIncentiveController.create);
router.post("/employee-incentive/get-transactions", employeeIncentiveController.getAll);
// router.post("/employee-incentive/dropdown-list", employeeIncentiveController.dropdownList);
router.get("/employee-incentive/:id", employeeIncentiveController.getById);
router.put("/employee-incentive/:id", employeeIncentiveController.update);
router.delete("/employee-incentive", employeeIncentiveController.delete);
router.patch("/employee-incentive/status", employeeIncentiveController.updateStatus);

// ==========================
// EMPLOYEE_ADVANCE
// ==========================
// Base Path: /employee-advance
router.post("/employee-advance/", employeeAdvanceController.create);
router.post("/employee-advance/get-transactions", employeeAdvanceController.getAll);
// router.post("/employee-advance/dropdown-list", employeeAdvanceController.dropdownList);
router.get("/employee-advance/:id", employeeAdvanceController.getById);
router.put("/employee-advance/:id", employeeAdvanceController.update);
router.delete("/employee-advance", employeeAdvanceController.delete);
router.patch("/employee-advance/status", employeeAdvanceController.updateStatus);
router.post("/employee-advance/view", employeeAdvanceController.view);
router.post("/payment-history/get-transactions", employeeAdvanceController.getAllPaymentHistory);

module.exports = router;
