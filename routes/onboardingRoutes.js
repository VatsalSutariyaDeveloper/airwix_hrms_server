const express = require("express");
const router = express.Router();
const onboardingController = require("../controllers/employee/onboardingController");

// HR Side (Authenticated by global authMiddleware)
router.post("/initiate", onboardingController.initiate);
router.post("/list", onboardingController.getPendingList);
router.get("/detailed/:id", onboardingController.getOnboardingById);
router.post("/resend-invite", onboardingController.resendInvite);
router.put("/approve/:id", onboardingController.approve);

// Candidate Side (Skips auth via logic in authMiddleware.js)
router.get("/public/:token", onboardingController.getDetailsByToken);
router.put("/public/:token", onboardingController.submitDetails);

module.exports = router;
