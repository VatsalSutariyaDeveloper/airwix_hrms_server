const { TemplatesMessage } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");

const ENTITY = ENTITIES.TEMPLATE_MESSAGE.NAME;

const ensureSingleDefault = async (POST, transaction) => {
  console.log(POST);
  if (POST.is_default === 1) {
    await commonQuery.updateRecordById(
      TemplatesMessage,
      { template_message_type: POST.template_message_type },
      { is_default: 2 },
      transaction
    );
  }
};

exports.create = async (req, res) => {
    const POST = req.body;
    const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      name: "Name",
      template_message_type: "Template Message Type",
      content: "Content",
    };

    const errors = await validateRequest(POST, requiredFields, {
      uniqueCheck: {
        model: TemplatesMessage,
        fields: ["name"],
      },
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error("VALIDATION_ERROR", { errors });
    }

    await ensureSingleDefault(POST, transaction);
    const result = await commonQuery.createRecord(TemplatesMessage, POST, transaction);
    await transaction.commit();
    return res.success("CREATE", ENTITY, result);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.dropdownList = async (req, res) => {
    const POST = req.body;
    try {
        const where = { status: 0 };
        if (POST.company_id) where.company_id = POST.company_id;
        if (POST.branch_id) where.branch_id = POST.branch_id;
        if (POST.user_id) where.user_id = POST.user_id;
        if (POST.template_message_type) where.template_message_type = POST.template_message_type;

        const record = await commonQuery.findAllRecords(
            TemplatesMessage,
            where,
            { attributes: ["id", "name", "template_message_type", "content","is_default"] }
        );
        return res.success("FETCH", ENTITY, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAll = async (req, res) => {
    const POST = req.body;
    try {
        const fieldConfig = [
            ["name", true, true],
            ["template_message_type", true, true],
            ["content", true, true],
            ["is_default", true, true],
        ];
        const data = await commonQuery.fetchPaginatedData(
            TemplatesMessage,
            POST,
            fieldConfig,
           {
            attributes: [
                "id",
                "name",
                "template_message_type",
                "content",
                "is_default",
                'status'
            ],
            distinct: true,
           }
        );
        return res.success("FETCH", ENTITY, data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(TemplatesMessage, req.params.id);
        if (!record || record.status === 2) return res.error("NOT_FOUND");
        return res.success("FETCH", ENTITY, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.update = async (req, res) => {
    const POST = req.body;
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            name: "Name",
            template_message_type: "Template Message Type",
            content: "Content",
        };

        const errors = await validateRequest(POST, requiredFields, {
            uniqueCheck: {
                model: TemplatesMessage,
                fields: ["name"],
                excludeId: req.params.id,
            },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { errors });
        }
        await ensureSingleDefault(POST, transaction);
        const updated = await commonQuery.updateRecordById(TemplatesMessage, req.params.id, POST, transaction);
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

exports.delete = async (req, res) => {
    const POST = req.body;
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            ids: "Select Data",
        };

        const errors = await validateRequest(POST, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { errors });
        }

        const { ids } = POST;
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error("INVALID_idS_ARRAY");
        }

        const deleted = await commonQuery.softDeleteById(TemplatesMessage, ids, transaction);
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

exports.updateStatus = async (req, res) => {
    const POST = req.body;
    const transaction = await sequelize.transaction();
  try {
    const { status, ids } = POST;

    const requiredFields = {
      ids: "Select Any One Data",
      status: "Select Status",
    };

    const errors = await validateRequest(POST, requiredFields, {}, transaction);
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
      TemplatesMessage,
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