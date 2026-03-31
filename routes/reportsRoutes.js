const express = require("express");
const router = express.Router();
const reportsController = require("../controllers/reports/payrollReportsController");
const attendanceReportsController = require("../controllers/reports/attendanceReportsController");
const employeeReportsController = require("../controllers/reports/employeeReportsController");

router.post("/get-tds-report", reportsController.getTDSDeductionReport);
router.post("/get-employer-contribution-report", reportsController.getEmployerContributionReport);
router.post("/get-ctc-breakdown-report", reportsController.getCTCBreakdownReport);
router.post("/get-generated-payslip-report", reportsController.getGeneratedPayslipReport);
router.post("/get-pf-report", reportsController.getPFReport);
router.post("/get-esi-report", reportsController.getESIReport);
router.post("/get-employee-summary-report", reportsController.getEmployeeSummaryReport);

// Attendance Report Routes
router.post("/get-late-entry-report", attendanceReportsController.getLateEntryReport);
router.post("/get-overtime-report", attendanceReportsController.getOvertimeReport);
router.post("/attendance-report", attendanceReportsController.getAttendanceReport);
router.post("/leave-request/report", attendanceReportsController.getLeaveReport);

// Employee Report Routes
router.post("/get-employee-exit-report", employeeReportsController.getEmployeeExitReport);
router.post("/performance-report", employeeReportsController.getPerformanceReport);


module.exports = router;