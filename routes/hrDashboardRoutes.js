const express = require("express");
const router = express.Router();
const controller = require("../controllers/employee/hrDashboardController");

router.post("/counts", controller.getCounts);
router.post("/probation-completion-alert", controller.getProbationCompletionAlert);
router.post("/update-probation-action", controller.updateProbationAction);
router.post("/pending-count", controller.getPendingCount);
router.post("/pending-approvals-details", controller.getPendingApprovalsDetails);
router.post("/pending-announcement-count", controller.getPendingAnnouncementCount);
router.post("/holidays", controller.getUpcomingHolidays);
router.post("/department_stats", controller.getDepartmentStats);
router.post("/recent_leaves", controller.getRecentLeaves);
router.post("/payroll_overview", controller.getPayrollOverview);
router.get("/birthday-list", controller.getBirthdayList);
router.post("/late-entry-employees", controller.getLateEntryEmployees);
router.post("/leave-summary-counts", controller.getLeaveSummaryCounts);
router.post("/department-employees", controller.getDepartmentEmployees);

module.exports = router;
