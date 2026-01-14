const { Taxes, sequelize, TaxTypeMaster } = require("../../../models");
const { validateRequest, handleError, commonQuery } = require("../../../helpers");
const { fixDecimals, constants } = require("../../../helpers/functions/commonFunctions");

// Create Tax
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      tax_name: "Tax Name",
      tax_value: "Tax Value",
      tax_value_type: "Tax Value Type",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: Taxes,
        fields: ["tax_name"],
      },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const {fixNum} = await fixDecimals(req.body.company_id);
    // Format tax_value to 2 decimal places
    const taxData = {
      ...req.body,
      tax_value: fixNum(req.body.tax_value)
    };
    
    const result = await commonQuery.createRecord(Taxes, taxData, transaction);
    await transaction.commit();

    return res.success(constants.TAXES_CREATED, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get List (active only)
exports.dropdownList = async (req, res) => {
  try {
    const { fixNum } = await fixDecimals(req.body.company_id);

    let records = await commonQuery.findAllRecords(
      Taxes,
      { 
        user_id: req.body.user_id,       
        branch_id: req.body.branch_id,
        company_id: req.body.company_id,
        status: 0
      },
      { attributes: ["id", "tax_name", "tax_value", "tax_value_type"],
        include: 
        [
          {
            model: TaxTypeMaster,
            as: "taxType",
            attributes: ['tax_type'],
            required: false,
          },
        ],
       },
      null,
      false
    );
    
    const formattedRecords = await Promise.all(
      records.map(async (record) => {
        const plainRecord = record.get({ plain: true });
        return {
          ...plainRecord,
          tax_value: fixNum(plainRecord.tax_value),
        };
      })
    );

    return res.ok(formattedRecords);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get All (with pagination + filters)
exports.getAll = async (req, res) => {
  try {
    
    const fieldConfig = [
      ["tax_name", true, true],
      ["tax_value", true, true],
      ["tax_value_type", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      Taxes,
      req.body,
      fieldConfig,
      {
        include : [
           {
            model: TaxTypeMaster,
            as:"taxType",
            attributes: [], 
          },
        ],
        attributes: [
          "id",
          "tax_name",
          "tax_type_id",
          [sequelize.literal(`ROUND(\`tax_value\`, 2)`), 'tax_value'],
          "tax_value_type",
          "status",
          [sequelize.col("taxType.tax_type_name"), "tax_type_name"],
        ],
        
        raw: true,
        distinct: true,
      },
      false
    );
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get By ID (with child transactions)
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(Taxes, req.params.id, {
      include: [{
        model: TaxTypeMaster,
        as: 'taxType',
        attributes: ['tax_type_name'] // Only fetch the tax_type_name
      }]
    });

    if (!record || record.status === 2) return res.error("NOT_FOUND");
    
    const formattedRecord = record.get({ plain: true });

    const { fixNum } = await fixDecimals(formattedRecord.company_id);

    formattedRecord.tax_value = fixNum(formattedRecord.tax_value);
    formattedRecord.tax_type_name = formattedRecord.taxType ? formattedRecord.taxType.tax_type_name : null;
    delete formattedRecord.taxType

    return res.ok(formattedRecord);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { fixNum } = await fixDecimals(req.body.company_id);

    const requiredFields = {
      tax_name: "Tax Name",
      tax_value: "Tax Value",
      tax_value_type: "Tax Value Type",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: Taxes,
        fields: ["tax_name"],
        excludeId: req.params.id,
      },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    // Format tax_value to 2 decimal places before updating
    const updateData = {
      ...req.body,
      tax_value: fixNum(req.body.tax_value)
    };

    const updated = await commonQuery.updateRecordById(Taxes, req.params.id, updateData, transaction);

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.TAXES_NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.TAXES_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Soft Delete
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const errors = await validateRequest(req.body, { ids: "Select Data" }, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.error(constants.INVALID_ID);
    }

    const deleted = await commonQuery.softDeleteById(Taxes, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.TAXES_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Update Status
exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body;

    const updated = await commonQuery.updateRecordById(Taxes, ids, { status }, transaction);

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.TAXES_NOT_FOUND);
    }

    await transaction.commit();
    return res.ok(updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
