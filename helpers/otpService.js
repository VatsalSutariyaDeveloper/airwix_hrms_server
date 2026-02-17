const { OtpVerification } = require("../models");
const otpRateLimit = require("./otpRateLimit");

// Configuration
const OTP_EXPIRY_MINUTES = 10;
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
    // TODO: Remove this hardcoded OTP when going live
    // const otp = generateNumericOTP(6);
    const otp = "123456";
    const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    const existing = await OtpVerification.findOne({
      where: { mobile_no },
      transaction
    });

    if (existing) {
      await OtpVerification.update(
        { otp, expires_at, is_verified: 0, status: 0 },
        { where: { id: existing.id }, transaction }
      );
    } else {
      await OtpVerification.create(
        { mobile_no, otp, expires_at, is_verified: 0, status: 0 },
        { transaction }
      );
    }

    await delivery_challanSms(mobile_no, otp);
    return otp;
  },

  verifyOtp: async (mobile_no, otp) => {
    const record = await OtpVerification.findOne({
      where: { mobile_no }
    });

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
    await OtpVerification.update(
      { is_verified: 1, status: 1 },
      { where: { id: record.id } }
    );

    // 🎉 Successful OTP → Reset Limit
    await otpRateLimit.resetAttempts(mobile_no);

    return true;
  },

  cleanupOtp: async (mobile_no, transaction) => {
     await OtpVerification.destroy({
       where: { mobile_no },
       transaction
     });
  }
};