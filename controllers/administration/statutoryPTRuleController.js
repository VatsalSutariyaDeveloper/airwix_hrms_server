const { validateRequest, commonQuery, handleError, sequelize, Op } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { StatutoryPTRule, StateMaster, Employee } = require("../../models");

//CREATE
exports.create = async (req, res) => {
    try {
        const transaction = await sequelize.transaction();
        const requiredFields = {
            state_id: "State Id",
            min_salary: "Minimum Salary",
            // max_salary: "Max Salary",
            monthly_amount: "Monthly Amount",
            // march_amount: "March Amount",
            gender: "Gender",
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
        req.body.company_id = -1;
        req.body.branch_id = -1;
        req.body.user_id = -1;
        await commonQuery.createRecord(StatutoryPTRule, req.body, transaction, false);
        await transaction.commit();
        return res.success(constants.CREATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all status shift records
exports.getAll = async (req, res) => {
    // console.log(req.data);
    try {

        const fieldConfig = [
            ["min_salary", true, true],
            ["max_salary", true, true],
            ["monthly_amount", true, true],
            ["march_amount", true, true],
            ["state.state_name", true, true],
            // ["gender", true, true],
        ];

        const data = await commonQuery.fetchPaginatedData(
            StatutoryPTRule,
            req.body,
            fieldConfig,
            {
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: [] 
                }],
                attributes: [
                    'id', 'state_id', 'state.state_name', 'min_salary', 'max_salary', 'monthly_amount', 'march_amount', 'gender', 'status'
                ]
            }, false
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get dropdown list of status device masters
exports.dropdownList = async (req, res) => {
    try {
        // const result = await commonQuery.findAllRecords(StatutoryPTRule, { status: 0 });
        const fieldConfig = [
            ["min_salary", true, true],
            ["max_salary", true, true],
            ["monthly_amount", true, true],
            ["gender", true, true],
        ];

        const result = await commonQuery.fetchPaginatedData(
            StatutoryPTRule,
            req.body,
            fieldConfig,
            {
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: [] 
                }],
                attributes: [
                    'id', 'state_id', 'state.state_name', 'min_salary', 'max_salary', 'monthly_amount', 'gender', 'status'
                ]
            }, false
        );

        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(
            StatutoryPTRule, 
            req.params.id,
            {
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: ['state_name', 'code'] 
                }],
                attributes: [
                    'id', 'state_id', 'state.state_name', 'min_salary', 'max_salary', 'monthly_amount', 'gender', 'march_amount', 'status'
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
            min_salary: "Minimum Salary",
            // max_salary: "Max Salary",
            monthly_amount: "Monthly Amount",
            // march_amount: "March Amount",
            gender: "Gender",
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
        req.body.company_id = -1;
        req.body.branch_id = -1;
        req.body.user_id = -1;
        const updated = await commonQuery.updateRecordById(StatutoryPTRule, req.params.id, req.body, transaction, false, false);
        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }
        await transaction.commit();
        return res.success(constants.UPDATED);
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

        const deleted = await commonQuery.softDeleteById(StatutoryPTRule, ids, transaction, false);
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
        const updated = await commonQuery.updateRecordById(
            StatutoryPTRule,
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
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getStatesWithRules = async (req, res) => {
    try {
        const rules = await commonQuery.findAllRecords(
            StatutoryPTRule,
            {},
            {
                attributes: ['state_id'],
                include: [{ 
                    model: StateMaster, 
                    as: 'state',
                    attributes: ['id', 'state_name'] 
                }],
                group: ['StatutoryPTRule.state_id', 'state.id', 'state.state_name'],
                order: [['state.state_name', 'ASC']],
            }, null, false
        );
        
        const states = rules.map(r => r.state).filter(Boolean);
        return res.ok(states);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.calculatePT = async (req, res) => {
    try {
        let { state_id, employee_id, state_name, amount, gender, month } = req.body;

        if (employee_id) {
            const employee = await commonQuery.findOneRecord(Employee, { id: employee_id }, null, false, {});
            if (employee) {
                state_id = state_id || employee.state_id || employee.present_state_id; // Using fallback if state_id is not exactly named
                gender = gender || employee.gender;
            }
        }

        if (amount === undefined || amount === null) {
            return res.error(constants.VALIDATION_ERROR, { amount: "Amount is required" });
        }

        // 1. Resolve state_id if state_name is provided
        if (!state_id && state_name) {
            const state = await commonQuery.findOneRecord(StateMaster, { state_name: { [Op.iLike]: state_name } }, null, false, {});
            if (state) state_id = state.id;
        }

        if (!state_id) {
            return res.error(constants.VALIDATION_ERROR, { state_id: "State is required or invalid" });
        }

        // 2. Default values
        gender = gender || 3; // Default to 'All'
        month = month || (new Date().getMonth() + 1);

        // 3. Find matching rules using commonQuery
        const filters = {
            state_id,
            status: 0,
            min_salary: { [Op.lte]: amount },
            gender: { [Op.in]: [gender, 3] },
            [Op.or]: [
                { max_salary: { [Op.gte]: amount } },
                { max_salary: null }
            ]
        };

        const matchingRules = await commonQuery.findAllRecords(StatutoryPTRule, filters, {}, null, false);

        if (!matchingRules || matchingRules.length === 0) {
            return res.ok({ monthly_amount: 0 });
        }

        // 4. Prioritize exact gender match (1 or 2) over 'All' (3)
        let selectedRule = matchingRules.find(r => r.gender == gender);
        if (!selectedRule) selectedRule = matchingRules.find(r => r.gender == 3);
        if (!selectedRule) selectedRule = matchingRules[0];

        // 5. Check for March amount
        let deduction = selectedRule.monthly_amount;
        if (parseInt(month) === 3 && selectedRule.march_amount && parseFloat(selectedRule.march_amount) > 0) {
            deduction = selectedRule.march_amount;
        }

        return res.ok({ monthly_amount: parseFloat(deduction) });

    } catch (err) {
        return handleError(err, res, req);
    }
};


exports.getPTByMonth = async (req, res) => {
    try {
        const { employee_id, month } = req.body;

        if (!employee_id) {
            return res.error(constants.VALIDATION_ERROR, { employee_id: "Employee is required" });
        }

        const employee = await commonQuery.findOneRecord(Employee, { id: employee_id }, null, false, {});
        if (!employee) {
            return res.error(constants.NOT_FOUND);
        }

        const state_id = employee.state_id;
        const gender = employee.gender;
        const monthly_salary = employee.monthly_salary;

        if (!state_id) {
            return res.error(constants.VALIDATION_ERROR, { state_id: "Employee state not found" });
        }

        const matchingRules = await StatutoryPTRule.findAll({
            where: {
                state_id,
                status: 0,
                min_salary: { [Op.lte]: monthly_salary },
                [Op.or]: [
                    { max_salary: { [Op.gte]: monthly_salary } },
                    { max_salary: null }
                ],
                gender: { [Op.in]: [gender, 3] }
            }
        });

        if (!matchingRules || matchingRules.length === 0) {
            return res.ok({ monthly_amount: 0 });
        }

        let selectedRule = matchingRules.find(r => r.gender == gender);
        if (!selectedRule) selectedRule = matchingRules.find(r => r.gender == 3);
        if (!selectedRule) selectedRule = matchingRules[0];

        let deduction = selectedRule.monthly_amount;
        if (parseInt(month) === 3 && selectedRule.march_amount && parseFloat(selectedRule.march_amount) > 0) {
            deduction = selectedRule.march_amount;
        }

        return res.ok({ monthly_amount: parseFloat(deduction) });

    } catch (err) {
        return handleError(err, res, req);
    }
};
