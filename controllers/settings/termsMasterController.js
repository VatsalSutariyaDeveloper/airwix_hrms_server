const { TermsMaster, ModuleEntityMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, constants } = require("../../helpers");

const ensureSingleDefault = async (POST, transaction) => {
  if (POST.is_default === 1) {
    await commonQuery.updateRecordById(
      TermsMaster,
      { terms_entity_id: POST.terms_entity_id, terms_type: POST.terms_type },
      { is_default: 2 },
      transaction
    );
  }
};

// CREATE
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const POST = req.body;

    const requiredFields = {
      terms_entity_id: "Terms Entity",
      template_name: "Template Name",
      terms_type: "Terms Type",
    };

    const errors = await validateRequest(POST, requiredFields, {
      uniqueCheck: {
        model: TermsMaster,
        fields: ["template_name"],
        where: { terms_entity_id: POST.terms_entity_id, terms_type: POST.terms_type },
      },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const existingDefault = await commonQuery.findOneRecord(
      TermsMaster,
      { terms_entity_id: POST.terms_entity_id, terms_type: POST.terms_type, is_default: 1 },
      { transaction }
    );

    if (!existingDefault) {
      POST.is_default = 1;
    }

    await ensureSingleDefault(POST, transaction);

    const data = await commonQuery.createRecord(TermsMaster, POST, transaction);
    await transaction.commit();

    return res.success(constants.CREATED, data);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// GET ALL
exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["template_name", true, true],
      ["entity_name", true, true],
    ];

    const options = {
      include: [{
        model: ModuleEntityMaster,
        as: "entity",
        attributes: []
      }], 
      attributes: [
        "id",
        "template_name",
        "terms",
        "terms_type",
        "is_default",
        "status",
        ["entity.entity_name", "entity_name"],
      ]
    };

    const data = await commonQuery.fetchPaginatedData(
      TermsMaster,
      req.body,
      fieldConfig,
      options
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// DROPDOWN LIST
exports.dropdownList = async (req, res) => {
  try {
    const { user_id, branch_id, company_id, entity_id } = req.body;
    const records = await commonQuery.findAllRecords(
      TermsMaster,
      { user_id, branch_id, company_id, terms_entity_id: entity_id, status: 0 },
      {
        attributes: ["id", "template_name", "terms_type", "terms", "is_default"],
        order: [["template_name", "ASC"]],
      }
    );
    return res.ok(records);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// GET BY ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(TermsMaster, req.params.id);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);

    const plain = record.get({ plain: true });
    return res.ok(plain);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// UPDATE
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const POST = req.body;
    const { id } = req.params;

    const requiredFields = {
      terms_entity_id: "Terms Entity",
      template_name: "Template Name",
      terms_type: "Terms Type",
    };

    const errors = await validateRequest(
      POST,
      requiredFields,
      { uniqueCheck: { model: TermsMaster, fields: ["template_name"], where: { terms_entity_id: POST.terms_entity_id, terms_type: POST.terms_type }, excludeId: id } },
      transaction
    );

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    if (POST.is_default !== 1) {
      const existingDefault = await commonQuery.findOneRecord(
        TermsMaster,
        { terms_entity_id: POST.terms_entity_id, terms_type: POST.terms_type, is_default: 1 },
        { transaction }
      );

      if (!existingDefault) {
        POST.is_default = 1;
      }
    }

    await ensureSingleDefault(POST, transaction);
    const updated = await commonQuery.updateRecordById(TermsMaster, id, POST, transaction);
    
    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();

    return res.success(constants.UPDATED, updated);

  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// DELETE (Soft)
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
      return res.error(constants.INVALID_INPUT); // Using constant for "INVALID_IDS_ARRAY"
    }

    const firstRecord = await commonQuery.findOneRecord(TermsMaster, ids[0]);
    const type = firstRecord ? firstRecord.terms_type : 1; 

    const deleted = await commonQuery.softDeleteById(TermsMaster, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();

    return res.success(constants.DELETED);

  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// UPDATE STATUS
exports.updateStatus = async (req, res) => {
  
};

exports.updateDefault = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, constants.SELECT_AT_LEAST_ONE_RECORD);
    }

    const firstRecord = await commonQuery.findOneRecord(TermsMaster, ids[0]);
    if (!firstRecord) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await ensureSingleDefault({ terms_entity_id: firstRecord.terms_entity_id, terms_type: firstRecord.terms_type, is_default: 1 }, transaction);

    const updated = await commonQuery.updateRecordById(
      TermsMaster,
      ids,
      { is_default: 1 },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.UPDATED, updated);

  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};