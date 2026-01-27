const { sequelize, handleError, validateRequest, commonQuery } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Department } = require("../../models");



exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;

  try {
    const requiredFields = {
      name: "Name",
    };

    const errors = await validateRequest(POST, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    await commonQuery.createRecord(Department, POST, transaction);
    await transaction.commit();
    return res.success(constants.DEPARTMENT_CREATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  const POST = req.body;
  const { id } = req.params;

  try {
    const requiredFields = {
      name: "Name",
    };

    const errors = await validateRequest(POST, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const existingDepartment = await commonQuery.findOneRecord(Department, { id });
    if (!existingDepartment) {
      await transaction.rollback();
      return res.error(constants.DEPARTMENT_NOT_FOUND);
    }

    await commonQuery.updateRecordById(Department, id, POST, transaction);
    await transaction.commit();
    return res.success(constants.DEPARTMENT_UPDATED);
  } catch (err) {
    if (!transaction.finished) await transaction.rollback();
    return handleError(err, res, req);
  }
};


exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["name", true, true],
    ];

    const data = await commonQuery.fetchPaginatedData(
      Department,
      req.body,
      fieldConfig,
      {},
    );

    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(Department, req.params.id);
    if (!record || record.status === 2) return res.error(constants.DEPARTMENT_NOT_FOUND);

    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.dropdownList = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(Department, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.SELECT_AT_LEAST_ONE_RECORD);
    }

    const deleted = await commonQuery.softDeleteById(Department, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.DEPARTMENT_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { status, ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.SELECT_AT_LEAST_ONE_RECORD);
    }

    const updated = await commonQuery.updateRecordById(
      Department,
      ids,
      { status },
      transaction
    );

    if (!updated) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND);
    }

    await transaction.commit();
    return res.success(constants.DEPARTMENT_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};