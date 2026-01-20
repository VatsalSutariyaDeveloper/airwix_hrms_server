const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");

// --- Import Controllers ---
const loginController = require("../controllers/auth/loginController");
const loginHistoryController = require("../controllers/auth/loginHistoryController");

// ==========================
// 1. PUBLIC ROUTES (No Auth Required)
// ==========================
router.post("/login", loginController.login);
router.post("/login/send-otp", loginController.sendLoginOtp);
router.get("/otp-limit/check/:mobile_no", loginController.checkOtpRateLimit);

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

module.exports = router;