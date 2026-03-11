const express = require("express");
const router = express.Router();
const payrollController = require("../controllers/employee/payrollController");
const employeeIncentiveController = require("../controllers/employee/employeeIncentiveController");
const employeeAdvanceController = require("../controllers/employee/EmployeeAdvanceController");
const cashVoucherController = require("../controllers/employee/cashVoucherController");
const paymentHistoryController = require("../controllers/employee/paymentHistoryController");

router.post("/calculate", payrollController.calculateMonthlySalary);
router.post("/calculate-batch", payrollController.calculateBatchMonthlySalary);
router.post("/finalize", payrollController.finalizeMonthlySalary);
router.post("/get-employee-payslip", payrollController.getEmployeePayslip);
router.post("/get-payslip-employeeList", payrollController.getPayslipEmployeeList);
router.post("/get-payslipview", payrollController.getPayslipView);
router.post("/export-payslip", payrollController.exportPayrollView);
router.post("/get-calculation-history", payrollController.getCalculationHistory);
router.post("/get-tds-report", payrollController.getTDSDeductionReport);
router.post("/get-available-months", payrollController.getAvailableMonthsForCalculation);
router.post("/get-payrollEmployee", payrollController.getEmployeesByMonthYear);
router.post("/get-payslip-details", payrollController.getPayslipById);
router.post("/get-salary-overview", payrollController.getSalaryOverview);
router.post("/generate-payslip-pdf", payrollController.generatePayslipPdf);
router.post("/payment-history", payrollController.getPaymentHistory);

// Cash Voucher
router.post("/cash-voucher/get-cashVoucher-employee", cashVoucherController.getEmployeesByMonthYear);
router.post("/cash-voucher/calculate", cashVoucherController.calculateCashVoucher);
router.post("/cash-voucher/get-voucher-details", cashVoucherController.getCashVoucherById);
// Enterprise Standard Listing & Bulk Operations
router.post("/listing", payrollController.getMonthlyPayrollListing);
router.post("/bulk-finalize", payrollController.bulkFinalizePayroll);
router.post("/bulk-pay", payrollController.bulkPayPayroll);


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
router.post("/employee-advance/view", employeeAdvanceController.advanceView);

router.post("/payment-history/create", paymentHistoryController.create);
router.post("/payment-history/get-transactions", paymentHistoryController.getAllPaymentHistory);
router.post("/payment-history/view", paymentHistoryController.paymentHistoryView);

module.exports = router;
