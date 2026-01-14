const { ModuleEntityMaster, PrintTemplates } = require("../../models");
const { validateRequest, commonQuery, handleError, sequelize } = require("../../helpers");
const { constants } = require("../../helpers/constants");

// Create Print Master
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      module_entity_id: "Module Entity",
      template_name: "Template Name",
      template_component: "Template Component",
      priority: "Priority"
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    await commonQuery.createRecord(PrintTemplates, req.body, transaction);
    await transaction.commit();
    return res.success(constants.PRINT_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Get All
exports.getAll = async (req, res) => {
  try {
    const where = { status: 0, company_id: req.body.company_id };
    if(req.body.entity_id){ where.module_entity_id= req.body.entity_id }
    const result = await commonQuery.findAllRecords(PrintTemplates, where, {
      include: [{ model: ModuleEntityMaster, as: "moduleEntity", attributes: [] }],
      attributes: ["template_component", "template_name", "priority", "status", "moduleEntity.entity_name"]
    }, null, false);
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(PrintTemplates, req.params.id, {}, null, false);
    if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      module_entity_id: "Module Entity",
      template_name: "Template Name",
      template_component: "Template Component",
      priority: "Priority"
    };

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);
    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }
    const updated = await commonQuery.updateRecordById(PrintTemplates, req.params.id, req.body, transaction);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.PRINT_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

// Delete
exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(PrintTemplates, req.params.id, { status: 2 }, transaction);
    if (!deleted) return res.error(constants.ALREADY_DELETED);
    await transaction.commit();
    return res.success(constants.PRINT_MASTER_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
