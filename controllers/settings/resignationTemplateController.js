const { ResignationTemplate } = require("../../models");

const {
    validateRequest,
    commonQuery,
    handleError,
    constants,
    sequelize,
    Op
} = require("../../helpers");

/**
 * Controller for Managing Resignation Templates
 */

// =========================================================================
// RESIGNATION TEMPLATES (CRUD)
// =========================================================================

exports.create = async (req, res) => {
    try {
        const requiredFields = {
            template_name: "Template Name",
            approval_levels: "Approval Levels"
        };
        const errors = await validateRequest(req.body, requiredFields);
        if (errors) return res.error(constants.VALIDATION_ERROR, errors);

        if (req.body.approval_levels > 0 && (!req.body.approval_config || !req.body.approval_config.length)) {
            return res.error(constants.VALIDATION_ERROR, { message: "Approval configuration is required for multi-level approval." });
        }

        const record = await commonQuery.createRecord(ResignationTemplate, req.body);
        return res.success(constants.CREATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["template_name", true, true],
            ["notice_period_days", true, false],
        ];
        const data = await commonQuery.fetchPaginatedData(
            ResignationTemplate,
            { ...req.body, status: 0 },
            fieldConfig
        );
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(ResignationTemplate, req.params.id);
        if (!record) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.update = async (req, res) => {
    try {
        if (req.body.approval_levels > 0 && (!req.body.approval_config || !req.body.approval_config.length)) {
            return res.error(constants.VALIDATION_ERROR, { message: "Approval configuration is required for multi-level approval." });
        }
        const record = await commonQuery.updateRecordById(ResignationTemplate, req.params.id, req.body);
        return res.success(constants.UPDATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            ids: "Select Data"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        let { ids } = req.body; // Accept array of ids

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.softDeleteById(ResignationTemplate, { id: { [Op.in]: ids } }, transaction);

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

exports.dropdownList = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const data = await commonQuery.findAllRecords(ResignationTemplate, {
            status: 0,
            company_id: companyId
        }, {
            attributes: ['id', 'template_name']
        });
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};
