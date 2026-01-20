const { LeaveTemplate, LeaveTemplateCategory, sequelize } = require("../../../models");
const { validateRequest, commonQuery, handleError } = require("../../../helpers");
const { ENTITIES, constants } = require("../../../helpers/constants");
const { Op } = require("sequelize");

const ENTITY = "Leave Template";

// Create
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { categories, ...templateData } = req.body;

        const requiredFields = {
            template_name: "Template Name",
            leave_policy_cycle: "Leave Policy Cycle",
            accrual_type: "Accrual Type"
        };

        const errors = await validateRequest(templateData, requiredFields, {
            uniqueCheck: {
                model: LeaveTemplate,
                fields: ["template_name"]
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { errors });
        }

        // 1. Create Template
        const template = await commonQuery.createRecord(LeaveTemplate, templateData, transaction);

        // 2. Create Categories if provided
        if (categories && Array.isArray(categories) && categories.length > 0) {
            const categoryData = categories.map(cat => ({
                ...cat,
                leave_template_id: template.id,
                company_id: template.company_id
            }));
            await commonQuery.bulkCreate(LeaveTemplateCategory, categoryData, {}, transaction);
        }

        await transaction.commit();
        return res.success(constants.LEAVE_TEMPLATE_CREATED, template);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Update
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { categories, ...templateData } = req.body;
        const { id } = req.params;

        const requiredFields = {
            template_name: "Template Name",
            leave_policy_cycle: "Leave Policy Cycle",
            accrual_type: "Accrual Type"
        };

        const errors = await validateRequest(templateData, requiredFields, {
            uniqueCheck: {
                model: LeaveTemplate,
                fields: ["template_name"],
                excludeId: id
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { errors });
        }

        // 1. Update Template
        const updatedTemplate = await commonQuery.updateRecordById(LeaveTemplate, id, templateData, transaction);
        if (!updatedTemplate) {
            await transaction.rollback();
            return res.error("NOT_FOUND");
        }

        // 2. Sync Categories
        if (categories && Array.isArray(categories)) {
            // Get existing categories
            const existingCategories = await commonQuery.findAllRecords(LeaveTemplateCategory, { leave_template_id: id }, {}, transaction);
            const existingIds = existingCategories.map(c => c.id);
            const inputIds = categories.filter(c => c.id).map(c => c.id);

            // Delete categories not in input
            const idsToDelete = existingIds.filter(eid => !inputIds.includes(eid));
            if (idsToDelete.length > 0) {
                await commonQuery.softDeleteById(LeaveTemplateCategory, { id: { [Op.in]: idsToDelete } }, transaction);
            }

            // Update or Create
            for (const cat of categories) {
                const catData = { ...cat, leave_template_id: id, company_id: updatedTemplate.company_id };
                if (cat.id) {
                    await commonQuery.updateRecordById(LeaveTemplateCategory, cat.id, catData, transaction);
                } else {
                    await commonQuery.createRecord(LeaveTemplateCategory, catData, transaction);
                }
            }
        }

        await transaction.commit();
        return res.success(constants.LEAVE_TEMPLATE_UPDATED, updatedTemplate);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get By ID
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(LeaveTemplate, req.params.id, {
            include: [
                { model: LeaveTemplateCategory, as: "categories" }
            ]
        });

        if (!record || record.status === 2) return res.error("NOT_FOUND");
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get All (Paginated)
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["template_name", true, true],
            ["leave_policy_cycle", true, true],
            ["accrual_type", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            LeaveTemplate,
            req.body,
            fieldConfig
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Soft Delete
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.error("VALIDATION_ERROR", { message: "Select at least one record" });
        }

        // Delete templates
        await commonQuery.softDeleteById(LeaveTemplate, { id: { [Op.in]: ids } }, transaction);
        
        // Delete associated categories
        await commonQuery.softDeleteById(LeaveTemplateCategory, { leave_template_id: { [Op.in]: ids } }, transaction);

        await transaction.commit();
        return res.ok(constants.LEAVE_TEMPLATE_DELETED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
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
            status: "Select Status"
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
            return res.error("VALIDATION_ERROR", { errors: ["Invalid status value"] });
        }

        const updated = await commonQuery.updateRecordById(
            LeaveTemplate,
            ids,
            { status },
            transaction
        );

        const updatedCategories = await commonQuery.updateRecordById(
            LeaveTemplateCategory,
            { leave_template_id: { [Op.in]: ids } },
            { status },
            transaction
        );

        if (!updated || updated.status === 2 || !updatedCategories || updatedCategories.status === 2) {
            if (!transaction.finished) await transaction.rollback();
            return res.error("NOT_FOUND");
        }

        await transaction.commit();
        return res.ok(constants.LEAVE_TEMPLATE_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};
