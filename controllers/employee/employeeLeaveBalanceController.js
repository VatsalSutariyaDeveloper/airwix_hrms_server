const { 
    EmployeeLeaveBalance, 
    Employee,
    LeaveTemplate,
    sequelize 
} = require("../../models");
const { commonQuery, handleError, constants } = require("../../helpers");
const LeaveBalanceService = require("../../services/leaveBalanceService");

/**
 * Get employee-specific leave balances.
 */
exports.getByEmployeeId = async (req, res) => {
    try {
        let employeeId = req.body.employee_id;
        if(!employeeId){
            employeeId = req.user.employee_id;
        }

        // Fetch employee to get cycle information
        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        });

        const dayjs = require("dayjs");
        let cycle_info = { start: null, end: null, period: "" };
        let activeYear = null;
        const referenceDate = req.body.date ? dayjs(req.body.date) : dayjs();
        
        if (employee && employee.leaveTemplate) {
            const { start, end } = LeaveBalanceService.getCycleDates(employee.joining_date, employee.leaveTemplate.leave_policy_cycle, referenceDate);
            cycle_info.start = start.format('YYYY-MM-DD');
            cycle_info.end = end.format('YYYY-MM-DD');
            
            if (start.isSame(end, 'month')) {
                cycle_info.period = start.format('MMM\'YY');
            } else {
                cycle_info.period = `${start.format('MMM\'YY')} - ${end.format('MMM\'YY')}`;
            }
            activeYear = end.year();
        }

        const cycleType = employee?.leaveTemplate?.leave_policy_cycle || 'CALENDAR_YEAR';
        const isMonthlyCycle = ['MONTHLY', 'QUARTERLY'].includes(cycleType);

        const leaveBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, { 
            employee_id: employeeId,
            status: 0, // Fetch active balances
            ...(activeYear ? { year: activeYear } : {}),
            month: isMonthlyCycle ? dayjs(cycle_info.end).month() + 1 : null
        }, {
            order: [['id', 'ASC']]
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

        return res.success("Employee leave balances fetched successfully", {
            balances: mappedBalances,
            cycle_info
        });
    } catch (error) {
        return handleError(error, res, req);
    }
},

/**
 * Update employee-specific leave balances.
 * This updates the counts and rules directly on the balance record.
 */
exports.updateByEmployeeId = async (req, res) => {
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
                let newTotal = parseFloat(bal.leave_count !== undefined ? bal.leave_count : bal.total_allocated || 0);
                newTotal = Math.round(newTotal * 2) / 2;
                
                const used = parseFloat(existingBalance.used_leaves || 0);
                const carryForward = Math.round(parseFloat(existingBalance.carry_forward_leaves || 0) * 2) / 2;
                const isPaid = bal.is_paid !== undefined ? bal.is_paid : existingBalance.is_paid;
                const isCompOff = bal.is_compoff !== undefined ? bal.is_compoff : existingBalance.is_compoff;

                let pending = Math.round(((newTotal + carryForward) - used) * 2) / 2;
                
                // If it's unpaid leave OR if the allocation is 0, keep pending at 0 to avoid negative values
                if ((!isPaid && !isCompOff) || pending < 0) {
                    pending = Math.max(0, pending);
                }

                const updateData = {
                    total_allocated: newTotal,
                    pending_leaves: pending,
                    leave_category_name: bal.leave_category_name || existingBalance.leave_category_name,
                    unused_leave_rule: bal.unused_leave_rule || existingBalance.unused_leave_rule,
                    carry_forward_limit: bal.carry_forward_limit !== undefined ? (Math.round(bal.carry_forward_limit * 2) / 2) : existingBalance.carry_forward_limit,
                    is_paid: isPaid,
                    is_compoff: isCompOff,
                    automation_rules: bal.automation_rules !== undefined ? bal.automation_rules : existingBalance.automation_rules,
                };

                await commonQuery.updateRecordById(EmployeeLeaveBalance, existingBalance.id, updateData, transaction);
            } else if (bal.leave_category_id && employee.leave_template) {
                // Create if it doesn't exist (e.g. manually adding a category that was missed)
                let newTotal = parseFloat(bal.leave_count || bal.total_allocated || 0);
                newTotal = Math.round(newTotal * 2) / 2;
                
                // Get cycle year
                const template = await commonQuery.findOneRecord(LeaveTemplate, employee.leave_template, {}, transaction);
                const { end } = LeaveBalanceService.getCycleDates(employee.joining_date, template.leave_policy_cycle);

                await commonQuery.createRecord(EmployeeLeaveBalance, {
                    employee_id: employeeId,
                    leave_template_id: employee.leave_template,
                    leave_category_id: bal.leave_category_id,
                    year: end.year(),
                    month: template.leave_policy_cycle === 'MONTHLY' ? end.month() + 1 : null,
                    leave_category_name: bal.leave_category_name,
                    total_allocated: newTotal,
                    pending_leaves: newTotal,
                    unused_leave_rule: bal.unused_leave_rule || 'LAPSE',
                    carry_forward_limit: bal.carry_forward_limit !== undefined ? (Math.round(bal.carry_forward_limit * 2) / 2) : 0,
                    is_paid: bal.is_paid !== undefined ? bal.is_paid : true,
                    is_compoff: bal.is_compoff !== undefined ? bal.is_compoff : false,
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
