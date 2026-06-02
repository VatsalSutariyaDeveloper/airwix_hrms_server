const { validateRequest, adminCommonQuery, handleError, sequelize } = require("../../../helpers");
const { constants } = require("../../../helpers/constants");
const { StateMaster, StatutoryLWFRule } = require("../../../models");

// Create a new Currency 
exports.create = async (req, res) => {
    try {
        const transaction = await sequelize.transaction();
        const requiredFields = {
            state_id: "State Id",
            employee_contribution: "Employee Contribution",
            employer_contribution: "Employer Contribution",
            deduction_months: "Deduction Months",
        };

       const errors = await validateRequest(
            req.body,
            requiredFields,
            {},
            transaction,
        );


        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        await adminCommonQuery.createRecord(StatutoryLWFRule, req.body, transaction);
        await transaction.commit();
        return res.success(constants.STATUTORY_LWF_RULE_MASTER_CREATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all status shift records
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["employee_contribution", true, true],
            ["employer_contribution", true, true],
            ["deduction_months", true, true],
        ];

        const data = await adminCommonQuery.fetchPaginatedData(
            StatutoryLWFRule,
            req.body,
            fieldConfig,
            {
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: [] 
                }],
                attributes: [
                    'id', 'state_id', 'state.state_name', 'employee_contribution', 'employer_contribution', 'deduction_months', 'status'
                ]
            },
            false
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get dropdown list of status device masters
exports.dropdownList = async (req, res) => {
    try {
        // const result = await adminCommonQuery.findAllRecords(StatutoryLWFRule, { status: 0 });
         const fieldConfig = [
            ["employee_contribution", true, true],
            ["employer_contribution", true, true],
            ["deduction_months", true, true],
        ];

        const result = await adminCommonQuery.fetchPaginatedData(
            StatutoryLWFRule,
            req.body,
            fieldConfig,
            {
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: [] 
                }],
                attributes: [
                    'id', 'state_id', 'state.state_name', 'employee_contribution', 'employer_contribution', 'deduction_months', 'status'
                ]
            },
            false
        );

        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await adminCommonQuery.findOneRecord(
            StatutoryLWFRule, 
            req.params.id,
            {
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: [] 
                }],
                attributes: [
                    'id', 'state_id', 'state.state_name', 'employee_contribution', 'employer_contribution', 'deduction_months', 'status'
                ]
            },
            null,
            false,
            false
        );
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update Data by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            state_id: "State Id",
            employee_contribution: "Employee Contribution",
            employer_contribution: "Employer Contribution",
            deduction_months: "Deduction Months",
        };

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {},
            transaction
        );


        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }
        const updated = await adminCommonQuery.updateRecordById(StatutoryLWFRule, req.params.id, req.body, transaction, false, false);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.STATUTORY_LWF_RULE_MASTER_UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete by IDs
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
        const { ids } = req.body; // Accept array of ids

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await adminCommonQuery.softDeleteById(StatutoryLWFRule, ids, transaction, false);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.STATUTORY_LWF_RULE_MASTER_DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Update Status 
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {

        const { status, ids } = req.body; // expecting status in request body

        const requiredFields = {
            ids: "Select Any One Data",
            status: "Select status"
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
        const updated = await adminCommonQuery.updateRecordById(
            StatutoryLWFRule,
            ids,
            { status },
            transaction,
            false,
            false
        );

        if (!updated || updated.status === 2) {
            if (!transaction.finished) await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.STATUTORY_LWF_RULE_MASTER_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getStatesWithRules = async (req, res) => {
    try {
        const rules = await adminCommonQuery.findAllRecords(
            StatutoryLWFRule,
            { status: 0 },
            {
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: [] 
                }],
                attributes: [
                    'id', 'state_id', 'state.state_name', 'employee_contribution', 'employer_contribution', 'deduction_months', 'status'
                ],
                order: [['state.state_name', 'ASC']],
                raw: true
            }, null, false
        );
        
        return res.ok(rules);
    } catch (err) {
        return handleError(err, res, req);
    }
};