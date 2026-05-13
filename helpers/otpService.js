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
    const templateId = process.env.MSG91_TEMPLATE_ID;
    
    if (!authKey || !templateId) {
      console.warn(
        "[OTP-SERVICE] MSG91_AUTH_KEY or MSG91_TEMPLATE_ID is not configured."
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

    // Increase attempt count
    await otpRateLimit.increaseAttempt(identifier);

    // TODO: Remove this hardcoded OTP when going live
    const otp = generateNumericOTP(6);
    // const otp = "123456";
    const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

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

    // Resolve company_id to check settings
    let resolvedCompanyId = companyId;
    if (!resolvedCompanyId) {
      try {
        const { User, Employee } = require("../models");
        let record;
        if (isEmailAddress) {
          record = await User.findOne({ where: { email: identifier }, transaction, attributes: ["company_id"] });
        } else {
          record = await User.findOne({ where: { mobile_no: identifier }, transaction, attributes: ["company_id"] }) ||
                   await Employee.findOne({ where: { mobile_no: identifier }, transaction, attributes: ["company_id"] });
        }
        if (record) {
          resolvedCompanyId = record.company_id;
        }
      } catch (e) {
        console.error("[OTP-SERVICE] Error resolving company ID:", e.message);
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
    if (isEmailAddress) {
      await emailService.sendOtpToEmail(identifier, otp);
    } else {
      await sendOtpToSms(identifier, otp, shouldSendSms);
    }

    return otp;
  },

  verifyOtp: async (identifier, otp) => {
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