const { TaxTypeMaster } = require("../../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../../helpers");
const { ENTITIES } = require("../../../helpers/constants");

const ENTITY = ENTITIES.TAX_TYPE.NAME;

// 🔹 Create TaxTypeMaster
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      country_id: "Country",
      tax_type: "Tax Type",
      tax_type_name: "Tax Type Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: TaxTypeMaster,
        fields: ["tax_type_name"],
      },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    const result = await commonQuery.createRecord(TaxTypeMaster, req.body, transaction);
    await transaction.commit();
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 🔹 Get List (active only, minimal fields)
exports.dropdownList = async (req, res) => {
  try {
    const where = { status: 0 };
    if (req.body.company_id) where.company_id = req.body.company_id;
    if (req.body.branch_id) where.branch_id = req.body.branch_id;
    if (req.body.user_id) where.user_id = req.body.user_id;

    const record = await commonQuery.findAllRecords(
      TaxTypeMaster,
      where,
      { attributes: ["id", "tax_type", "tax_type_name"] },
      {},
      null,
      false
    );
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// 🔹 Get All (with pagination, filtering, search)
exports.getAll = async (req, res) => {
  try {

    const fieldConfig = [
      ["tax_type", true, true],
      ["tax_type_name", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      TaxTypeMaster,
      req.body,
      fieldConfig,
      {
        attributes: [
          "id",
          "country_id",
          "tax_type",
          "tax_type_name",
          "description",
          "use_for",
          "status"
        ],
        distinct: true,
      },
      false
    );
    
    return res.success("FETCH", ENTITY, data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// 🔹 Get by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(TaxTypeMaster, req.params.id);
    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// 🔹 Update TaxTypeMaster
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      country_id: "Country",
      tax_type: "Tax Type",
      tax_type_name: "Tax Type Name",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: TaxTypeMaster,
        fields: ["tax_type_name",],
        excludeId: req.params.id,
      },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    const updated = await commonQuery.updateRecordById(TaxTypeMaster, req.params.id, req.body, transaction);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error("NOT_FOUND");
    }
    await transaction.commit();
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 🔹 Soft Delete (status = 1)
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      ids: "Select Data",
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error("INVALID_idS_ARRAY");
    }

    const deleted = await commonQuery.softDeleteById(TaxTypeMaster, ids, transaction);
    if (!deleted){
      await transaction.rollback();
      return res.error("ALREADY_DELETED");
    }

    await transaction.commit();
    return res.success("DELETE", ENTITY);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// 🔹 Update Status
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

    if (![0, 1].includes(status)) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors: ["Invalid status value"] });
    }

    const updated = await commonQuery.updateRecordById(
      TaxTypeMaster,
      ids,
      { status },
      transaction
    );

    if (!updated) {
      if (!transaction.finished) await transaction.rollback();
      return res.error("NOT_FOUND");
    }

    await transaction.commit();
    return res.success("UPDATE", ENTITY + " Status", updated);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};
