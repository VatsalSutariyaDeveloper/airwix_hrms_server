const { sequelize, SalaryComponent } = require("../../../models");
const { validateRequest, commonQuery, handleError } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");

const COMPONENT_TYPE = {
  EARNING: "EARNING",
  DEDUCTION: "DEDUCTION"
};

const COMPONENT_CATEGORY = {
  FIXED: "FIXED",
  VARIABLE: "VARIABLE",
  STATUTORY: "STATUTORY"
};

const salaryComponentRequiredFields = {
  component_name: "Component Name",
  component_type: "Component Type",
};

/**
 * Validates Enums for Salary Component
 */
const validateSalaryComponentEnums = (data) => {
  const errors = {};
  
  if (data.component_type && !Object.values(COMPONENT_TYPE).includes(data.component_type)) {
    errors.component_type = `Must be one of: ${Object.values(COMPONENT_TYPE).join(', ')}`;
  }

  if (data.component_category && !Object.values(COMPONENT_CATEGORY).includes(data.component_category)) {
    errors.component_category = `Must be one of: ${Object.values(COMPONENT_CATEGORY).join(', ')}`;
  }

  return Object.keys(errors).length > 0 ? errors : null;
};

// 1. Create Salary Component
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const enumError = validateSalaryComponentEnums(POST);
    if (enumError) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, enumError);
    }

    const errors = await validateRequest(POST, salaryComponentRequiredFields, {
      uniqueCheck: {
        model: SalaryComponent,
        fields: ["component_name"],
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    await commonQuery.createRecord(SalaryComponent, POST, transaction);

    await transaction.commit();
    return res.success(constants.SALARY_COMPONENT_CREATED || "Salary component created successfully");
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 2. Get All (Paginated)
exports.getAll = async (req, res) => {
  try {
    const POST = req.body;
    const fieldConfig = [
      ["component_name", true, true],
      ["component_type", true, false],
      ["component_category", true, false],
      ["status", true, false],
    ];

    const data = await commonQuery.fetchPaginatedData(
      SalaryComponent,
      { ...POST },
      fieldConfig,
      null,
      false
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// 3. Dropdown List
exports.dropdownList = async (req, res) => {
  try {
    const POST = req.body;
    const fieldConfig = [
      ["component_name", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      SalaryComponent,
      { ...POST, status: 0 },
      fieldConfig,
      { attributes: ["id", "component_name", "component_type", "component_category"] },
      false,
    );
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// 4. Get By ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(SalaryComponent, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// 5. Update Salary Component
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const { id } = req.params;

    const errors = await validateRequest(POST, salaryComponentRequiredFields, {
      uniqueCheck: {
        model: SalaryComponent,
        fields: ["component_name"],
        excludeId: id
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const enumError = validateSalaryComponentEnums(POST);
    if (enumError) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, enumError);
    }

    const updated = await commonQuery.updateRecordById(SalaryComponent, id, POST, transaction);

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.SALARY_COMPONENT_UPDATED || "Salary component updated successfully");
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 6. Soft Delete (Bulk)
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { ids } = req.body;
    const deleted = await commonQuery.softDeleteById(SalaryComponent, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.SALARY_COMPONENT_DELETED || "Salary component deleted successfully");
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 7. Update Status (Active/Inactive)
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_ID);
    }

    const count = await commonQuery.updateRecordById(SalaryComponent, ids, { status }, transaction);

    if (count === null) {
      await transaction.rollback();
      return res.error(constants.NO_RECORDS_FOUND);
    }

    await transaction.commit();
    return res.success(constants.STATUS_UPDATED || "Status updated successfully");
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};