const express = require("express");
const router = express.Router();
const masterAdminAuth = require("../middlewares/masterAdminAuth");
const ctrl = require("../controllers/masterAdmin/masterAdminController");

// Apply master admin auth to all routes in this file
router.use(masterAdminAuth);

// --- Dashboard ---
router.get("/dashboard-stats", ctrl.getDashboardStats);

// --- Companies ---
router.post("/companies/list", ctrl.getCompanies);
router.post("/companies/create", ctrl.createCompany);
router.get("/companies/:id", ctrl.getCompanyDetail);
router.post("/companies/update-status", ctrl.updateCompanyStatus);
router.post("/companies/update-settings", ctrl.updateCompanySettings);
router.post("/companies/impersonate", ctrl.impersonateCompany);
router.post("/companies/assign-plan", ctrl.assignCompanyPlan);
router.post("/companies/update-subscription", ctrl.updateCompanySubscription);
router.post("/companies/delete", ctrl.deleteCompany);

// --- Organizations ---
router.get("/organizations/list", ctrl.getOrganizations);

// --- Subscriptions ---
router.post("/subscriptions/list", ctrl.getAllSubscriptions);

// --- Subscription Plans ---
router.get("/plans/list", ctrl.getPlans);
router.get("/plans/modules-entities", ctrl.getModulesAndEntities);
router.post("/plans/create", ctrl.createPlan);
router.post("/plans/update", ctrl.updatePlan);
router.post("/plans/delete", ctrl.deletePlan);

// --- Activation Requests ---
router.post("/activation-requests/list", ctrl.getActivationRequests);
router.post("/activation-requests/process", ctrl.processActivationRequest);

// --- Expose all Administration Routes in Master Admin ---
const masterAdminAdministrationRoutes = require("./masterAdminAdministrationRoutes");
router.use("/administration", masterAdminAdministrationRoutes);

// --- Login Sessions ---
router.post("/sessions/list", ctrl.getSessions);
router.post("/sessions/force-logout", ctrl.forceLogoutSession);

// --- System Logs ---
router.post("/system-logs/database", ctrl.getDatabaseLogs);
router.post("/system-logs/database/clear", ctrl.clearDatabaseLogs);
router.post("/system-logs/api", ctrl.getApiLogs);
router.post("/system-logs/api/clear", ctrl.clearApiLogs);
router.post("/system-logs/client", ctrl.getClientLogs);
router.post("/system-logs/client/clear", ctrl.clearClientLogs);
router.get("/system-logs/files", ctrl.getLogFiles);
router.get("/system-logs/file-content", ctrl.getLogFileContent);
router.post("/system-logs/files/clear", ctrl.clearLogFile);

// --- Cache ---
router.post("/clear-cache", ctrl.clearCache);

module.exports = router;
