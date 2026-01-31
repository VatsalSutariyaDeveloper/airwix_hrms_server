const { 
    EmployeeLeaveBalance, 
    Employee,
    LeaveTemplate,
    sequelize 
} = require("../../models");
const { commonQuery, handleError, constants } = require("../../helpers");
const LeaveBalanceService = require("../../services/leaveBalanceService");
const dayjs = require("dayjs");

/**
 * Controller to handle employee-specific leave balance and configuration.
 */
const employeeLeaveBalanceController = {
    /**
     * Get employee-specific leave balances.
     */
    getByEmployeeId: async (req, res) => {
        try {
            const { employeeId } = req.params;

            const leaveBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, { 
                employee_id: employeeId,
                status: 0 // Fetch active balances
            });

            if (!leaveBalances || leaveBalances.length === 0) {
            return res.error(constants.NOT_FOUND, { message: "No leave balances found for this employee" });
        }

            // Map total_allocated to leave_count for frontend compatibility
            const mappedBalances = leaveBalances.map(b => {
                const data = b.toJSON();
                return {
                    ...data,
                    leave_count: data.total_allocated
                };
            });

            return res.success("Employee leave balances fetched successfully", mappedBalances);
        } catch (error) {
            return handleError(error, res, req);
        }
    },

    /**
     * Update employee-specific leave balances.
     * This updates the counts and rules directly on the balance record.
     */
    updateByEmployeeId: async (req, res) => {
        const transaction = await sequelize.transaction();
        try {
            const { employeeId } = req.params;
            const { leaveBalances } = req.body; // Array of balance updates

            if (!Array.isArray(leaveBalances)) {
                return res.error(constants.INVALID_ID,"Invalid leave data");
            }

            const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, transaction);
            if (!employee) {
                return res.error(NOT_FOUND,"Employee not found");
            }

            for (const bal of leaveBalances) {
                // If the item has an ID, it's an existing balance record to update
                // Otherwise, we might need leave_category_id to find/create it
                const searchCriteria = bal.id 
                    ? { id: bal.id } 
                    : { employee_id: employeeId, leave_category_id: bal.leave_category_id };

                const existingBalance = await commonQuery.findOneRecord(EmployeeLeaveBalance, searchCriteria, {}, transaction);

                if (existingBalance) {
                    const newTotal = parseFloat(bal.leave_count !== undefined ? bal.leave_count : bal.total_allocated || 0);
                    const used = parseFloat(existingBalance.used_leaves || 0);
                    const carryForward = parseFloat(existingBalance.carry_forward_leaves || 0);

                    const updateData = {
                        total_allocated: newTotal,
                        pending_leaves: (newTotal + carryForward) - used,
                        leave_category_name: bal.leave_category_name || existingBalance.leave_category_name,
                        unused_leave_rule: bal.unused_leave_rule || existingBalance.unused_leave_rule,
                        carry_forward_limit: bal.carry_forward_limit !== undefined ? bal.carry_forward_limit : existingBalance.carry_forward_limit,
                        is_paid: bal.is_paid !== undefined ? bal.is_paid : existingBalance.is_paid,
                        automation_rules: bal.automation_rules !== undefined ? bal.automation_rules : existingBalance.automation_rules,
                    };

                    await commonQuery.updateRecordById(EmployeeLeaveBalance, existingBalance.id, updateData, transaction);
                } else if (bal.leave_category_id && employee.leave_template) {
                    // Create if it doesn't exist (e.g. manually adding a category that was missed)
                    const newTotal = parseFloat(bal.leave_count || bal.total_allocated || 0);
                    
                    // Get cycle year
                    const template = await commonQuery.findOneRecord(LeaveTemplate, employee.leave_template, {}, transaction);
                    const { start } = LeaveBalanceService.getCycleDates(employee.joining_date, template.leave_policy_cycle);

                    await commonQuery.createRecord(EmployeeLeaveBalance, {
                        employee_id: employeeId,
                        leave_template_id: employee.leave_template,
                        leave_category_id: bal.leave_category_id,
                        year: start.year(),
                        leave_category_name: bal.leave_category_name,
                        total_allocated: newTotal,
                        pending_leaves: newTotal,
                        unused_leave_rule: bal.unused_leave_rule || 'LAPSE',
                        carry_forward_limit: bal.carry_forward_limit || 0,
                        is_paid: bal.is_paid !== undefined ? bal.is_paid : true,
                        automation_rules: bal.automation_rules || null,
                        company_id: employee.company_id,
                        status: 0
                    }, transaction);
                }
            }

            await transaction.commit();
            return res.success("Employee leave balances updated successfully");
        } catch (error) {
            await transaction.rollback();
            return handleError(error, res, req);
        }
    }
};

module.exports = employeeLeaveBalanceController;
