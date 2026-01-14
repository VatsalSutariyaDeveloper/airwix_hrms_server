const express = require("express");
const router = express.Router();
const subscriptionController = require("../controllers/subscription/subscriptionController");

router.post("/plan/create", subscriptionController.createSubscriptionPlan);
router.post("/plan/list", subscriptionController.getSubscriptionPlans);
router.post("/plan/update", subscriptionController.updateSubscriptionPlan);
router.post("/plan/delete", subscriptionController.deleteSubscriptionPlan);
router.post("/company/assign", subscriptionController.assignSubscription);
router.post("/company/subscription", subscriptionController.getCompanySubscription);
router.post("/company/renew", subscriptionController.renewSubscription);
router.post("/company/check-validity", subscriptionController.checkSubscriptionValidity);
router.post("/company/purchase-addon", subscriptionController.purchaseAddon);
router.post("/plan/delete", subscriptionController.deleteSubscriptionPlan);
router.post("/company/cancel", subscriptionController.cancelSubscription);

module.exports = router;
