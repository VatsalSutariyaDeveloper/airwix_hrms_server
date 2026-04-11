const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");

// --- Import Controllers ---
const loginController = require("../controllers/auth/loginController");
const loginHistoryController = require("../controllers/auth/loginHistoryController");
const authController = require("../controllers/auth/authController");
// ==========================
// 1. PUBLIC ROUTES (No Auth Required)
// ==========================
const userController = require("../controllers/settings/user/userController");

// Address / Location
const stateMasterController = require("../controllers/administration/address/stateMasterController");
const countryMasterController = require("../controllers/administration/address/countryMasterController");

router.post("/login", loginController.login);
router.post("/pin-login", loginController.pinLogin);
router.post("/register", authController.register);
router.post("/register/send-otp", authController.sendOtp);
router.post("/register/verify-otp", authController.verifyOtp);
router.post("/login/send-otp", loginController.sendLoginOtp);
router.post("/verify-mobile", loginController.verifyMobileNo);
router.post("/verify-pin", loginController.verifyPin);
router.post("/verify-otp-pin", loginController.verifyOtpPin);
router.post("/generate-pin", loginController.generatePin);
router.get("/otp-limit/check/:mobile_no", loginController.checkOtpRateLimit);

router.post("/state/dropdown-list", stateMasterController.dropdownList);
router.post("/country/dropdown-list", countryMasterController.dropdownList);

// Password Management (Public)
router.post("/user/setup-password", userController.setPassword);
router.post("/user/forgot-password", userController.forgotPassword);
router.get("/user/verify-token/:token", userController.verifySetupToken);

// ==========================
// 2. PROTECTED ROUTES (Auth Required)
// ==========================
router.use(authMiddleware);

router.post("/logout", loginController.logout);

// OTP Rate Limit (Protected)
router.get("/otp-limit/blocked-numbers", loginController.getAllBlockedNumbers);
router.delete("/otp-limit/reset/:mobile_no", loginController.resetOtpLimit);

// LOGIN HISTORY ROUTES (Protected)
router.post("/login-history/", loginHistoryController.create);
router.get("/login-history/", loginHistoryController.getAll);
router.get("/login-history/:id", loginHistoryController.getById);
router.put("/login-history/:id", loginHistoryController.update);
router.delete("/login-history/:id", loginHistoryController.delete);

// ─────────────────────────────────────────────────────────────────────────────
// 🧪 DEV/ADMIN: Manual Cron Trigger Routes
// ─────────────────────────────────────────────────────────────────────────────

// Run ALL jobs at once (optional simulated date)
// POST /api/auth/cron/run-all
// Body: { "date": "2026-05-01" }  ← optional
router.post("/cron/run-all", async (req, res) => {
    try {
        const { runAllNow } = require("../jobs/cronJobs");
        const asOf = req.body?.date || null;
        const results = await runAllNow(asOf);
        return res.ok({ message: `All cron jobs executed${asOf ? ` as of ${asOf}` : ''}.`, results });
    } catch (err) {
        return res.status(500).json({ status: "ERROR", message: err.message });
    }
});

// Run a SINGLE job manually (optional simulated date)
// POST /api/auth/cron/run-job
// Body: { "job": "Attendance Rebuild", "date": "2026-05-01" }
router.post("/cron/run-job", async (req, res) => {
    try {
        const { runJobNow } = require("../jobs/cronJobs");
        const { job: jobKey, date: asOf } = req.body;
        if (!jobKey) return res.status(400).json({ status: "ERROR", message: "\"job\" field is required." });
        const result = await runJobNow(jobKey, asOf || null);
        return res.ok({ message: `Job "${jobKey}" executed${asOf ? ` as of ${asOf}` : ''}.`, result });
    } catch (err) {
        return res.status(400).json({ status: "ERROR", message: err.message });
    }
});

// List all available job names
// GET /api/auth/cron/jobs
router.get("/cron/jobs", (req, res) => {
    const { ALL_JOBS } = require("../jobs/cronJobs");
    return res.ok({ jobs: ALL_JOBS.map(j => j.name) });
});

module.exports = router;