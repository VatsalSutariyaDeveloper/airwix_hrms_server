const axios = require("axios");
const { OtpVerification } = require("../models");
const otpRateLimit = require("./otpRateLimit");
const emailService = require("../services/emailService");
const { isValidIndianMobile } = require("./phoneValidation");

// Configuration
const OTP_EXPIRY_MINUTES = 10;

const generateNumericOTP = (length = 6) => {
  return Math.floor(100000 + Math.random() * 900000).toString().substring(0, length);
};

const sendOtpToSms = async (mobile_no, otp, shouldSendSms = true) => {
  try {
    if (!shouldSendSms) {
      console.log(`[OTP-SERVICE] Sending SMS to ${mobile_no} -> OTP: ${otp} (Bypassed MSG91 because ${!shouldSendSms ? 'otp_sms_send setting is disabled' : 'IS_DEV_MODE is true'})`);
      return;
    }

    const authKey = process.env.MSG91_AUTH_KEY;
    const templateId = process.env.MSG91_AIRWIX_PAYROLL_OTP_TEMPLATE_ID;
    
    if (!authKey || !templateId) {
      console.warn(
        "[OTP-SERVICE] MSG91_AUTH_KEY or MSG91_AIRWIX_PAYROLL_OTP_TEMPLATE_ID is not configured."
      );
      return;
    }

    // Format mobile number
    let formattedMobile = mobile_no.toString().trim().replace(/^\+/, "");

    if (formattedMobile.length === 10) {
      formattedMobile = `91${formattedMobile}`;
    }

    const response = await axios.post(
      "https://control.msg91.com/api/v5/flow/",
      {
        template_id: templateId,
        short_url: "0",
        recipients: [
          {
            mobiles: formattedMobile,
            otp: otp
          }
        ]
      },
      {
        headers: {
          authkey: authKey,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(
      `[OTP-SERVICE] SMS Sent Successfully`,
      {
        status: response.status,
        data: response.data,
      }
    );

    return response.data;

  } catch (err) {

    const statusCode = err.response?.status || 500;
    const errorData = err.response?.data || err.message;

    console.error(`[OTP-SERVICE] MSG91 API Error`, {
      statusCode,
      error: errorData,
    });

    throw new Error(
      `MSG91 Error (${statusCode}): ${
        typeof errorData === "string"
          ? errorData
          : JSON.stringify(errorData)
      }`
    );
  }
};

const isEmail = (identifier) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(identifier);
};

module.exports = {
  sendOtp: async (identifier, transaction, companyId = null) => {
    const isEmailAddress = isEmail(identifier);
    if (!isEmailAddress && !isValidIndianMobile(identifier)) {
      throw { status: "VALIDATION_ERROR", message: "Invalid mobile number. Must be a valid Indian mobile number." };
    }

    // Check Rate Limit
    const rateLimit = await otpRateLimit.checkRateLimit(identifier);
    if (!rateLimit.allowed) {
      throw { status: "RATE_LIMIT_ERROR", message: rateLimit.message };
    }

    // 🛠️ DEVELOPMENT MODE: Use a static OTP if running locally
    const isLocal = process.env.NODE_ENV === 'local';
    const otp = isLocal ? "123456" : generateNumericOTP(6);
    const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    if (isLocal) {
      console.log(`\n-----------------------------------------`);
      console.log(`🛠️  [DEV-MODE] OTP for ${identifier}: ${otp}`);
      console.log(`-----------------------------------------\n`);
    }

    const existing = await OtpVerification.findOne({
      where: { identifier },
      transaction
    });

    if (existing) {
      await OtpVerification.update(
        { otp, expires_at, is_verified: 0, status: 0 },
        { where: { id: existing.id }, transaction }
      );
    } else {
      await OtpVerification.create(
        { identifier, otp, expires_at, is_verified: 0, status: 0 },
        { transaction }
      );
    }

    // Resolve company_id and userName to personalize email
    let resolvedCompanyId = companyId;
    let userName = "User";
    if (true) { // Always try to find user info for personalization
      try {
        const { User, DeviceMaster } = require("../models");
        let record;
        if (isEmailAddress) {
          record = await User.findOne({ where: { email: identifier, status: 0 }, transaction, attributes: ["company_id", "user_name"] });
        } else {
          record = await User.findOne({ where: { mobile_no: identifier, status: 0 }, transaction, attributes: ["company_id", "user_name"] }) ||
                   await DeviceMaster.findOne({ where: { mobile_no: identifier, status: 0 }, transaction, attributes: ["company_id", "device_name"] });
        }
        if (record) {
          resolvedCompanyId = record.company_id || resolvedCompanyId;
          userName = record.user_name || record.device_name || "User";
        }
      } catch (e) {
        console.error("[OTP-SERVICE] Error resolving user info:", e.message);
      }
    }

    let shouldSendSms = true;
    if (resolvedCompanyId) {
      try {
        const { getCompanySetting } = require("./cache");
        const companySettings = await getCompanySetting(resolvedCompanyId);
        if (companySettings && companySettings.otp_sms_send === false) {
          shouldSendSms = false;
        }
      } catch (e) {
        console.error("[OTP-SERVICE] Error checking company settings:", e.message);
      }
    }

    // Send OTP via SMS or Email based on identifier type
    let isSent = false;
    if (isLocal) {
      // In local mode, we already logged the OTP above, no need to send actual email/SMS
      isSent = true;
    } else if (isEmailAddress) {
      await emailService.sendOtpToEmail(identifier, otp, userName);
      isSent = true;
    } else {
      const response = await sendOtpToSms(identifier, otp, shouldSendSms);
      // If bypassed (shouldSendSms=false), response is undefined but we count it as "sent"
      // If sent via MSG91, we check if the API returned success
      if (!shouldSendSms || (response && response.type === "success")) {
        isSent = true;
      }
    }

    // Increase attempt count only after successful delivery
    if (isSent) {
      await otpRateLimit.increaseAttempt(identifier);
    }
    return otp;
  },

  verifyOtp: async (identifier, otp) => {
    const isLocal = process.env.NODE_ENV === 'local';
    
    // 🛠️ DEVELOPMENT BYPASS: Accept 123456 as a universal OTP in local mode
    if (isLocal && otp === "123456") {
      console.log(`🛠️  [DEV-MODE] Universal OTP Verification bypassed for ${identifier}`);
      return true;
    }

    const record = await OtpVerification.findOne({
      where: { identifier }
    });

    // ✅ THROW OBJECTS WITH STATUS AND MESSAGE
    if (!record) {
      throw { status: "NOT_FOUND", message: "OTP request not found" };
    }

    if (record.otp != otp) {
      throw { status: "VALIDATION_ERROR", message: "Invalid OTP" };
    }

    if (new Date() > new Date(record.expires_at)) {
      throw { status: "VALIDATION_ERROR", message: "OTP has expired" };
    }

    // Mark as verified
    await OtpVerification.update(
      { is_verified: 1, status: 1 },
      { where: { id: record.id } }
    );

    // 🎉 Successful OTP → Reset Limit
    await otpRateLimit.resetAttempts(identifier);

    return true;
  },

  cleanupOtp: async (identifier, transaction) => {
     await OtpVerification.destroy({
       where: { identifier },
       transaction
     });
  }
};