const { PaymentTermsMaster } = require("../../models");
const { validateRequest, commonQuery,handleError } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.PAYMENT_TERMS.NAME;

// Create Payment Terms
exports.create = async (req, res) => {
  try {
    const requiredFields = {
      terms_title: "Terms Title",
      payment_day: "Payment Day",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: PaymentTermsMaster,
        fields: ["terms_title"]
      }
    });

    if (errors) {
      return res.error("VALIDATION_ERROR", { errors });
    }
    const result = await commonQuery.createRecord(PaymentTermsMaster, req.body);
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get all active Payment Terms
exports.getAll = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(PaymentTermsMaster, { status: 0 });
    return res.success("FETCH", ENTITY, result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Get Payment Terms by ID
exports.getById = async (req, res) => {
  try {
    const record = await commonQuery.findOneRecord(PaymentTermsMaster, req.params.id);
    if (!record || record.status === 2) return res.error("NOT_FOUND");
    return res.success("FETCH", ENTITY, record);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Update Payment Terms
exports.update = async (req, res) => {
  try {
    const requiredFields = {
      terms_title: "Terms Title",
      payment_day: "Payment Day",
      user_id: "User",
      branch_id: "Branch",
      company_id: "Company"
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: PaymentTermsMaster,
        fields: ["terms_title"],
        excludeId: req.params.id
      }
    });

    if (errors) {
      return res.error("VALIDATION_ERROR", { errors });
    }
    const updated = await commonQuery.updateRecordById(PaymentTermsMaster, req.params.id, req.body);
    if (!updated || updated.status === 2) return res.error("NOT_FOUND");
    return res.success("UPDATE", ENTITY, updated);
  } catch (err) {
    return handleError(err, res, req);
  }
};

// Delete (Soft Delete) Payment Terms
exports.delete = async (req, res) => {
  try {
    const deleted = await commonQuery.softDeleteById(PaymentTermsMaster, req.params.id);
    if (!deleted) return res.error("ALREADY_DELETED");
    return res.success("DELETE", ENTITY);
  } catch (err) {
    return handleError(err, res, req);
  }
};
