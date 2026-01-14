const { ZoneMaster } = require("../../../models");
const { validateRequest, commonQuery,handleError, sequelize } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");

exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const errors = await validateRequest(req.body, {
      zone_name: "Zone Name",
      user_id: "User",
      company_id: "Company"
    }, {
      uniqueCheck: {
        model: ZoneMaster,
        fields: ["zone_name"]
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    
    await commonQuery.createRecord(ZoneMaster, req.body, transaction);
    await transaction.commit();
    return res.success(constants.ZONE_MASTER_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(ZoneMaster, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(ZoneMaster, req.params.id);
    if (!record || record.status === 2) return res.error(constants.ZONE_MASTER_NOT_FOUND);
    return res.ok(record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const errors = await validateRequest(req.body, {
      zone_name: "Zone Name",
      user_id: "User",
      company_id: "Company"
    }, {
      uniqueCheck: {
        model: ZoneMaster,
        fields: ["zone_name"],
        excludeId: req.params.id
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors );
    }
    const updated = await commonQuery.updateRecordById(ZoneMaster, req.params.id, req.body, transaction);
    if (!updated || updated.status === 2) {
      await transaction.rollback();
      return res.error(constants.ZONE_MASTER_NOT_FOUND);
    }
    await transaction.commit();
    return res.success(constants.ZONE_MASTER_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const deleted = await commonQuery.softDeleteById(ZoneMaster, req.params.id, transaction);
    if (!deleted) return res.error(constants.ZONE_MASTER_NOT_FOUND);
    await transaction.commit();
    return res.success(constants.ZONE_MASTER_DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};
