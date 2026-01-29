const { sequelize, SalaryTemplate, SalaryTemplateTransaction, SalaryComponent } = require("../../../models");
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

const LWP_CALCULATION_BASIS = {
  DAYS_IN_MONTH: "DAYS_IN_MONTH",
  FIXED_30_DAYS: "FIXED_30_DAYS",
  WORKING_DAYS: "WORKING_DAYS"
}

const salaryTemplateRequiredFields = {
  template_name: "Template Name",
  staff_type: "Staff Type",
};

const validateSalaryTemplateEnums = (data) => {
  const errors = {};
  
  if (data.staff_type && !Object.values(STAFF_TYPE).includes(data.staff_type)) {
    errors.staff_type = `Must be one of: ${Object.values(STAFF_TYPE).join(', ')}`;
  }

  if (data.salary_type && !Object.values(SALARY_TYPE).includes(data.salary_type)) {
    errors.salary_type = `Must be one of: ${Object.values(SALARY_TYPE).join(', ')}`;
  }

  if (data.lwp_calculation_basis && !Object.values(LWP_CALCULATION_BASIS).includes(data.lwp_calculation_basis)) {
    errors.lwp_calculation_basis = `Must be one of: ${Object.values(LWP_CALCULATION_BASIS).join(', ')}`;
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

    // 2. Recalculate CTC from components if provided
    let calcMonthlyCTC = 0;
    if (POST.components && Array.isArray(POST.components)) {
      calcMonthlyCTC = POST.components.reduce((sum, comp) => {
        // In major platforms, CTC = Gross + Employer Contributions (like PF, ESI)
        // If included_in_ctc is true, we add it to the template level CTC field
        if (comp.included_in_ctc !== false) {
           return sum + parseFloat(comp.monthly_amount || 0);
        }
        return sum;
      }, 0);
    } else {
        calcMonthlyCTC = parseFloat(POST.ctc_monthly || 0);
    }

    const templateData = {
      ...POST,
      ctc_monthly: calcMonthlyCTC,
      ctc_yearly: calcMonthlyCTC * 12
    };

    // 2. Create Main Template
    const template = await commonQuery.createRecord(SalaryTemplate, templateData, transaction);

    // 3. Handle Template Transactions (Components)
    if (POST.components && Array.isArray(POST.components)) {
      const componentData = POST.components.map(comp => ({
        ...comp,
        salary_template_id: template.id,
        yearly_amount: (parseFloat(comp.monthly_amount) || 0) * 12
      }));
      
      // Bulk create uses commonQuery to ensure tenant IDs are injected
      await commonQuery.bulkCreate(SalaryTemplateTransaction, componentData, {}, transaction);
    }

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
      ["ctc_monthly", true, false],
      ["lwp_calculation_basis", true, false],
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
    const data = await commonQuery.findAllRecords(
      SalaryTemplate,
      { status: 0 },
      { attributes: ["id", "template_name"] },
    );
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(SalaryTemplate, req.params.id, {
      include: [
        {
          model: SalaryTemplateTransaction,
          include: [
            {
              model: SalaryComponent,
              attributes: ["id", "component_name", "component_type", "component_category", "calculation_type", "is_taxable", "is_statutory", "is_lwp_impacted"]
            }
          ]
        }
      ]
    });
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

    // 2. Recalculate CTC from components if provided
    let calcMonthlyCTC = 0;
    if (POST.components && Array.isArray(POST.components)) {
      calcMonthlyCTC = POST.components.reduce((sum, comp) => {
        if (comp.included_in_ctc !== false) {
           return sum + parseFloat(comp.monthly_amount || 0);
        }
        return sum;
      }, 0);
    } else {
        calcMonthlyCTC = parseFloat(POST.ctc_monthly || salaryTemplate.ctc_monthly || 0);
    }

    const templateData = {
      ...POST,
      ctc_monthly: calcMonthlyCTC,
      ctc_yearly: calcMonthlyCTC * 12
    };

    await commonQuery.updateRecordById(SalaryTemplate, id, templateData, transaction);

    // 2. Update Transactions (Syncing Logic)
    if (POST.components && Array.isArray(POST.components)) {
      // Delete old transactions first (Soft Delete or Hard delete since we are replacing)
      // Here we use status: 2 for soft delete
      await SalaryTemplateTransaction.destroy({
        where: { salary_template_id: id },
        transaction
      });

      // Insert new transactions
      const componentData = POST.components.map(comp => ({
        ...comp,
        salary_template_id: id,
        yearly_amount: (parseFloat(comp.monthly_amount) || 0) * 12,
        status: 0 // Ensure new ones are active
      }));
      
      await commonQuery.bulkCreate(SalaryTemplateTransaction, componentData, {}, transaction);
    }

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