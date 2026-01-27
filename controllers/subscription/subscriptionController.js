const { SubscriptionPlan, CompanySubscription, CompanyMaster } = require("../../models");
const commonQuery = require("../../helpers/commonQuery");
const moment = require("moment");
const { sequelize, reloadCompanySubscriptionCache, clearCompanySubscriptionCache } = require("../../helpers");
const SubscriptionPlanModel= "Subscription Plan";
const CompanySubscriptionModel= "Company Subscription";
// ----------------------------------------------
// 1️⃣ Create Subscription Plan
// ----------------------------------------------
exports.createSubscriptionPlan = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const data = req.body;
    const plan = await commonQuery.createRecord(SubscriptionPlan, data, transaction);

    await transaction.commit();
    return res.success("PLAN_CREATED", plan);
  } catch (err) {
    await transaction.rollback();
    console.log(err);
    return res.error("ERROR", "Something went wrong", err);
  }
};

// ----------------------------------------------
// 2️⃣ Get All Subscription Plans
// ----------------------------------------------
exports.getSubscriptionPlans = async (req, res) => {
  try {
    const where = { status: 0 };

    // Apply subscription_type filter ONLY if sent
    if (req.body.subscription_type) {
      where.subscription_type = req.body.subscription_type; // plan | addon
    }

    const plans = await commonQuery.findAllRecords(SubscriptionPlan, where, {}, null, false);
    return res.ok(plans);

  } catch (err) {
    return res.error("ERROR", "Something went wrong", err);
  }
};


// ----------------------------------------------
// 3️⃣ Update Subscription Plan
// ----------------------------------------------
exports.updateSubscriptionPlan = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.body;

    await commonQuery.updateRecordById(
      SubscriptionPlan,
      { id },
      req.body,
      transaction
    );

    await transaction.commit();
    return res.success("PLAN_UPDATED", SubscriptionPlanModel);
  } catch (err) {
    await transaction.rollback();
    return res.error("ERROR", "Something went wrong", err);
  }
};

// ----------------------------------------------
// 4️⃣ Assign Subscription to Company
// ----------------------------------------------
exports.assignSubscription = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const {
      subscription_plan_id,
      amount_paid,
      payment_id,
      payment_status,
      user_id,
      branch_id
    } = req.body;

    const record = await commonQuery.findOneRecord(
        CompanyMaster, 
        req.body.company_id,
        { attributes: ['id', 'company_id'] }
    );
    
    if (!record) {
        return res.error("NOT_FOUND", { message : "Invalid or missing company record."});
    }

    const company_id = record.company_id || record.id;

    const plan = await commonQuery.findOneRecord(
      SubscriptionPlan,
      { id: subscription_plan_id, status: 0 },
      {},
      transaction
    );

    if (!plan) {
        await transaction.rollback();
        return res.error("INVALID_PLAN", "Plan not found");
    }

    if (plan.is_trial) {
        const pastHistory = await commonQuery.findOneRecord(
            CompanySubscription,
            { company_id: company_id },
            { attributes: ['id'] },
            transaction
        );

        if (pastHistory) {
            await transaction.rollback();
            return res.error("TRIAL_NOT_ALLOWED", "Your are not able to Purchase Free trial plan.");
        }
    }

    if(amount_paid < plan.price) {
        await transaction.rollback();
        return res.error("INSUFFICIENT_AMOUNT", "Amount paid is less than plan price");
    }
    
    const existingBase = await commonQuery.findOneRecord(
        CompanySubscription, 
        { company_id, status: 0 }, 
        { include: [{ model: SubscriptionPlan, where: { subscription_type: 'plan' } }] },
        transaction
    );

    if (existingBase) {
        await transaction.rollback();
        return res.error("EXISTING_PLAN", "Company already has an active base plan. Use 'Renew' or 'Upgrade'.");
    }
    
    await commonQuery.updateRecordById(CompanySubscription, { company_id: company_id }, { status: 1 }, transaction);

    const start = moment().format("YYYY-MM-DD");
    const end = moment().add(plan.duration_days, "days").format("YYYY-MM-DD");

    const data = {
      company_id,
      user_id,
      branch_id,
      subscription_plan_id,
      amount_paid,
      payment_id,
      payment_status: payment_status || payment_id ? "Paid" : "Pending",
      start_date: start,
      end_date: end,
      duration_days: plan.duration_days,
      ...plan.dataValues,
      status: 0,
    };

    delete data.id;
    delete data.createdAt;
    delete data.updatedAt;
    
    if (data.is_trial === undefined) {
        data.is_trial = false; 
    }
    const newSub = await commonQuery.createRecord(CompanySubscription, data, transaction);
    
    await transaction.commit();
    reloadCompanySubscriptionCache(company_id); 
    return res.success("SUB_ASSIGNED", newSub);
  } catch (err) {
    console.error("Assign Subscription Error:", err);
    if (transaction) await transaction.rollback();
    return res.error("ERROR", "Something went wrong", err);
  }
};

// ----------------------------------------------
// 6️⃣ Renew Subscription
// ----------------------------------------------
exports.renewSubscription = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { subscription_plan_id, amount_paid, payment_id } = req.body;

        const record = await commonQuery.findOneRecord(
            CompanyMaster, 
            req.body.company_id,
            { attributes: ['id', 'company_id'] }
        );
        
        if (!record) {
            return res.error("NOT_FOUND", { message : "Invalid or missing company record."});
        }

        const company_id = record.company_id || record.id;
        
        const plan = await commonQuery.findOneRecord(
            SubscriptionPlan,
            { id: subscription_plan_id }
        );

        const existing = await commonQuery.findOneRecord(
            CompanySubscription,
            { company_id, status: 0 }
        );

        let start_date = moment().format("YYYY-MM-DD");
        if (existing && moment(existing.end_date).isAfter(moment())) {
            start_date = existing.end_date;
        }

        const end_date = moment(start_date)
            .add(plan.duration_days, "days")
            .format("YYYY-MM-DD");

        const renewData = {
            company_id,
            payment_id,
            subscription_plan_id,
            amount_paid,
            start_date,
            end_date,
            duration_days: plan.duration_days,
            ...plan.dataValues,
            status: 0,
        };

        delete renewData.id;
        delete renewData.createdAt;
        delete renewData.updatedAt;
        delete renewData.status;

        // await commonQuery.softDeleteById(CompanySubscription, { company_id: company_id }, { status: 1 }, transaction);

        const newSub = await commonQuery.createRecord(
            CompanySubscription,
            renewData,
            transaction
        );
        
        reloadCompanySubscriptionCache(newSub.id);
        await transaction.commit();
        return res.success("RENEWED", newSub);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// ----------------------------------------------
// 7️⃣ Check Subscription Validity
// ----------------------------------------------
exports.checkSubscriptionValidity = async (req, res) => {
  try {
    const { company_id } = req.body;
    const today = moment().format("YYYY-MM-DD");

    // Find ALL active subscriptions
    const subs = await commonQuery.findAllRecords(CompanySubscription, {
       company_id, 
       status: 0 
    });

    if (!subs || subs.length === 0) {
       return res.error("EXPIRED", "No active subscriptions");
    }

    let hasActiveBasePlan = false;

    for (const sub of subs) {
        // Check Expiry
        if (moment(today).isAfter(sub.end_date)) {
            await commonQuery.updateRecordById(CompanySubscription, { id: sub.id }, { status: 1 });
        } else {
            // Check if this is a BASE plan
            if (sub.SubscriptionPlan && sub.SubscriptionPlan.subscription_type === 'plan') {
                hasActiveBasePlan = true;
            }
        }
    }

    if (!hasActiveBasePlan) {
        return res.error("EXPIRED", "Base subscription expired");
    }

    return res.success("VALID", "Subscription active");

  } catch (err) {
    return res.error("ERROR", "Something went wrong", err);
  }
};

// ----------------------------------------------
// 8️⃣ Purchase Add-on (Update Limits/Features)
// ----------------------------------------------
exports.purchaseAddon = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { addon_plan_id, payment_id, branch_id, user_id, payment_status, amount_paid } = req.body;

    const record = await commonQuery.findOneRecord(
        CompanyMaster, 
        req.body.company_id,
        { attributes: ['id', 'company_id'] },
        transaction
    );
    
    if (!record) {
        await transaction.rollback();
        return res.error("NOT_FOUND", { message : "Invalid or missing company record."});
    }

    const company_id = record.company_id || record.id;

    // 1. Check if Company has a Base Plan (REQUIRED)
    const activeBase = await commonQuery.findOneRecord(CompanySubscription, {
      company_id, 
      subscription_type: 'plan', 
      status: 0 
    }, {}, transaction);

    if (!activeBase) {
      await transaction.rollback();
      return res.error("NO_BASE_PLAN", "Please purchase a base subscription first.");
    }

    // 2. Get Addon Plan Details
    const addonPlan = await commonQuery.findOneRecord(SubscriptionPlan, {
      id: addon_plan_id,
      status: 0 
    }, {}, transaction);

    if (!addonPlan) {
      await transaction.rollback();
      return res.error("INVALID_PLAN", "Addon plan not found");
    }

    // 3. Calculate Dates (Synced with Base Plan)
    const start = moment().startOf('day'); // Use startOf('day') for accurate diff
    const end = moment(activeBase.end_date).endOf('day'); 
    
    // Check if base plan is already expired
    if (end.isBefore(start)) {
        await transaction.rollback();
        return res.error("BASE_PLAN_EXPIRED", "Your base plan has expired. Please renew it first.");
    }

    // 4. Calculate Remaining Days (Effective Duration)
    const effectiveDuration = Math.max(1, end.diff(start, 'days') + 1);

    if(effectiveDuration < 30) {
        await transaction.rollback();
        return res.error("MIN_DURATION_NOT_MET", "Addon purchase requires at least 30 days remaining on the base plan. Current remaining days: " + effectiveDuration);
    }

    // 5. PRO-RATA CALCULATION
    const planDuration = addonPlan.duration_days || 365; 
    const perDayCost = Number(addonPlan.price) / planDuration;
    const calculatedPayableAmount = Math.ceil(perDayCost * effectiveDuration); 

    // 6. Prepare Data
    const subscriptionData = {
      company_id,
      branch_id,
      user_id,
      subscription_plan_id: addonPlan.id,
      amount_paid: amount_paid,
      payment_id,
      payment_status: payment_status || (payment_id ? "Paid" : "Pending"),
      start_date: start.format("YYYY-MM-DD"),
      end_date: end.format("YYYY-MM-DD"),    
      duration_days: effectiveDuration,      
      subscription_type: addonPlan.subscription_type,
      auto_renew: activeBase.auto_renew || false,
      ...addonPlan.dataValues, 
      status: 0,
    };
    
    delete subscriptionData.id;
    delete subscriptionData.createdAt;
    delete subscriptionData.updatedAt;
    
    subscriptionData.start_date = start.format("YYYY-MM-DD");
    subscriptionData.end_date = end.format("YYYY-MM-DD");
    subscriptionData.duration_days = effectiveDuration;
    subscriptionData.amount_paid = calculatedPayableAmount; 

    // 7. Create Record
    const newAddonSub = await commonQuery.createRecord(CompanySubscription, subscriptionData, transaction);
    
    await transaction.commit();
    reloadCompanySubscriptionCache(company_id);

    const responseData = {
        ...newAddonSub.toJSON(),
        plan_name: addonPlan.name,
        calculation_info: {
            base_price: addonPlan.price,
            base_duration: planDuration,
            remaining_days: effectiveDuration,
            per_day_cost: perDayCost.toFixed(2),
            final_amount: calculatedPayableAmount
        }
    };

    return res.success("ADDON_PURCHASED", responseData);

  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error(err);
    return res.error("ERROR", "Transaction failed", err);
  }
};


// ---------------------------------------------------
// Get Company Subscription (Merges All Active Rows)
// ---------------------------------------------------
exports.getCompanySubscription = async (req, res) => {
  try {
    const { company_id } = req.body;

    // 1. Fetch ALL active subscriptions (Base + Addons)
    const allSubscriptions = await commonQuery.findAllRecords(
      CompanySubscription,
      {
        company_id,
        status: 0
      }
    );

    if (!allSubscriptions || allSubscriptions.length === 0) {
      return res.success("NO_PLAN", "No active subscription", null);
    }

    let finalSub = allSubscriptions[0].toJSON ? allSubscriptions[0].toJSON() : allSubscriptions[0];

    if (allSubscriptions.length > 1) {
      for (let i = 1; i < allSubscriptions.length; i++) {
        const addon = allSubscriptions[i];
        finalSub.user_limit += (addon.user_limit || 0);
        finalSub.companies_limit += (addon.companies_limit || 0);
        finalSub.bank_accounts_limit += (addon.bank_accounts_limit || 0);
        finalSub.sms_limit += (addon.sms_limit || 0);
        finalSub.whatsapp_limit += (addon.whatsapp_limit || 0);
        finalSub.email_limit += (addon.email_limit || 0);
        finalSub.enable_sms = finalSub.enable_sms || addon.enable_sms;
        finalSub.enable_email = finalSub.enable_email || addon.enable_email;
        finalSub.enable_whatsapp = finalSub.enable_whatsapp || addon.enable_whatsapp;
      }
    }

    return res.ok({plan: allSubscriptions, totals: finalSub});
  } catch (err) {
    console.error(err);
    return res.error("ERROR", "Something went wrong", err);
  }
};

exports.deleteSubscriptionPlan = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.body;

    // Check if plan exists
    const plan = await commonQuery.findOneRecord(SubscriptionPlan, { id }, {}, transaction);
    if (!plan) {
      await transaction.rollback();
      return res.error("NOT_FOUND", "Subscription Plan not found");
    }

    await commonQuery.softDeleteById(
      SubscriptionPlan,
      { id },
      transaction
    );

    await transaction.commit();
    return res.success("PLAN_DELETED");
  } catch (err) {
    await transaction.rollback();
    return res.error("ERROR", "Something went wrong", err);
  }
};

// ----------------------------------------------
// 9️⃣ Cancel Subscription (Handles Both Modes)
// ----------------------------------------------
exports.cancelSubscription = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { company_id, subscription_id } = req.body;

    const subToCancel = await commonQuery.findOneRecord(CompanySubscription, {
      id: subscription_id,
      company_id: company_id,
      status: 0 
    });

    if (!subToCancel) {
      await transaction.rollback();
      return res.error("NOT_FOUND", "Active subscription not found");
    }

    const planDetails = await commonQuery.findOneRecord(SubscriptionPlan, {
      id: subToCancel.subscription_plan_id
    });

    if (!planDetails) {
      await transaction.rollback();
      return res.error("ERROR", "Associated plan details not found");
    }

    await commonQuery.updateRecordById(
      CompanySubscription,
      { id: subToCancel.id },
      { status: 1 }, 
      transaction
    );

    if (planDetails.subscription_type === 'plan') {
      await commonQuery.updateRecordById(
        CompanySubscription,
        { 
          company_id: company_id, 
          status: 0 
        },
        { status: 1 },
        transaction 
      );
      console.log(`Main plan cancelled for Company ${company_id}. Cascading cancel triggered for addons.`);
    } 
    
    else {
      console.log(`Addon cancelled for Company ${company_id}. Main plan remains active.`);
    }

    await transaction.commit();
    clearCompanySubscriptionCache(company_id);

    return res.success("CANCELLED");

  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error("Cancel Error:", err);
    return res.error("ERROR", "Something went wrong", err);
  }
};