const { User, CompanyMaster, BranchMaster, GodownMaster, CompanyConfigration, RolePermission, CompanySubscription, SubscriptionPlan, ActivationRequest } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, otpService, uploadFile, constants, initializeCompanySettings } = require("../../helpers");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const otpRateLimit = require("../../helpers/otpRateLimit");
const moment = require("moment");
const sendEmailHelper = require("../../services/mailer");

// Send OTP for Registration
exports.sendOtp = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { mobile_no } = req.body;
    const indianMobileRegex = /^[6-9]\d{9}$/;

    if (!mobile_no || !indianMobileRegex.test(mobile_no)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, { errors: ["Invalid mobile number."] });
    }

    const errors = await validateRequest(req.body, { mobile_no: "Mobile Number" }, {
      skipDefaultRequired: ["company_id", "branch_id", "user_id"],
      uniqueCheck: { model: User, fields: ["mobile_no"], message: "Mobile number already registered." },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    // Check OTP Rate Limit
    const limitCheck = await otpRateLimit.checkRateLimit(mobile_no);
    if (!limitCheck.allowed) {
      const mins = Math.ceil(limitCheck.remaining_seconds / 60);
      await transaction.rollback();
      return res.status(400).json({
        code: 400,
        status: "TOO_MANY_REQUESTS",
        message: `Too many OTP attempts. Try again in ${mins} minutes.`,
        remaining_seconds: limitCheck.remaining_seconds
      });
    }

    // Increase attempt count
    await otpRateLimit.increaseAttempt(mobile_no);

    const otp = await otpService.sendOtp(mobile_no, transaction);

    await transaction.commit();

    return res.ok({ dev_otp: otp });
  } catch (err) {
    console.error("Error in sendOtp:", err);
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Verify OTP for Registration
exports.verifyOtp = async (req, res) => {
  try {
    const { mobile_no, otp } = req.body;
    if (!mobile_no || !otp) return res.error(constants.REQUIRED_FIELD_MISSING, { message: "Required fields missing" });

    // ✅ CLEANER ERROR HANDLING
    try {
        await otpService.verifyOtp(mobile_no, otp);
    } catch (e) {
        // If the service throws our custom error object, pass it directly
        if (e.status && e.message) {
            return res.error(e.status, { message: e.message });
        }
        throw e; // Check other errors in the main catch block
    }

    // Reset OTP rate limit after successful verification
    await otpRateLimit.resetAttempts(mobile_no);

    const registration_token = jwt.sign(
      { mobile_no: mobile_no, scope: "registration_verification" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    return res.ok({ message: "Verified", registration_token });

  } catch (err) {
    return handleError(err, res, req);
  }
};

// Register User and Company
exports.register = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const {
      registration_token,
      company_name,
      user_name,
      legal_name,
      address,
      mobile_no,
      email,
      password,
      tax_no,
      pan_no,
      business_type_id,
      website_url,
      country_id,
      state_id,
      city,
      pincode
    } = req.body;

    if (!registration_token) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, { message: "Missing registration token." });
    }

    let verifiedMobile;
    try {
        const decoded = jwt.verify(registration_token, process.env.JWT_SECRET);
        if(decoded.scope !== "registration_verification") throw new Error("Invalid token scope");
        verifiedMobile = decoded.mobile_no;
    } catch (e) {
        await transaction.rollback();
        return res.error("UNAUTHORIZED", { message: "Invalid or expired session." });
    }

    const requiredFields = {
      company_name: "Company Name",
      user_name: "User Name",
      // email: "Email", 
      // password: "Password" 
    };

    // ✅ YOUR CODE RESTORED: skipDefaultRequired is preserved
    const errors = await validateRequest(req.body, requiredFields, {
      skipDefaultRequired: ["company_id", "branch_id", "user_id"],
      uniqueCheck: { model: User, fields: ["email"] },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    // Handle logo image upload
    if (req.files?.logo_image) {
      const logoReq = {
        ...req,
        files: {
          logo_image: Array.isArray(req.files.logo_image) ? req.files.logo_image : [req.files.logo_image],
        },
      };
      const result = await uploadFile(logoReq, res, constants.COMPANY_LOGO_IMG_FOLDER, transaction);
      if (result.logo_image) {
        req.body.logo_image = result.logo_image;
      }
    }

    // 1. Create Company
    const lastCompany = await commonQuery.findOneRecord(CompanyMaster, {}, { order: [["company_code", "DESC"]] }, transaction);

    let nextNumber = 1;
    
    if (lastCompany?.company_code?.match(/\d+$/)) {
      nextNumber = parseInt(lastCompany.company_code.match(/\d+$/)[0], 10) + 1;
    }
    const company_code = `CM${String(nextNumber).padStart(3, "0")}`;

    const newCompany = await commonQuery.createRecord(CompanyMaster, {
        company_name, company_code,
        legal_name:legal_name || null,
        address:address || null,
        mobile_no:mobile_no || null,
        email:email || null,
        tax_no:tax_no || null,
        pan_no:pan_no || null,
        business_type_id:business_type_id || null,
        logo_image:req.body.logo_image || null,
        website_url:website_url || null,
        country_id: country_id || null,
        state_id: state_id || null,
        city: city || null,
        pincode: pincode || null,
        currency_id: 67,
        company_id: 0,
        status: 0,
        default_company: 1
    }, transaction);

    // 2. Create User (Step 1)
    const defaultPermission = await commonQuery.findOneRecord(RolePermission, { company_id: -1, status: 0 }, {}, transaction);
    
    let hashedPassword = null;
    if (password) {
        const salt = await bcrypt.genSalt(10);
        hashedPassword = await bcrypt.hash(password, salt);
    }

    const newUser = await commonQuery.createRecord(User, {
        user_name,
        email,
        mobile_no: verifiedMobile,
        password: hashedPassword,
        address,
        city,
        state_id,
        country_id,
        pincode,
        role_id: 1,
        permission: defaultPermission ? defaultPermission.permissions : null,
        company_id: newCompany.id,
        company_access: JSON.stringify([newCompany.id]),
        status: 0
    }, transaction);

    // 3. Create Branch
    const newBranch = await commonQuery.createRecord(BranchMaster, {
        branch_name: "Main Branch", country_id: country_id || null, state_id: state_id || null,
        city: city || null, pincode: pincode || null, is_main_branch: 1,
        company_id: newCompany.id, user_id: newUser.id 
    }, transaction);

    // 4. Update User with Branch ID
    await commonQuery.updateRecordById(User, newUser.id, { branch_id: newBranch.id }, transaction);

    // 5. Create Godown
    await commonQuery.createRecord(GodownMaster, {
        name: "Main Warehouse", address: city || "Main Location", branch_id: newBranch.id,
        company_id: newCompany.id, user_id: newUser.id
    }, transaction);

    // 6. Configs
    // const defaultSettings = await commonQuery.findAllRecords(
    //   CompanyConfigration, { company_id: -2, status: 0 }, {}, transaction, false
    // );
    // if (defaultSettings.length > 0) {
    //   const settingsPayload = defaultSettings.map(s => ({
    //     setting_key: s.setting_key, setting_value: s.setting_value, description: s.description,
    //     status: 0, company_id: newCompany.id, branch_id: newBranch.id, user_id: newUser.id
    //   }));
    //   await commonQuery.bulkCreate(CompanyConfigration, settingsPayload, { company_id: newCompany.id }, transaction);
    // }
    await initializeCompanySettings(newCompany.id, newBranch.id, newUser.id, transaction);

    // ---------------------------------------------------------
    // 🆕 NEW LOGIC: START 2-DAY FREE TRIAL
    // ---------------------------------------------------------
    
    // A. Find a "Template" Plan to copy features from.
    // Ideally, fetch a plan named 'Trial' or the 'Premium' plan so they see all features.
    // If no plan exists, we can't create a subscription (Database constraint).
    const trialBasePlan = await commonQuery.findOneRecord(
        SubscriptionPlan, 
        { status: 0 }, // Get any active plan
        { order: [['price', 'DESC']] }, // Tip: Give them the BEST plan for the trial (Highest Price)
        transaction
    );

    if (trialBasePlan) {
        const startDate = moment().format("YYYY-MM-DD");
        const endDate = moment().add(2, "days").format("YYYY-MM-DD"); // 2 Days Validity

        // B. Prepare the Trial Data
        // We copy all "enable_xxx" features from the plan so the trial works exactly like the real thing
        const trialSubscriptionData = {
            company_id: newCompany.id,
            subscription_plan_id: trialBasePlan.id,
            amount_paid: 0,
            payment_id: "TRIAL_Start",
            start_date: startDate,
            end_date: endDate,
            duration_days: 2,
            is_trial: true, // <--- Flag this as a Trial
            status: 0,      // Active
            branch_id: newBranch.id, 
            user_id: newUser.id,
            
            // Copy Limits from the plan
            user_limit: trialBasePlan.user_limit,
            companies_limit: trialBasePlan.companies_limit,
            // ... (You can spread the rest of the plan details if your DB structure matches)
            ...trialBasePlan.toJSON(), // safely copies enable_invoicing, enable_gst, etc.
        };

        // Clean up fields that shouldn't be copied from the plan to the sub
        delete trialSubscriptionData.id;
        delete trialSubscriptionData.createdAt;
        delete trialSubscriptionData.updatedAt;
        delete trialSubscriptionData.price;
        delete trialSubscriptionData.name; // Keep the plan name separate if needed, or don't copy it

        // C. Create the Subscription Record
        await commonQuery.createRecord(CompanySubscription, trialSubscriptionData, transaction);
        
        console.log(`Trial started for Company ${newCompany.id} until ${endDate}`);
    } else {
        console.warn("No Subscription Plans found. Skipping Trial creation.");
    }

    // ---------------------------------------------------------
    // 🆕 END NEW LOGIC
    // ---------------------------------------------------------

    await otpService.cleanupOtp(verifiedMobile, transaction);

    await transaction.commit();

    const token = jwt.sign(
      {
        id: newUser.id,
        company_id: newUser.company_id
      },
      process.env.JWT_SECRET || "your_jwt_secret",
      { expiresIn: "1d" }
    );

    return res.ok({ token, user_id: newUser.id, company_id: newCompany.id, email: newUser.email });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Handle Account Activation Request
 */
exports.requestActivation = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { company_id, user_id, message } = req.body;

    if (!company_id) {
      await transaction.rollback();
      return res.error(constants.REQUIRED_FIELD_MISSING, { message: "Company ID is required." });
    }

    const company = await commonQuery.findOneRecord(
      CompanyMaster, 
      company_id, 
      {}, 
      transaction
    );

    if (!company) {
      await transaction.rollback();
      return res.error(constants.COMPANY_NOT_FOUND);
    }

    if (company.status === 0) {
      await transaction.rollback();
      return res.error(constants.ACCOUNT_ALREADY_ACTIVE);
    }

    const user = await commonQuery.findOneRecord(
      User,
      { id: user_id },
      {},
      transaction
    );

    if (!user) {
        await transaction.rollback();
        return res.error(constants.USER_NOT_FOUND);
    }

    await commonQuery.createRecord(
      ActivationRequest,
      {
        company_id,
        user_id,
        request_message: message || "Please reactive my account.",
        status: 'pending'
      },
      transaction
    );

    const adminEmail = process.env.ADMIN_EMAIL || "info@airwix.in"; 
    const companyEmail = company.email || user.email;

    const emailSubject = `📢 Activation Request: ${company.company_name}`;
    const emailMessage = `
      <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
        <h2 style="color: #2563eb;">Account Activation Request</h2>
        <p>A new company has requested account activation.</p>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold; width: 150px;">Company Name:</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${company.company_name}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Company Email:</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${company.email || 'N/A'}</td>
          </tr>
           <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Requested By:</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${user.user_name}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">User Email:</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${user.email}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; font-weight: bold;">Mobile No:</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${user.mobile_no}</td>
          </tr>
        </table>

        <p style="margin-top: 20px; color: #666;">
          Please review this request in the Admin Panel and take appropriate action.
        </p>
      </div>
    `;

    // Using the sendEmailHelper structure you provided
    await sendEmailHelper({
      from: companyEmail,      // "passed companyid's email"
      email: [adminEmail],     // "master company mail"
      company_id: company_id,
      subject: emailSubject,
      message: emailMessage,
    });
    
    // For now, we return success so the frontend knows the request was received
    await transaction.commit();
    return res.success("ACTIVATION_REQUEST_SENT", { 
        message: "Activation request submitted successfully. Support will contact you shortly." 
    });

  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};