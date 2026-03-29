const express = require("express");
const router = express.Router();
const reportsController = require("../controllers/reports/payrollReportsController");

router.post("/get-tds-report", reportsController.getTDSDeductionReport);
router.post("/get-employer-contribution-report", reportsController.getEmployerContributionReport);
router.post("/get-ctc-breakdown-report", reportsController.getCTCBreakdownReport);
router.post("/get-generated-payslip-report", reportsController.getGeneratedPayslipReport);
router.post("/get-pf-report", reportsController.getPFReport);
router.post("/get-esi-report", reportsController.getESIReport);
router.post("/get-employee-summary-report", reportsController.getEmployeeSummaryReport);
router.post("/get-employee-exit-report", reportsController.getEmployeeExitReport);

module.exports = router;