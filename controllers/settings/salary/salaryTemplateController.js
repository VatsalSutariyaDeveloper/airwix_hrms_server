const { sequelize, SalaryTemplate } = require("../../../models");
const { validateRequest, commonQuery, handleError } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");

const STAFF_TYPE = {
  REGULAR: "Regular",
  TRAINEE: "Trainee",
  CONTRACT: "Contract"
}

const SALARY_TYPE = {
  MONTHLY: "Monthly",
  DAILY: "Daily",
  HOURLY: "Hourly"
}

const salaryTemplateRequiredFields = {
  template_code: "Template Code",
  template_name: "Template Name",
  staff_type: "Staff Type",
  salary_type: "Salary Type",
  ctc_monthly: "CTC Monthly",
  ctc_yearly: "CTC Yearly",
  currency: "Currency"
};

const validateSalaryTemplateEnums = (data) => {
  const errors = {};
  
  if (data.staff_type && !Object.values(STAFF_TYPE).includes(data.staff_type)) {
    errors.staff_type = `Must be one of: ${Object.values(STAFF_TYPE).join(', ')}`;
  }

  if (data.salary_type && !Object.values(SALARY_TYPE).includes(data.salary_type)) {
    errors.salary_type = `Must be one of: ${Object.values(SALARY_TYPE).join(', ')}`;
  }

  return Object.keys(errors).length > 0 ? errors : null;
};

exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const enumError = validateSalaryTemplateEnums(POST);
    if (enumError) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, enumError);
    }

    const errors = await validateRequest(POST, salaryTemplateRequiredFields, {
      uniqueCheck: {
        model: SalaryTemplate,
        fields: ["template_code"],
      }
    }, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    await commonQuery.createRecord(SalaryTemplate, POST, transaction);

    await transaction.commit();
    return res.success(constants.SALARY_TEMPLATE_CREATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  try {
    const POST = req.body;
    const fieldConfig = [
      ["template_name", true, true],
      ["template_code", true, true],
      ["staff_type", true, false],
      ["salary_type", true, false],
      ["status", true, false],
    ];

    const data = await commonQuery.fetchPaginatedData(
      SalaryTemplate,
      { ...POST, status: 0 },
      fieldConfig,
      null,
      false
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.dropdownList = async (req, res) => {
  try {
    const POST = req.body;
    const fieldConfig = [
      ["template_name", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      SalaryTemplate,
      { ...POST, status: 0 },
      fieldConfig,
      {attributes: ["id", "template_name", "template_code", "staff_type", "salary_type", "ctc_monthly", "ctc_yearly", "currency"]},
      false,
    );
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(SalaryTemplate, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const { id } = req.params;

    const errors = await validateRequest(POST, salaryTemplateRequiredFields, {
      uniqueCheck: {
        model: SalaryTemplate,
        fields: ["template_code"],
        excludeId: id
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const enumError = validateSalaryTemplateEnums(POST);
    if (enumError) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, enumError);
    }

    const salaryTemplate = await commonQuery.findOneRecord(
      SalaryTemplate,
      id,
      {},
      transaction
    );

    if (!salaryTemplate || salaryTemplate.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await commonQuery.updateRecordById(SalaryTemplate, id, POST, transaction);

    await transaction.commit();
    return res.success(constants.SALARY_TEMPLATE_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
  try {
    const transaction = await sequelize.transaction();
    const { ids } = req.body;
    const deleted = await commonQuery.softDeleteById(SalaryTemplate, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.SALARY_TEMPLATE_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { ids, status } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID, );
        }

        const count = await commonQuery.updateRecordById(SalaryTemplate, ids, { status }, transaction);

        if (count === null) {
            await transaction.rollback();
            return res.error(constants.NO_RECORDS_FOUND);
        }

        await transaction.commit();
        return res.success(constants.SALARY_TEMPLATE_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};