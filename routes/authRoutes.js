const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");

// --- Import Controllers ---
const loginController = require("../controllers/auth/loginController");
const loginHistoryController = require("../controllers/auth/loginHistoryController");
const authController = require("../controllers/auth/authController");
const deviceMasterController = require("../controllers/settings/deviceMasterController");
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
router.post("/verify-identifier", loginController.verifyIdentifier);
router.post("/verify-mobile", loginController.verifyMobileNo);
router.post("/verify-pin", loginController.verifyPin);
router.post("/login/verify-otp", loginController.verifyOtp);
router.post("/generate-pin", loginController.generatePin);
router.post("/forgot-pin", loginController.forgotPin);
// Session/diagnostic events shipped by the mobile app (SessionLogger).
// Public on purpose: the app calls this while its session is dying, so the
// token may already be expired/revoked — the controller only decodes it.
router.post("/client-log", require("../controllers/auth/clientLogController").store);
router.post("/forgot-password", userController.forgotPassword);
router.get("/otp-limit/check/:mobile_no", loginController.checkOtpRateLimit);

// App Store Redirects (Publicly accessible endpoints)
router.get("/AWXTEC-PY", authController.redirectToStore);

router.post("/state/dropdown-list", stateMasterController.dropdownList);
router.post("/country/dropdown-list", countryMasterController.dropdownList);

// PIN Management (Public)
router.get("/reset-pin/verify/:token", userController.verifyPinToken);
router.post("/reset-pin/setup", userController.setupPin);

// Password Management (Public)
router.get("/reset-password/verify/:token", userController.verifySetupToken);
router.post("/reset-password/setup", userController.setPassword);

// Device Unpairing (Public - accessible when unauthorized)
router.post("/device/public-unpair", loginController.publicUnpairDevice);

// ==========================
// 2. PROTECTED ROUTES (Auth Required)
// ==========================
router.use(authMiddleware);

router.post("/logout", loginController.logout);

// OTP Rate Limit (Protected)
router.get("/otp-limit/blocked-numbers", loginController.getAllBlockedNumbers);
router.delete("/otp-limit/reset/:mobile_no", loginController.resetOtpLimit);
router.get("/otp-verifications", loginController.getOtpVerifications);
router.delete("/otp-verifications/:id", loginController.deleteOtpVerification);

// LOGIN HISTORY ROUTES (Protected)
router.post("/login-history/", loginHistoryController.create);
router.get("/login-history/", loginHistoryController.getAll);
router.get("/login-history/:id", loginHistoryController.getById);
router.put("/login-history/:id", loginHistoryController.update);
router.delete("/login-history/:id", loginHistoryController.delete);

// USER DEVICE ROUTES (Protected)


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
        const results = await runAllNow(asOf, true);
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