const { LoginHistory } = require("../../models");
const { validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");

/**
 * Create Login History
 */
exports.create = async (req, res) => {
  try {
     const requiredFields = {
      user_id: "User",
      in_time: "In Time",
      ip_address: "IP Address",
      browser: "Browser",
      os: "OS",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    await commonQuery.createRecord(LoginHistory, req.body);
    return res.success(constants.LOGIN_HISTORY_CREATED);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get All Login Histories
 */
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(LoginHistory, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get Login History by ID
 */
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(LoginHistory, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Update Login History
 */
exports.update = async (req, res) => {
  try {
    const requiredFields = {
      user_id: "User",
      in_time: "In Time",
      ip_address: "IP Address",
      browser: "Browser",
      os: "OS",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const updated = await commonQuery.updateRecordById(LoginHistory, req.params.id, req.body);
    if (!updated || updated.status === 2) return res.error(constants.NOT_FOUND);
    return res.success(constants.LOGIN_HISTORY_UPDATED);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Soft Delete Login History
 */
exports.delete = async (req, res) => {
  try {
    const deleted = await commonQuery.softDeleteById(LoginHistory, req.params.id);
    if (!deleted) return res.error(constants.ALREADY_DELETED);
    return res.success(constants.LOGIN_HISTORY_DELETED);
  } catch (err) {
    return handleError(err, res, req);
  }
};
