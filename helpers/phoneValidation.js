/**
 * Phone Validation Utility
 * Validates Indian mobile numbers: 10 digits starting with 6, 7, 8, or 9
 */

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

/**
 * Validates if a phone number is a valid Indian mobile number
 * @param {string} phone - Phone number to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function isValidIndianMobile(phone) {
  if (!phone || typeof phone !== 'string') {
    return false;
  }
  
  // Remove any spaces, dashes, or country codes
  const cleanPhone = phone.replace(/[\s-]/g, '').replace(/^\+91/, '');
  
  return INDIAN_MOBILE_REGEX.test(cleanPhone);
}

/**
 * Validates phone number and returns error message if invalid
 * @param {string} phone - Phone number to validate
 * @param {string} fieldName - Field name for error message (optional)
 * @returns {object} - { isValid: boolean, error: string|null }
 */
function validatePhone(phone, fieldName = 'Mobile number') {
  if (!phone) {
    return {
      isValid: false,
      error: `${fieldName} is required.`
    };
  }
  
  if (!isValidIndianMobile(phone)) {
    return {
      isValid: false,
      error: `Invalid ${fieldName.toLowerCase()}. Must be 10 digits starting with 6, 7, 8, or 9.`
    };
  }
  
  return {
    isValid: true,
    error: null
  };
}

/**
 * Middleware function to validate phone number in request body
 * @param {string} fieldName - Field name to validate (default: 'mobile_no')
 * @returns {function} - Express middleware function
 */
function validatePhoneMiddleware(fieldName = 'mobile_no') {
  return (req, res, next) => {
    const phone = req.body[fieldName];
    
    if (!phone) {
      return res.error('VALIDATION_ERROR', { 
        [fieldName]: `${fieldName} is required.` 
      });
    }
    
    if (!isValidIndianMobile(phone)) {
      return res.error('VALIDATION_ERROR', { 
        [fieldName]: `Invalid ${fieldName}. Must be 10 digits starting with 6, 7, 8, or 9.` 
      });
    }
    
    next();
  };
}

module.exports = {
  isValidIndianMobile,
  validatePhone,
  validatePhoneMiddleware,
  INDIAN_MOBILE_REGEX
};
