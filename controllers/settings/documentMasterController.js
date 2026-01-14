const { DocumentMaster } = require("../../models");
const { validateRequest, commonQuery,handleError } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.DOCUMENT_MASTER.NAME;

exports.create = async (req, res) => {
  const requiredFields = {
    document_name: "Document Name",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company"
  };

  const errors = await validateRequest(req.body, requiredFields, {
    uniqueCheck: {
      model: DocumentMaster,
      fields: ["document_name"],
    },
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

  try {
    const result = await commonQuery.createRecord(DocumentMaster, req.body);
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(DocumentMaster, { status: 0 });
    return res.success("FETCH", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(DocumentMaster, req.params.id);
    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const requiredFields = {
    document_name: "Document Name",
    user_id: "User",
    branch_id: "Branch",
    company_id: "Company"
  };

  const errors = await validateRequest(req.body, requiredFields, {
    uniqueCheck: {
      model: DocumentMaster,
      fields: ["document_name"],
      excludeId: req.params.id,
    },
  }, transaction);

  if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

  try {
    const updated = await commonQuery.updateRecordById(DocumentMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) return res.error("NOT_FOUND");
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
  try {
    const deleted = await commonQuery.softDeleteById(DocumentMaster, req.params.id);
    if (!deleted) return res.error("ALREADY_DELETED");
    return res.success("DELETE", ENTITY);
  } catch (err) {
    return handleError(err, res, req);
  }
};
