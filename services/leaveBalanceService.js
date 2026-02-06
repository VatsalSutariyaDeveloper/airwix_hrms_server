const { EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, LeaveRequest, sequelize } = require("../models");
const { commonQuery, Op } = require("../helpers");
const dayjs = require("dayjs");

/**
 * Service to manage employee-specific leave balances, including pro-rata calculations,
 * different yearly cycles, and monthly accruals.
 */
class LeaveBalanceService {
    /**
     * Helper to get Cycle Start and End dates for an employee
     */
    static getCycleDates(employeeJoiningDate, cycleType) {
        const today = dayjs();
        let start, end;

        if (cycleType === 'CALENDAR_YEAR') {
            start = dayjs().startOf('year');
            end = dayjs().endOf('year');
        } else if (cycleType === 'FINANCIAL_YEAR') {
            // Financial Year: April 1 to March 31
            const currentYear = today.year();
            if (today.month() >= 3) { // April onwards
                start = dayjs(`${currentYear}-04-01`);
                end = dayjs(`${currentYear + 1}-03-31`);
            } else { // Jan to March
                start = dayjs(`${currentYear - 1}-04-01`);
                end = dayjs(`${currentYear}-03-31`);
            }
        } else if (cycleType === 'SERVICE_YEAR') {
            // Anniversary based
            const joinDate = dayjs(employeeJoiningDate);
            const anniversaryThisYear = joinDate.year(today.year());
            
            if (today.isBefore(anniversaryThisYear)) {
                start = anniversaryThisYear.subtract(1, 'year');
                end = anniversaryThisYear.subtract(1, 'day');
            } else {
                start = anniversaryThisYear;
                end = anniversaryThisYear.add(1, 'year').subtract(1, 'day');
            }
        }

        return { start, end };
    }

    /**
     * Calculates the leaves earned in a specific window.
     */
    static calculateProRata(joiningDate, annualTotal, cycleEndDate, rule = 'THRESHOLD_BASED') {
        const join = dayjs(joiningDate);
        const end = dayjs(cycleEndDate);
        
        const monthlyRate = annualTotal / 12;
        let diffMonths = end.diff(join.add(1, 'month').startOf('month'), 'month') + 1;
        const day = join.date();
        let joinMonthCredit = 0;

        if (rule === 'THRESHOLD_BASED') {
            if (day <= 7) joinMonthCredit = monthlyRate;
            else if (day <= 22) joinMonthCredit = monthlyRate / 2;
            else joinMonthCredit = 0;
        } else if (rule === 'FULL_MONTH') {
            joinMonthCredit = monthlyRate;
        } else if (rule === 'PRO_RATA_DAYS') {
            const daysInMonth = join.daysInMonth();
            const daysRemaining = daysInMonth - day + 1;
            joinMonthCredit = (daysRemaining / daysInMonth) * monthlyRate;
        }

        let total = (diffMonths * monthlyRate) + joinMonthCredit;
        return Math.round(total * 2) / 2;
    }

    /**
     * Primary entry point: Assigns/Syncs leaves to an employee.
     */
    static async initializeBalance(employeeId, templateId, transaction = null) {
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, t);
            if (!employee) throw new Error("Employee not found");

            const template = await commonQuery.findOneRecord(LeaveTemplate, templateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t);

            if (!template) throw new Error("Leave template not found or inactive");

            const { start, end } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
            const results = [];

            for (const category of template.categories) {
                let allocated = 0;

                if (template.accrual_type === 'UPFRONT') {
                    const joinDate = dayjs(employee.joining_date);
                    if (joinDate.isAfter(start)) {
                        allocated = this.calculateProRata(employee.joining_date, category.leave_count, end, template.join_month_rule);
                    } else {
                        allocated = category.leave_count;
                    }
                } else if (template.accrual_type === 'MONTHLY') {
                    const monthlyRate = category.leave_count / 12;
                    const day = dayjs().date();
                    
                    if (template.join_month_rule === 'THRESHOLD_BASED') {
                        if (day <= 7) allocated = monthlyRate;
                        else if (day <= 22) allocated = monthlyRate / 2;
                        else allocated = 0;
                    } else if (template.join_month_rule === 'FULL_MONTH') {
                        allocated = monthlyRate;
                    } else if (template.join_month_rule === 'PRO_RATA_DAYS') {
                        const today = dayjs();
                        const daysInMonth = today.daysInMonth();
                        const daysRemaining = daysInMonth - today.date() + 1;
                        allocated = (daysRemaining / daysInMonth) * monthlyRate;
                    }
                }

                // Metadata to store from template category
                const metaFields = {
                    leave_category_name: category.leave_category_name,
                    unused_leave_rule: category.unused_leave_rule,
                    carry_forward_limit: parseFloat(category.carry_forward_limit || 0),
                    is_paid: category.is_paid,
                    automation_rules: category.automation_rules,
                };

                // Upsert balance record
                const existingBalance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                    employee_id: employeeId,
                    leave_category_id: category.id,
                    year: start.year()
                }, {}, t);

                let balance;
                // Calculate pending leaves (considering existing usage if applicable)
                const carryForward = existingBalance ? parseFloat(existingBalance.carry_forward_leaves || 0) : 0;
                const used = existingBalance ? parseFloat(existingBalance.used_leaves || 0) : 0;
                let pending = allocated + carryForward - used;

                // Ensure unpaid leaves or zero-allocation categories don't show negative pending leaves
                if (!category.is_paid || allocated === 0) {
                    pending = 0;
                }

                if (existingBalance) {
                    balance = await commonQuery.updateRecordById(EmployeeLeaveBalance, existingBalance.id, {
                        ...metaFields,
                        total_allocated: allocated,
                        pending_leaves: pending,
                        leave_template_id: templateId,
                        year: start.year()
                    }, t);
                } else {
                    balance = await commonQuery.createRecord(EmployeeLeaveBalance, {
                        ...metaFields,
                        employee_id: employeeId,
                        leave_category_id: category.id,
                        year: start.year(),
                        leave_template_id: templateId,
                        total_allocated: allocated,
                        pending_leaves: pending,
                        company_id: employee.company_id
                    }, t);
                }
                results.push(balance);
            }

            if (!transaction) await t.commit();
            return results;
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Synchronizes balances when an employee's template is changed.
     */
    static async syncEmployeeBalances(employeeId, newTemplateId, transaction = null) {
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, t);
            if (!employee) throw new Error("Employee not found");

            if (!newTemplateId) {
                await commonQuery.updateRecordById(EmployeeLeaveBalance, {
                    employee_id: employeeId,
                    status: 0
                }, { status: 2 }, t);
                
                if (!transaction) await t.commit();
                return [];
            }

            const newTemplate = await commonQuery.findOneRecord(LeaveTemplate, newTemplateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t);

            if (!newTemplate) throw new Error("New leave template not found");

            const newCategoryIds = newTemplate.categories.map(c => c.id);
            const { start } = this.getCycleDates(employee.joining_date, newTemplate.leave_policy_cycle);

            // 1. Mark ANY active balance as status=2 (deleted/inactive) if their category is not in the new template
            // Satisfaction of: "if any category exist in leave balannce table and it not exist in new updated leave template then delete that category data"
            await commonQuery.updateRecordById(EmployeeLeaveBalance, {
                employee_id: employeeId,
                status: 0,
                leave_category_id: { [Op.notIn]: newCategoryIds }
            }, { status: 2 }, t);

            // 2. Run standard initialization
            const results = await this.initializeBalance(employeeId, newTemplateId, t);

            if (!transaction) await t.commit();
            return results;
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Batch job to add monthly credits.
     */
    static async processMonthlyAccruals() {
        const transaction = await sequelize.transaction();
        try {
            const templates = await commonQuery.findAllRecords(LeaveTemplate, {
                accrual_type: 'MONTHLY',
                status: 0
            }, {
                include: [{ model: LeaveTemplateCategory, as: 'categories', where: { status: 0 } }]
            }, transaction);

            for (const template of templates) {
                const employees = await commonQuery.findAllRecords(Employee, {
                    leave_template: template.id,
                    status: 0
                }, {}, transaction);

                for (const employee of employees) {
                    const { start } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
                    
                    for (const category of template.categories) {
                        const monthlyRate = category.leave_count / 12;

                        const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                            employee_id: employee.id,
                            leave_category_id: category.id,
                            year: start.year(),
                            status: 0
                        }, {}, transaction);

                        if (balance) {
                            const newTotal = parseFloat(balance.total_allocated || 0) + monthlyRate;
                            const newPending = parseFloat(balance.pending_leaves || 0) + monthlyRate;
                            
                            await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, {
                                total_allocated: Math.round(newTotal * 2) / 2,
                                pending_leaves: Math.round(newPending * 2) / 2
                            }, transaction);
                        }
                    }
                }
            }

            await transaction.commit();
        } catch (error) {
            await transaction.rollback();
            console.error("❌ Error processing monthly accruals:", error);
        }
    }

    /**
     * Year-End Reset Logic.
     */
    static async processYearEndReset() {
        const transaction = await sequelize.transaction();
        try {
            const today = dayjs();
            const employees = await commonQuery.findAllRecords(Employee, {
                status: 0,
                leave_template: { [Op.ne]: null }
            }, {
                include: [{
                    model: LeaveTemplate,
                    as: 'leaveTemplate',
                    include: [{ model: LeaveTemplateCategory, as: 'categories', where: { status: 0 } }]
                }]
            }, transaction);

            for (const employee of employees) {
                const template = employee.leaveTemplate;
                if (!template) continue;

                const yesterday = today.subtract(1, 'day');
                const { end: lastCycleEnd } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
                
                if (!yesterday.isSame(lastCycleEnd, 'day')) continue;

                const lastYear = lastCycleEnd.year();
                
                for (const category of template.categories) {
                    const lastBalance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                        employee_id: employee.id,
                        leave_category_id: category.id,
                        year: lastYear,
                        status: 0
                    }, {}, transaction);

                    if (!lastBalance) continue;

                    let carryForwardAmount = 0;
                    if (category.unused_leave_rule === 'CARRY_FORWARD') {
                        const limit = parseFloat(category.carry_forward_limit || 0);
                        const remaining = parseFloat(lastBalance.pending_leaves || 0);
                        carryForwardAmount = Math.min(remaining, limit);
                    }

                    await this.initializeBalance(employee.id, template.id, transaction);

                    const newYear = today.year();
                    const newBalance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                        employee_id: employee.id,
                        leave_category_id: category.id,
                        year: newYear,
                        status: 0
                    }, {}, transaction);

                    if (newBalance) {
                        await commonQuery.updateRecordById(EmployeeLeaveBalance, newBalance.id, {
                            carry_forward_leaves: carryForwardAmount,
                            pending_leaves: parseFloat(newBalance.pending_leaves || 0) + carryForwardAmount
                        }, transaction);
                    }
                }
            }

            await transaction.commit();
        } catch (error) {
            await transaction.rollback();
            console.error("❌ Error processing year-end reset:", error);
        }
    }

    /**
     * Deducts or Adds leave back to employee balance.
     * @param {number} employeeId
     * @param {number} categoryId
     * @param {number} amount - Positive to deduct, Negative to add back.
     * @param {Object} transaction
     */
    static async adjustLeaveBalance(employeeId, categoryId, amount, transaction = null) {
        if (!employeeId || !categoryId || amount === 0) return;
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = await commonQuery.findOneRecord(Employee, employeeId, {}, t);
            if (!employee) throw new Error("Employee not found");

            // Determine the correct cycle/year
            const template = await commonQuery.findOneRecord(LeaveTemplate, employee.leave_template, {}, t);
            const { start } = this.getCycleDates(employee.joining_date, template ? template.leave_policy_cycle : 'CALENDAR_YEAR');
            const year = start.year();

            const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                employee_id: employeeId,
                leave_category_id: categoryId,
                year: year,
                status: 0
            }, {}, t);

            if (!balance) {
                console.warn(`[LeaveBalanceService] No balance found for emp ${employeeId}, category ${categoryId}, year ${year}. Skipping adjustment.`);
                return;
            }

            const used = parseFloat(balance.used_leaves || 0) + amount;
            let pending = parseFloat(balance.pending_leaves || 0) - amount;

            // Don't show negative pending leaves for unpaid/zero-allocation
            if (pending < 0 && (!balance.is_paid || balance.total_allocated === 0)) {
                pending = 0;
            }

            await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, {
                used_leaves: used,
                pending_leaves: pending
            }, t);

            if (!transaction) await t.commit();
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Synchronizes a LeaveRequest based on attendance status.
     * @param {number} employeeId
     * @param {string} date - YYYY-MM-DD
     * @param {number} categoryId
     * @param {number} amount - 0.5, 1.0, or 0 (to cancel)
     * @param {Object} transaction
     */
    static async syncLeaveRecord(employeeId, date, categoryId, amount, transaction = null) {
        if (!employeeId || !date) return;
        const t = transaction || (await sequelize.transaction());
        try {
            const AUTO_REASON = "Auto-generated from Attendance";
            
            // 1. Check if a MANUAL approved request exists for this day
            // We search for ANY approved request that covers this date and is NOT auto-generated
            const manualRequest = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id: employeeId,
                start_date: { [Op.lte]: date },
                end_date: { [Op.gte]: date },
                approval_status: 'APPROVED',
                status: 0,
                reason: { [Op.ne]: AUTO_REASON }
            }, {}, t);

            // 2. Find existing auto-generated request for this specific date
            const existingAuto = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id: employeeId,
                start_date: date,
                end_date: date,
                status: 0,
                reason: AUTO_REASON
            }, {}, t);

            // If a manual request covers this day, we should probably not have an auto-generated one competing.
            if (manualRequest) {
                // If we have an auto-generated one, cancel it (manual wins)
                if (existingAuto) {
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t);
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, { approval_status: 'CANCELLED', status: 2 }, t);
                }
                // We don't create/update any auto-record because manual is already there.
                if (!transaction) await t.commit();
                return;
            }

            // --- Manage Auto-Generated Record ---

            // CASE A: Amount is 0 (Status changed away from Leave/HalfDay)
            if (amount === 0) {
                if (existingAuto) {
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t);
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, { approval_status: 'CANCELLED', status: 2 }, t);
                } else if (manualRequest) {
                    // If it's a single day manual request, cancel it
                    if (manualRequest.start_date === date && manualRequest.end_date === date) {
                        await this.adjustLeaveBalance(employeeId, manualRequest.leave_category_id, -manualRequest.total_days, t);
                        await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, { approval_status: 'CANCELLED', status: 2 }, t);
                    }
                }
            }
            // CASE B: Category or Amount Changed for existing auto-request
            else if (existingAuto) {
                if (existingAuto.leave_category_id !== categoryId || parseFloat(existingAuto.total_days || 0) !== amount) {
                    // Refund OLD
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t);
                    // Deduct NEW
                    await this.adjustLeaveBalance(employeeId, categoryId, amount, t);
                    // Update Request
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, {
                        leave_category_id: categoryId,
                        total_days: amount,
                        approval_status: 'APPROVED'
                    }, t);
                }
            } 
            // CASE C: No existing auto-request, create one
            else {
                // Deduct Balance
                await this.adjustLeaveBalance(employeeId, categoryId, amount, t);
                
                // Fetch basic employee/company info for the record
                const employee = await commonQuery.findOneRecord(Employee, employeeId, {
                    attributes: ['company_id', 'branch_id']
                }, t);

                // Create Request
                await commonQuery.createRecord(LeaveRequest, {
                    employee_id: employeeId,
                    leave_category_id: categoryId,
                    start_date: date,
                    end_date: date,
                    total_days: amount,
                    reason: AUTO_REASON,
                    approval_status: 'APPROVED',
                    approved_by: 0, // System/Auto
                    company_id: employee?.company_id || 0,
                    branch_id: employee?.branch_id || 0,
                    user_id: 0,
                    status: 0
                }, t);
            }

            if (!transaction) await t.commit();
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }
}

module.exports = LeaveBalanceService;
