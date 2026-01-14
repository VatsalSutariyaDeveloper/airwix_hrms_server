const express = require("express");
const router = express.Router();

// --- Import Controllers ---
const loginController = require("../controllers/auth/loginController");
const loginHistoryController = require("../controllers/auth/loginHistoryController");

// ==========================
// 1. LOGIN ROUTES
// ==========================
// Base Path: / (Root of Auth)
router.post("/login", loginController.login);
router.post("/login/send-otp", loginController.sendLoginOtp);
router.post("/logout/:id", loginController.logout);
router.post("/session_data", loginController.sessionData);

// OTP Rate Limit
router.get("/otp-limit/check/:mobile_no", loginController.checkOtpRateLimit);
router.get("/otp-limit/blocked-numbers", loginController.getAllBlockedNumbers);
router.delete("/otp-limit/reset/:mobile_no", loginController.resetOtpLimit);


// ==========================
// 2. LOGIN HISTORY ROUTES
// ==========================
// Base Path: /login-history
router.post("/login-history/", loginHistoryController.create);
router.get("/login-history/", loginHistoryController.getAll);
router.get("/login-history/:id", loginHistoryController.getById);
router.put("/login-history/:id", loginHistoryController.update);
router.delete("/login-history/:id", loginHistoryController.delete);

module.exports = router;