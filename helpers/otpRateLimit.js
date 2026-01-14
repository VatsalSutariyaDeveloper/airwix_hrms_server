const NodeCache = require("node-cache");

// Initialize cache
// stdTTL: 0 means infinite by default (we will set specific TTLs manually)
// checkperiod: 60 means it checks for expired keys every 60 seconds to clean memory
const cache = new NodeCache({ stdTTL: 0, checkperiod: 60 });

const MAX_OTP_LIMIT = 3;
const BLOCK_TIME_SECONDS = 60 * 60; // 1 hour

module.exports = {
  checkRateLimit: async (mobile_no) => {
    const key = `otp_limit:${mobile_no}`;
    const attempts = cache.get(key);

    if (attempts === undefined) {
      // No record exists, allow OTP
      return { allowed: true };
    }

    if (Number(attempts) >= MAX_OTP_LIMIT) {
      // Calculate remaining time
      const meta = cache.getTtl(key); // Returns timestamp in milliseconds
      const remainingMs = meta ? meta - Date.now() : 0;
      const remainingSeconds = Math.ceil(remainingMs / 1000);

      return {
        allowed: false,
        message: `You have exceeded OTP limit. Try again after 1 hour`,
        remaining_seconds: remainingSeconds > 0 ? remainingSeconds : 0
      };
    }

    return { allowed: true };
  },

  increaseAttempt: async (mobile_no) => {
    const key = `otp_limit:${mobile_no}`;
    const attempts = cache.get(key);

    if (attempts === undefined) {
      // First attempt: Set value to 1 and expire in 1 hour
      cache.set(key, 1, BLOCK_TIME_SECONDS);
    } else {
      // Subsequent attempts: Increase count BUT keep original expiration time
      const currentTTLInfo = cache.getTtl(key);
      let remainingSeconds = 0;
      
      if (currentTTLInfo) {
          remainingSeconds = Math.ceil((currentTTLInfo - Date.now()) / 1000);
      }

      // If for some reason it's already expired, reset full time, otherwise keep remaining
      const ttlToSet = remainingSeconds > 0 ? remainingSeconds : BLOCK_TIME_SECONDS;
      
      cache.set(key, Number(attempts) + 1, ttlToSet);
    }
  },

  resetAttempts: async (mobile_no) => {
    const key = `otp_limit:${mobile_no}`;
    cache.del(key);
  },

  // Get blocked number details
  getBlockedNumberInfo: async (mobile_no) => {
    const key = `otp_limit:${mobile_no}`;
    const attempts = cache.get(key);
    
    // Calculate TTL
    const meta = cache.getTtl(key);
    const remainingMs = meta ? meta - Date.now() : 0;
    const ttl = Math.ceil(remainingMs / 1000);

    if (attempts === undefined) {
      return {
        is_blocked: false,
        message: "Number is not blocked"
      };
    }

    const attemptsCount = Number(attempts);
    const isBlocked = attemptsCount >= MAX_OTP_LIMIT;

    return {
      is_blocked: isBlocked,
      attempts: attemptsCount,
      max_attempts: MAX_OTP_LIMIT,
      remaining_attempts: MAX_OTP_LIMIT - attemptsCount,
      ttl_seconds: ttl > 0 ? ttl : 0,
      ttl_minutes: ttl > 0 ? Math.ceil(ttl / 60) : 0,
      message: isBlocked
        ? `Number is blocked. ${Math.ceil(ttl / 60)} minutes remaining`
        : `${attemptsCount} attempts used. ${MAX_OTP_LIMIT - attemptsCount} remaining`
    };
  },

  // Get all blocked numbers
  getAllBlockedNumbers: async () => {
    // node-cache keys() returns an array of all keys
    const allKeys = cache.keys();
    
    // Filter only keys related to otp_limit
    const limitKeys = allKeys.filter(k => k.startsWith("otp_limit:"));

    if (limitKeys.length === 0) {
      return {
        total_tracked: 0,
        blocked_numbers: [],
        active_numbers: []
      };
    }

    const blockedNumbers = [];
    const activeNumbers = [];

    for (const key of limitKeys) {
      const mobile_no = key.replace("otp_limit:", "");
      const attempts = cache.get(key);
      
      const meta = cache.getTtl(key);
      const remainingMs = meta ? meta - Date.now() : 0;
      const ttl = Math.ceil(remainingMs / 1000);

      const attemptsCount = Number(attempts);
      const isBlocked = attemptsCount >= MAX_OTP_LIMIT;

      const numberInfo = {
        mobile_no,
        attempts: attemptsCount,
        max_attempts: MAX_OTP_LIMIT,
        ttl_seconds: ttl > 0 ? ttl : 0,
        ttl_minutes: ttl > 0 ? Math.ceil(ttl / 60) : 0
      };

      if (isBlocked) {
        blockedNumbers.push(numberInfo);
      } else {
        activeNumbers.push(numberInfo);
      }
    }

    return {
      total_tracked: limitKeys.length,
      blocked_count: blockedNumbers.length,
      active_count: activeNumbers.length,
      blocked_numbers: blockedNumbers,
      active_numbers: activeNumbers
    };
  }
};