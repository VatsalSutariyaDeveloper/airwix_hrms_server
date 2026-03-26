const express = require("express");
const router = express.Router();
const onboardingController = require("../controllers/employee/onboardingController");
const { bufferFile } = require("../helpers/fileUpload");

// HR Side (Authenticated by global authMiddleware)
router.post("/initiate", onboardingController.initiate);
router.post("/list", onboardingController.getPendingList);
router.get("/detailed/:id", onboardingController.getOnboardingById);
router.post("/resend-invite", onboardingController.resendInvite);
router.put("/approve/:id", onboardingController.approve);
router.put("/reject/:id", onboardingController.reject);
router.put("/resend-token/:id", onboardingController.resendToken);

// Candidate Side (Skips auth via logic in authMiddleware.js)
router.get("/public/:token", onboardingController.getDetailsByToken);
router.put("/public/:token", bufferFile(['aadhaar_doc', 'pan_doc', 'bank_proof_doc', 'driving_license_doc', 'voter_id_doc', 'uan_doc']), onboardingController.submitDetails);

module.exports = router;