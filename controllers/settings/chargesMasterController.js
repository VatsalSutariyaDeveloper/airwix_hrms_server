const { ChargesMaster, TaxGroup } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, constants } = require("../../helpers");

// Create Charges Master
exports.create = async (req, res) => {
  try {
    const requiredFields = {
      charge_name: "Charge Name",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: ChargesMaster,
        fields: ["charge_name"],
      },
    });

    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const result = await commonQuery.createRecord(ChargesMaster, req.body);

    return res.success(constants.CHARGES_CREATED, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get Charges Master by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(
      ChargesMaster,
      req.params.id,
      {
        include: [
          { 
            model: TaxGroup, 
            as: "intraTaxGroup", 
            attributes: ["group_value"] // Fetch the rate (e.g., 18.00)
          }
        ]
      }
    );
    
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);

    // Flatten data for frontend
    const data = record.toJSON();
    
    if (data.intraTaxGroup) {
      const rate = parseFloat(data.intraTaxGroup.group_value); 
      data.tax_rate = String(rate); 
    }

    return res.ok(data);    
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Charges Master
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
  const POST = req.body;
  try {
    const skipValidations = !POST.charge_name && (POST.is_default == 1 || POST.is_default == 2);
    if (!skipValidations) {
      const requiredFields = {
        charge_name: "Charge Name",
      };

      const errors = await validateRequest(req.body, requiredFields, {
        uniqueCheck: {
          model: ChargesMaster,
          fields: ["charge_name"],
          excludeId: req.params.id,
        },
      }, transaction);

      if (errors) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, errors);
      }
    }

    const updated = await commonQuery.updateRecordById(
      ChargesMaster,
      req.params.id,
      req.body,
      transaction
    );

    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    
    await transaction.commit();
    return res.success(constants.CHARGES_UPDATED, updated);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all active Data For listing with pagination and search
exports.getAll = async (req, res) => {
  const fieldConfig = [
    ["charge_name", true, true],
    ["value_type", true, false],
    ["value", true, false],
  ];

  const data = await commonQuery.fetchPaginatedData(
    ChargesMaster,
    req.body,
    fieldConfig,
  );

  return res.ok(data);
};

// Get list of all Data for dropdowns.
exports.dropdownList = async (req, res) => {
  try {
    const fieldConfig = [
      ["charge_name", true, true],
    ];

    const options = {
      attributes: ["id", "charge_name", "intra_tax_group_id", "inter_tax_group_id", "tax_group_id", "amount", "amount_without_tax", "is_default"],
      order: ["charge_name"]
    };
    
    const data = await commonQuery.fetchPaginatedData(
      ChargesMaster,
      req.body,
      fieldConfig,
      options
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Soft delete by IDs
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = { ids: "Select Data" };
    const errors = await validateRequest(req.body, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.INVALID_INPUT);
    }

    const deleted = await commonQuery.softDeleteById(
      ChargesMaster,
      ids,
      transaction
    );

    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.CHARGES_DELETED);
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

    const requiredFields = {
      ids: "Select Any One Data",
      status: "Select Status",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error("INVALID_idS_ARRAY");
    }

    if (![0, 1, 2].includes(status)) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", {
        errors: ["Invalid status value"],
      });
    }

    const updated = await commonQuery.updateRecordById(
      ChargesMaster,
      ids,
      { status },
      transaction
    );

    if (!updated || updated.status === 2) {
      if (!transaction.finished) await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.CHARGES_UPDATED, updated);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};
