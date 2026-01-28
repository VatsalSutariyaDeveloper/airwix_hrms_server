const { OtpVerification } = require("../models");
const commonQuery = require("../helpers/commonQuery");
const otpRateLimit = require("./otpRateLimit");

// Configuration
const OTP_EXPIRY_MINUTES = 1;
const IS_DEV_MODE = true; 

const generateNumericOTP = (length = 6) => {
  return Math.floor(100000 + Math.random() * 900000).toString().substring(0, length);
};

const delivery_challanSms = async (mobile_no, otp) => {
  if (IS_DEV_MODE) {
    console.log(`[OTP-SERVICE] Sending SMS to ${mobile_no} -> OTP: ${otp}`);
  }
  // Add real SMS provider logic here later
};

module.exports = {
  sendOtp: async (mobile_no, transaction) => {
    // TODO: Remove this when going live
    // const otp = generateNumericOTP(6);
    const otp = "123456";
    const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    const existing = await commonQuery.findOneRecord(OtpVerification, { mobile_no }, {}, transaction, false, false);

    if (existing) {
      await commonQuery.updateRecordById(OtpVerification, { id: existing.id }, { otp, expires_at, is_verified: 0, status: 0 }, transaction, false, false);
    } else {
      await commonQuery.createRecord(OtpVerification, { mobile_no, otp, expires_at, is_verified: 0, status: 0 }, transaction, false);
    }

    await delivery_challanSms(mobile_no, otp);
    return otp;
  },

  verifyOtp: async (mobile_no, otp) => {
    const record = await commonQuery.findOneRecord(OtpVerification, { mobile_no }, {}, null, false, false);

    // ✅ THROW OBJECTS WITH STATUS AND MESSAGE
    if (!record) {
      throw { status: "NOT_FOUND", message: "OTP request not found" };
    }

    if (record.otp !== otp) {
      throw { status: "VALIDATION_ERROR", message: "Invalid OTP" };
    }
    
    if (new Date() > new Date(record.expires_at)) {
      throw { status: "VALIDATION_ERROR", message: "OTP has expired" };
    }

    // Mark as verified
    await commonQuery.updateRecordById(OtpVerification, { id: record.id }, { is_verified: 1, status: 1 }, null, false, false);

    // 🎉 Successful OTP → Reset Limit
    await otpRateLimit.resetAttempts(mobile_no);

    return true;
  },

  cleanupOtp: async (mobile_no, transaction) => {
     const record = await commonQuery.findOneRecord(OtpVerification, { mobile_no }, {}, transaction, false, false);
     if (record) {
       await commonQuery.hardDeleteRecords(OtpVerification, { mobile_no }, transaction, false);
     }
  }
};