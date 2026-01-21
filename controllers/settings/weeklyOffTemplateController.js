const { WeeklyOffTemplate, WeeklyOffTemplateDay } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");

exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            name: "Template Name",
            days: "Weekly Off Days"
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: {
                model: WeeklyOffTemplate,
                fields: ["name"],
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const { days, ...templateData } = req.body;

        // 1️⃣ Create Template
        const template = await commonQuery.createRecord(WeeklyOffTemplate, templateData, transaction);

        // 2️⃣ Prepare Days
        const dayRecords = days.map(d => ({
            template_id: template.id,
            day_of_week: d.day_of_week,
            week_no: d.week_no,
            is_off: d.is_off ?? false
        }));

        // 3️⃣ Bulk Insert Days
        await commonQuery.bulkCreate(WeeklyOffTemplateDay, dayRecords, {}, transaction);

        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_CREATED, template );
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all active shift records
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["name", true, true],
        ];
            
        const records = await commonQuery.fetchPaginatedData(
            WeeklyOffTemplate,
            req.body,
            fieldConfig,
            { attributes: ["id", "name"] }
        );
        return res.ok(records);
    } catch (err) {
        return handleError(err, res, req);
    }
};
// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(WeeklyOffTemplate, req.params.id, {
            include: [{ model: WeeklyOffTemplateDay, as: "days" }]
        });

        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update shift record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { days, ...templateData } = req.body;

        const requiredFields = {
            name: "Template Name",
            days: "Weekly Off Days"
        };

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: {
                    model: WeeklyOffTemplate,
                    fields: ["name"],
                    excludeId: req.params.id,
                }
            },
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const updated = await commonQuery.updateRecordById(WeeklyOffTemplate, req.params.id, templateData, transaction);

        // Replace days
        if (Array.isArray(days)) {
            await WeeklyOffTemplateDay.destroy({
                where: { template_id: template.id },
                transaction
            });

            const newDays = days.map(d => ({
                template_id: template.id,
                day_of_week: d.day_of_week,
                week_no: d.week_no,
                is_off: d.is_off ?? true
            }));

            await WeeklyOffTemplateDay.bulkCreate(newDays, { transaction });
        }
        // const updated = await commonQuery.updateRecordById(WeeklyOffTemplate, { id: req.params.id }, req.body, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_UPDATED, updated);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete a shift record by ID
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

        let { ids } = req.body;

        const deleted = await commonQuery.softDeleteById(WeeklyOffTemplate, ids, transaction);
        const deletedDays = await commonQuery.softDeleteById(WeeklyOffTemplateDay, { template_id: { [Op.in]: ids } }, transaction);
        if (!deleted || !deletedDays) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_DELETED);
    } catch (err) {
        await transaction.rollback();
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
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        // Validate that status is provided and valid (0,1,2 as per your definition)
        if (![0, 1, 2].includes(status)) {
            await transaction.rollback();
            return res.error(constants.INVALID_STATUS);
        }

        // Update only the status field by id
        const updated = await commonQuery.updateRecordById(
            WeeklyOffTemplate,
            ids,
            { status },
            transaction
        );

        const updatedDays = await commonQuery.updateRecordById(
            WeeklyOffTemplateDay,
            { template_id: { [Op.in]: ids } },
            { status },
            transaction
        );

        if (!updated || !updatedDays) {
            if (!transaction.finished) await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};


exports.dropdownList = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(WeeklyOffTemplate, { status: 0 });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};