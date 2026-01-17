const { CustomField } = require("../models");
const { getContext } = require("../utils/requestContext");
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
  }

  /* =========================
     UNIQUE CHECK
     ========================= */
  if (uniqueCheck?.model && Array.isArray(uniqueCheck.fields)) {
    const { model, fields, excludeId, excludeCompany=false, excludeStatus=false, where: customWhere, errorCode } = uniqueCheck;
    const { Op } = require("sequelize");

    const fieldSets = Array.isArray(fields[0]) ? fields : fields.map((f) => [f]);

    for (const fieldSet of fieldSets) {
      const where = {};

      // Apply custom where conditions first (if provided)
      if (customWhere && typeof customWhere === 'object') {
        Object.assign(where, customWhere);
      }

      // Add all fields in the set
      fieldSet.forEach((field) => {
        if (body[field] !== undefined && body[field] !== null) {
          where[field] = body[field];
        }
      });
      
      if (Object.keys(where).length === 0) {
        continue;
      }

      if(!excludeCompany && ctx.companyId !== undefined){
        where.company_id = ctx.companyId;
      }

      if(!excludeStatus){
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

  /* =========================
     CUSTOM FIELD VALIDATION
     ========================= */
  if (options.customFieldConfig) {
    const { entity_id, dataKey } = options.customFieldConfig;
    
    if (entity_id && ctx.companyId) {
      const customRules = await CustomField.findAll({
        where: { entity_id, company_id: ctx.companyId, status: 0 },
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