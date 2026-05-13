const { CustomField } = require("../models");
const { getContext } = require("../utils/requestContext");
const { validatePhone } = require("./phoneValidation");

/**
 * Validates PF Number format
 * Expected format: GJ/12345/000 (state code/number/suffix)
 */
function validatePFNumber(pfNumber) {
  if (!pfNumber || typeof pfNumber !== 'string') return { isValid: false, error: 'Invalid PF number format' };
  
  const trimmed = pfNumber.trim().toUpperCase();
  const pfRegex = /^[A-Z]{2}\/\d{5,6}\/\d{3}$/;
  
  if (!pfRegex.test(trimmed)) {
    return { isValid: false, error: 'Invalid PF number format (e.g. GJ/12345/000)' };
  }
  
  return { isValid: true, value: trimmed };
}

/**
 * Validates ESI Number format
 * Expected format: 17 digits only
 */
function validateESINumber(esiNumber) {
  if (!esiNumber || typeof esiNumber !== 'string') return { isValid: false, error: 'Invalid ESI number format' };
  
  const trimmed = esiNumber.trim();
  const esiRegex = /^\d{17}$/;
  
  if (!esiRegex.test(trimmed)) {
    return { isValid: false, error: 'ESI number must be exactly 17 digits (numbers only)' };
  }
  
  return { isValid: true, value: trimmed };
}
/**
 * Validates required fields, types, and uniqueness.
 * Returns FIELD → ERROR CODE mapping
 *
 * @returns {Promise<Object>} - { field: ERROR_CODE }
 */

async function validateRequest(body, fieldsWithLabels = {}, options = {}, transaction = null) {
  const errors = {};
  const ctx = getContext();

  // Trim all string fields
  for (const key in body) {
    if (typeof body[key] === "string") {
      body[key] = body[key].trim();
    }
  }

  const {
    fieldTypes = {},
    uniqueCheck,
    skipDefaultRequired = [],
  } = options;

  /* =========================
     DEFAULT REQUIRED NUMBERS
     ========================= */
  const DEFAULT_REQUIRED_NUMBERS = {};

  for (const field in DEFAULT_REQUIRED_NUMBERS) {
    if (skipDefaultRequired.includes(field)) continue;

    const value = body[field];
    const isEmpty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");

    if (isEmpty) {
      errors[field] = "REQUIRED";
    } else if (Number(value) === 0) {
      errors[field] = "INVALID_NUMBER";
    } else {
      body[field] = Number(value);
    }
  }

  /* =========================
     USER DEFINED REQUIRED
     ========================= */
  for (const field in fieldsWithLabels) {
    if (field in DEFAULT_REQUIRED_NUMBERS) continue;
    if (errors[field]) continue;

    const value = body[field];
    const isEmpty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");

    if (isEmpty) {
      errors[field] = "REQUIRED";
      continue;
    }

    const expectedType = fieldTypes[field];

    if (expectedType === "number") {
      const num = Number(value);
      if (isNaN(num) || typeof value === "boolean") {
        errors[field] = "INVALID_NUMBER";
      } else {
        body[field] = num;
      }
    }

    if (expectedType === "string" && typeof value !== "string") {
      errors[field] = "INVALID_STRING";
    }

    // Auto-detect phone fields by name pattern if not explicitly typed
    const isPhoneField = expectedType === "phone" || 
                        (field.toLowerCase().includes('phone') || 
                         field.toLowerCase().includes('mobile') || 
                         field.toLowerCase().includes('contact') ||
                         field.toLowerCase().startsWith('mob') ||
                         field.toLowerCase() === 'mobile_no' ||
                         field.toLowerCase() === 'mobile number' ||
                         field.toLowerCase() === 'phone number' ||
                         field.toLowerCase().replace(/[^a-z]/g, '') === 'monumber' ||
                         field.toLowerCase().replace(/[^a-z]/g, '') === 'mono');
    
    if (isPhoneField && typeof value === 'string') {
      const phoneValidation = validatePhone(value, fieldsWithLabels[field] || field);
      if (!phoneValidation.isValid) {
        errors[field] = "INVALID_PHONE";
      }
    }

    // PF Number validation
    if (field.toLowerCase() === 'pf_number' && typeof value === 'string' && value.trim() !== '') {
      const pfValidation = validatePFNumber(value);
      if (!pfValidation.isValid) {
        errors[field] = "INVALID_PF_NUMBER";
      } else {
        body[field] = pfValidation.value;
      }
    }

    // ESI Number validation
    if (field.toLowerCase() === 'esi_number' && typeof value === 'string' && value.trim() !== '') {
      const esiValidation = validateESINumber(value);
      if (!esiValidation.isValid) {
        errors[field] = "INVALID_ESI_NUMBER";
      } else {
        body[field] = esiValidation.value;
      }
    }
  }

  /* =========================
     TYPE VALIDATION
     ========================= */
  for (const field in fieldTypes) {
    if (field in DEFAULT_REQUIRED_NUMBERS) continue;
    if (errors[field]) continue;

    const value = body[field];
    const isEmpty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "");

    if (isEmpty) {
      errors[field] = "REQUIRED";
      continue;
    }

    if (fieldTypes[field] === "number") {
      const num = Number(value);
      if (isNaN(num) || typeof value === "boolean") {
        errors[field] = "INVALID_NUMBER";
      } else {
        body[field] = num;
      }
    }

    // Auto-detect phone fields by name pattern if not explicitly typed
    const isPhoneField = fieldTypes[field] === "phone" || 
                        (field.toLowerCase().includes('phone') || 
                         field.toLowerCase().includes('mobile') || 
                         field.toLowerCase().includes('contact') ||
                         field.toLowerCase().startsWith('mob') ||
                         field.toLowerCase() === 'mobile_no' ||
                         field.toLowerCase() === 'mobile number' ||
                         field.toLowerCase() === 'phone number' ||
                         field.toLowerCase().replace(/[^a-z]/g, '') === 'monumber' ||
                         field.toLowerCase().replace(/[^a-z]/g, '') === 'mono');
    
    if (isPhoneField && typeof value === 'string') {
      const phoneValidation = validatePhone(value, fieldsWithLabels[field] || field);
      if (!phoneValidation.isValid) {
        errors[field] = "INVALID_PHONE";
      }
    }

    // PF Number validation
    if (field.toLowerCase() === 'pf_number' && typeof value === 'string' && value.trim() !== '') {
      const pfValidation = validatePFNumber(value);
      if (!pfValidation.isValid) {
        errors[field] = "INVALID_PF_NUMBER";
      } else {
        body[field] = pfValidation.value;
      }
    }

    // ESI Number validation
    if (field.toLowerCase() === 'esi_number' && typeof value === 'string' && value.trim() !== '') {
      const esiValidation = validateESINumber(value);
      if (!esiValidation.isValid) {
        errors[field] = "INVALID_ESI_NUMBER";
      } else {
        body[field] = esiValidation.value;
      }
    }
  }

  /* =========================
     UNIQUE CHECK
     ========================= */
  const checks = Array.isArray(uniqueCheck) ? uniqueCheck : [uniqueCheck];

  for (const check of checks) {
    if (check?.model && Array.isArray(check.fields)) {
      const { model, fields, excludeId, excludeCompany = false, excludeBranch = false, excludeStatus = false, where: customWhere, errorCode } = check;
      const { Op } = require("sequelize");

      const fieldSets = Array.isArray(fields[0]) ? fields : fields.map((f) => [f]);

      for (const fieldSet of fieldSets) {
        const where = {};

        // Apply custom where conditions first (if provided)
        if (customWhere && typeof customWhere === 'object') {
          Object.assign(where, customWhere);
        }

        // Track if any fields from this set were actually provided in the body
        let fieldsAddedFromSet = 0;
        fieldSet.forEach((field) => {
          const value = body[field];
          // Only include field in unique check if it has a non-empty, valid value
          const isValidValue = value !== undefined && value !== null && value !== "" && value !== "undefined" && value !== "null";

          if (isValidValue) {
            where[field] = value;
            fieldsAddedFromSet++;
          }
        });

        // If no primary unique fields were provided, no need to run the check
        if (fieldsAddedFromSet === 0) {
          continue;
        }

        if (!excludeCompany && ctx.company_id !== undefined) {
          where.company_id = ctx.company_id;
        }

        if (!excludeBranch && ctx.branch_id !== undefined) {
          where.branch_id = ctx.branch_id;
        }

        if (!excludeStatus) {
          where.status = { [Op.ne]: 2 };
        }

        if (excludeId) {
          where.id = Array.isArray(excludeId)
            ? { [Op.notIn]: excludeId }
            : { [Op.ne]: excludeId };
        }

        const exists = await model.findOne({ where, transaction });

        if (exists) {
          fieldSet.forEach((field) => {
            errors[field] = errorCode || "ALREADY_EXISTS";
          });
        }
      }
    }
  }

  /* =========================
     CUSTOM FIELD VALIDATION
     ========================= */
  if (options.customFieldConfig) {
    const { entity_id, dataKey } = options.customFieldConfig;
    
    if (entity_id && ctx.company_id) {
      const customRules = await CustomField.findAll({
        where: { entity_id, company_id: ctx.company_id, status: 0 },
        attributes: ['field_name', 'field_label', 'is_mandatory', 'field_type', 'options'],
        transaction 
      });

      // If dataKey (e.g., 'custom_fields') is provided, look inside that object, otherwise check root body
      const inputData = dataKey ? (body[dataKey] || {}) : (body.custom_fields || body);

      for (const rule of customRules) {
        const value = inputData[rule.field_name];

        // 1. Mandatory Check
        if (rule.is_mandatory) {
          const isValueEmpty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
          if (isValueEmpty) {
            errors[rule.field_name] = "REQUIRED";
            continue;
          }
        }

        // 2. Data Type & Option Validation
        if (value !== undefined && value !== null && value !== '') {
          // Check Number
          if (rule.field_type === 'number') {
            if (isNaN(Number(value))) {
              errors[rule.field_name] = "INVALID_NUMBER";
            }
          }

          // Check Select/Radio Options
          if (['select', 'radio'].includes(rule.field_type) && rule.options) {
             const opts = Array.isArray(rule.options) ? rule.options : [];
             const validValues = opts.map(o => (typeof o === 'object' ? o.value : o));
             
             // Use loose equality (==) to handle string '1' vs number 1 scenarios
             // eslint-disable-next-line eqeqeq
             const isValidOption = validValues.some(v => v == value);
             if (!isValidOption) {
               errors[rule.field_name] = "INVALID_OPTION";
             }
          }
        }
      }
    }
  }

  return Object.keys(errors).length ? errors : null;
}

module.exports = validateRequest;