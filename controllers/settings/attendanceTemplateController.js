const { sequelize, handleError, validateRequest, commonQuery } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { AttendanceTemplate, Employee } = require("../../models");
const EmployeeTemplateService = require("../../services/employeeTemplateService");

exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    const POST = req.body;

    try {
        const requiredFields = {
            name: "Name",
            mode: "Mode",
        };

        const errors = await validateRequest(POST, requiredFields, {
            uniqueCheck: {
                model: AttendanceTemplate,
                fields: ["name"],
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const attendance_template = await commonQuery.createRecord(AttendanceTemplate, POST, transaction);
        await transaction.commit();
        return res.success(constants.CREATED, attendance_template);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
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
            AttendanceTemplate,
            req.body,
            fieldConfig,
        );

        if (records.items && Array.isArray(records.items)) {
            for (const record of records.items) {
                const employeeCount = await commonQuery.countRecords(
                    Employee,
                    { attendance_setting_template: record.id, status: 0 },
                    {},
                    false
                );
                record.dataValues.employee_count = employeeCount || 0;
            }
        }

        return res.ok(records);
    } catch (err) {
        return handleError(err, res, req);
    }
};
// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(AttendanceTemplate, req.params.id);
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
        const requiredFields = {
            name: "Name",
            mode: "Mode"
        };

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: {
                    model: AttendanceTemplate,
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
        const updated = await commonQuery.updateRecordById(AttendanceTemplate, req.params.id, req.body, transaction);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // Trigger sync for all employees using this template
        const employeesToSync = await commonQuery.findAllRecords(Employee, { attendance_setting_template: req.params.id, status: 0 }, { attributes: ['id'] }, transaction);
        if (employeesToSync.length > 0) {
            const employeeIds = employeesToSync.map(emp => emp.id);
            await EmployeeTemplateService.bulkSyncSpecificTemplate(employeeIds, 'attendance_setting_template', req.params.id, transaction);
        }

        await transaction.commit();
        return res.success(constants.UPDATED, updated);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    //multiple delete
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

        const deleted = await commonQuery.softDeleteById(AttendanceTemplate, ids, transaction);
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

        // Update only the status field by id
        const updated = await commonQuery.updateRecordById(
            AttendanceTemplate,
            ids,
            { status },
            transaction
        );

        if (!updated) {
            if (!transaction.finished) await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};


exports.dropdownList = async (req, res) => {
    try {
        const result = await commonQuery.findAllRecords(AttendanceTemplate, { status: 0 },{ attributes:["id", "name", "mode"] });
        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};