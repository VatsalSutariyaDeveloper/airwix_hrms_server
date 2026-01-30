
const { 
    EmployeeLeaveCategory, 
    LeaveBalance,
    Employee,
    LeaveTemplate,
    sequelize 
} = require("../../models");
const { commonQuery, handleError } = require("../../helpers");
const LeaveBalanceService = require("../../services/leaveBalanceService");
const dayjs = require("dayjs");

const employeeLeaveCategoryController = {
    /**
     * Get employee-specific leave categories.
     */
    getByEmployeeId: async (req, res) => {
        try {
            const { employeeId } = req.params;

            const leaveCategories = await commonQuery.findAllRecords(EmployeeLeaveCategory, { 
                employee_id: employeeId 
            });

            if (!leaveCategories || leaveCategories.length === 0) {
                return res.success([], "No leave categories found for this employee");
            }

            return res.success("Employee leave categories fetched successfully", leaveCategories);
        } catch (error) {
            return handleError(error, res, req);
        }
    },

    /**
     * Update employee-specific leave categories.
     * This handles bulk updates for an employee's leave categories and syncs LeaveBalance.
     */
    updateByEmployeeId: async (req, res) => {
        const transaction = await sequelize.transaction();
        try {
            const { employeeId } = req.params;
            const { leaveCategories } = req.body;

            if (!Array.isArray(leaveCategories)) {
                return res.error("Invalid leave categories data", 400);
            }

            // 1. Fetch employee to get cycle information if needed
            const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, transaction);
            if (!employee) {
                return res.error("Employee not found", 404);
            }

            // 2. Hard delete existing records for this employee to sync
            await commonQuery.hardDeleteRecords(EmployeeLeaveCategory, { 
                employee_id: employeeId 
            }, transaction);

            // 3. Bulk create new records
            if (leaveCategories.length > 0) {
                const payloads = leaveCategories.map(cat => ({
                    employee_id: employeeId,
                    leave_template_id: cat.leave_template_id || null,
                    leave_category_name: cat.leave_category_name,
                    leave_count: cat.leave_count || 0,
                    unused_leave_rule: cat.unused_leave_rule || 'LAPSE',
                    carry_forward_limit: cat.carry_forward_limit || 0,
                    is_paid: cat.is_paid !== undefined ? cat.is_paid : true,
                    status: cat.status || 0,
                    company_id: req.user?.company_id || 0,
                }));

                await commonQuery.bulkCreate(EmployeeLeaveCategory, payloads, {}, transaction);

                // 4. Update LeaveBalance Table
                // Get cycle year for the employee
                let cycleYear = dayjs().year();
                if (employee.leave_template) {
                    const template = await commonQuery.findOneRecord(LeaveTemplate, employee.leave_template, {}, transaction);
                    if (template) {
                        const { start } = LeaveBalanceService.getCycleDates(employee.joining_date, template.leave_policy_cycle);
                        cycleYear = start.year();
                    }
                }

                // For each leave category, find and update or create balance
                for (const cat of leaveCategories) {
                    // Try to find the balance for this category by name mapping (since category IDs might differ between template and employee)
                    // Note: This logic assumes we update balances for categories that exist in the system.
                    // If these are custom categories, they might not have a direct mapping in leave_balances.leave_category_id (which usually refs template_categories).
                    // However, we'll try to sync if cat.leave_category_id is provided.
                    
                    if (cat.leave_category_id) { // This would be the ID from leave_template_categories
                        const existingBalance = await commonQuery.findOneRecord(LeaveBalance, {
                            employee_id: employeeId,
                            leave_category_id: cat.leave_category_id,
                            year: cycleYear
                        }, {}, transaction);

                        if (existingBalance) {
                            const newTotal = parseFloat(cat.leave_count || 0);
                            const used = parseFloat(existingBalance.used_leaves || 0);
                            const carryForward = parseFloat(existingBalance.carry_forward_leaves || 0);
                            
                            await commonQuery.updateRecordById(LeaveBalance, existingBalance.id, {
                                total_allocated: newTotal,
                                pending_leaves: (newTotal + carryForward) - used
                            }, transaction);
                        }
                    }
                }
            }

            await transaction.commit();
            return res.success("Employee leave categories and balances updated successfully");
        } catch (error) {
            await transaction.rollback();
            return handleError(error, res, req);
        }
    }
};

module.exports = employeeLeaveCategoryController;
