const axios = require("axios");
const { OtpVerification } = require("../models");
const otpRateLimit = require("./otpRateLimit");
const emailService = require("../services/emailService");
const { isValidIndianMobile } = require("./phoneValidation");
const { constants } = require("./constants");

// Configuration
const OTP_EXPIRY_MINUTES = 10;

const generateNumericOTP = (length = 6) => {
  return Math.floor(100000 + Math.random() * 900000).toString().substring(0, length);
};

const { sendTemplateSMS } = require('./smsService');

const sendOtpToSms = async (mobile_no, otp, shouldSendSms = true) => {
  const templateId = process.env.MSG91_AIRWIX_PAYROLL_OTP_TEMPLATE_ID;
  if (!templateId) {
    console.warn('[OTP-SERVICE] OTP template not configured');
    return;
  }
  try {
    return await sendTemplateSMS(mobile_no, templateId, { otp }, shouldSendSms);
  } catch (err) {
    const statusCode = err.response?.status || 500;
    const errorData = err.response?.data || err.message;
    console.error(`[OTP-SERVICE] MSG91 API Error`, { statusCode, error: errorData });
    throw new Error(`MSG91 Error (${statusCode}): ${typeof errorData === 'string' ? errorData : JSON.stringify(errorData)}`);
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

    const isExceptionEmail = isEmailAddress && constants.OTP_EMAIL_EXCEPTIONS.includes(identifier.trim().toLowerCase());
    const isExceptionMobile = !isEmailAddress && (
      constants.OTP_MOBILE_EXCEPTIONS.includes(identifier) ||
      constants.OTP_MOBILE_EXCEPTIONS.includes(identifier.replace(/\D/g, "").slice(-10))
    );
    const isException = isExceptionEmail || isExceptionMobile;

    // Check Rate Limit (skip for exceptions)
    if (!isException) {
      const rateLimit = await otpRateLimit.checkRateLimit(identifier);
      if (!rateLimit.allowed) {
        throw { status: "RATE_LIMIT_ERROR", message: rateLimit.message };
      }
    }

    // 🛠️ DEVELOPMENT MODE or EXCEPTION: Use a static OTP
    const isLocal = process.env.NODE_ENV === 'local';
    const otp = (isLocal || isException) ? "123456" : generateNumericOTP(6);
    const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    if (isLocal || isException) {
      console.log(`\n-----------------------------------------`);
      console.log(`🛠️  [BYPASS/DEV-MODE] OTP for ${identifier}: ${otp}`);
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
    if (isLocal || isException) {
      // In local mode or exception list, we do not send actual email/SMS
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
    const isEmailAddress = isEmail(identifier);
    const isExceptionEmail = isEmailAddress && constants.OTP_EMAIL_EXCEPTIONS.includes(identifier.trim().toLowerCase());
    const isExceptionMobile = !isEmailAddress && (
      constants.OTP_MOBILE_EXCEPTIONS.includes(identifier) ||
      constants.OTP_MOBILE_EXCEPTIONS.includes(identifier.replace(/\D/g, "").slice(-10))
    );
    const isException = isExceptionEmail || isExceptionMobile;

    // 🛠️ DEVELOPMENT BYPASS: Accept 123456 as a universal OTP in local mode or exceptions
    if ((isLocal || isException) && otp === "123456") {
      console.log(`🛠️  [BYPASS/DEV-MODE] Universal OTP Verification bypassed for ${identifier}`);
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