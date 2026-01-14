const { CompanyBank } = require("../../models");
const { sequelize, validateRequest, commonQuery,handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");

// Create a new bank master record
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      bank_id: "Bank",
      branch_name: "Branch Name",
      account_number: "A/C Number",
      ifsc_code: "IFSC Code",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: CompanyBank,
        fields: ["account_number"]
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors); 
    }

    await commonQuery.createRecord(CompanyBank, req.body, transaction);
    await transaction.commit();
    return res.success(constants.BANK_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get all active bank master records
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(CompanyBank, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get bank master record by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(CompanyBank, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update bank master record by ID
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      bank_name: "Bank Name",
      branch_name: "Branch Name",
      account_number: "A/C Number",
      ifsc_code: "IFSC Code",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: CompanyBank,
        fields: ["account_number"],
        excludeId: req.params.id,
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors); 
    }

    const updated = await commonQuery.updateRecordById(CompanyBank, {id: req.params.id}, req.body, transaction);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.BANK_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft delete a bank master record by ID
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(CompanyBank, req.params.id, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.BANK_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};


