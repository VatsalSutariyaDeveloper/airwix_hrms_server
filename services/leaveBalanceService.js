const { EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, LeaveRequest, sequelize } = require("../models");
const { commonQuery, Op } = require("../helpers");
const { constants } = require("../helpers/constants");
const dayjs = require("dayjs");
// const { getDayOffInfo } = require("../helpers/attendanceHelper");

/**
 * Service to manage employee-specific leave balances, including pro-rata calculations,
 * different yearly cycles, and monthly accruals.
 */
class LeaveBalanceService {
    /**
     * Helper to get Cycle Start and End dates for an employee
     */
    static getCycleDates(employeeJoiningDate, cycleType, referenceDate = dayjs()) {
        const today = dayjs(referenceDate);
        let start, end;

        if (cycleType === 'CALENDAR_YEAR') {
            start = today.startOf('year');
            end = today.endOf('year');
            console.log("start",start,"end",end)
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
        } else if (cycleType === 'MONTHLY') {
            start = today.startOf('month');
            end = today.endOf('month');
        } else if (cycleType === 'QUARTERLY') {
            const startMonth = Math.floor(today.month() / 3) * 3;
            start = today.month(startMonth).startOf('month');
            end = start.add(2, 'month').endOf('month');
        } else if (cycleType === 'CUSTOM_RANGE') {
            // Usually combined with leave_period_start from template
            // For initialization, we use the start date from template if available
            start = today.startOf('month'); // Fallback
            end = start.add(1, 'year').subtract(1, 'day');
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
        const nextMonthStart = join.add(1, 'month').startOf('month');
        let diffMonths = end.isBefore(nextMonthStart) ? 0 : end.diff(nextMonthStart, 'month') + 1;
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
        return Math.ceil(total * 2) / 2;
    }

    /**
     * Primary entry point: Assigns/Syncs leaves to an employee.
     */
    static async initializeBalance(employeeId, templateId, transaction = null, preFetchedEmployee = null, preFetchedTemplate = null) {
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = preFetchedEmployee || await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
            if (!employee) throw new Error("Employee not found");

            const template = preFetchedTemplate || await commonQuery.findOneRecord(LeaveTemplate, templateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t, true);

            if (!template) throw new Error("Leave template not found or inactive");

            const { start, end } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
            const results = [];

            for (const category of template.categories) {
                let allocated = 0;
                console.log("category",category)
                if (template.accrual_type === 'UPFRONT') {
                    const joinDate = dayjs(employee.joining_date);
                    if (joinDate.isAfter(start)) {
                        let annualTotal = category.leave_count;
                        if (template.leave_policy_cycle === 'MONTHLY') {
                            annualTotal = category.leave_count * 12;
                        } else if (template.leave_policy_cycle === 'QUARTERLY') {
                            annualTotal = category.leave_count * 4;
                        }
                        allocated = this.calculateProRata(employee.joining_date, annualTotal, end, template.join_month_rule);
                    } else {
                        allocated = category.leave_count;
                    }
                } else if (template.accrual_type === 'MONTHLY') {
                    let monthlyRate = category.leave_count / 12; 
                    if (template.leave_policy_cycle === 'MONTHLY') {
                        monthlyRate = category.leave_count;
                    } else if (template.leave_policy_cycle === 'QUARTERLY') {
                        monthlyRate = '';
                    }

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

                // Apply Rounding to Allocation
                allocated = Math.ceil(allocated * 2) / 2;

                // Metadata to store from template category
                const metaFields = {
                    leave_category_name: category.leave_category_name,
                    unused_leave_rule: category.unused_leave_rule,
                    carry_forward_limit: parseFloat(category.carry_forward_limit || 0),
                    is_paid: category.is_paid,
                    is_compoff: category.is_compoff,
                    automation_rules: category.automation_rules,
                };

                // Upsert balance record
                const existingBalance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                    employee_id: employeeId,
                    leave_category_id: category.id,
                    status: 0
                }, {}, t);

                let balance;
                // Calculate pending leaves (considering existing usage if applicable)
                const carryForward = existingBalance ? parseFloat(existingBalance.carry_forward_leaves || 0) : 0;
                const used = existingBalance ? parseFloat(existingBalance.used_leaves || 0) : 0;
                let pending = Math.ceil((allocated + carryForward - used) * 2) / 2;

                // Ensure unpaid leaves or zero-allocation categories don't show negative pending leaves
                if ((!category.is_paid && !category.is_compoff) || pending < 0) {
                    pending = Math.max(0, pending);
                }

                if (existingBalance) {
                    balance = await commonQuery.updateRecordById(EmployeeLeaveBalance, existingBalance.id, {
                        ...metaFields,
                        total_allocated: allocated,
                        pending_leaves: pending,
                        leave_template_id: templateId,
                        year: end.year(),
                        month: template.leave_policy_cycle === 'MONTHLY' ? end.month() + 1 : null
                    }, t);
                } else {
                    balance = await commonQuery.createRecord(EmployeeLeaveBalance, {
                        ...metaFields,
                        employee_id: employeeId,
                        leave_category_id: category.id,
                        year: end.year(),
                        month: template.leave_policy_cycle === 'MONTHLY' ? end.month() + 1 : null,
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
    static async syncEmployeeBalances(employeeId, newTemplateId, transaction = null, preFetchedEmployee = null, preFetchedTemplate = null) {
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = preFetchedEmployee || await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
            if (!employee) throw new Error("Employee not found");

            if (!newTemplateId) {
                await commonQuery.updateRecordById(EmployeeLeaveBalance, {
                    employee_id: employeeId,
                    status: 0
                }, { status: 2 }, t);
                
                if (!transaction) await t.commit();
                return [];
            }

            const newTemplate = preFetchedTemplate || await commonQuery.findOneRecord(LeaveTemplate, newTemplateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t);

            if (!newTemplate) throw new Error("New leave template not found");

            const newCategoryIds = newTemplate.categories.map(c => c.id);
            // const { start } = this.getCycleDates(employee.joining_date, newTemplate.leave_policy_cycle);

            // 1. Mark ANY active balance as status=2 (deleted/inactive) if their category is not in the new template
            await commonQuery.updateRecordById(EmployeeLeaveBalance, {
                employee_id: employeeId,
                status: 0,
                leave_category_id: { [Op.notIn]: newCategoryIds }
            }, { status: 2 }, t);

            // 2. Run standard initialization
            const results = await this.initializeBalance(employeeId, newTemplateId, t, employee, newTemplate);

            if (!transaction) await t.commit();
            return results;
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Optimized bulk synchronization of leave balances.
     */
    static async bulkSyncEmployeeBalances(employeeIds, newTemplateId, transaction = null, meta = {}) {
        if (!Array.isArray(employeeIds) || employeeIds.length === 0) return;

        const t = transaction || (await sequelize.transaction());
        try {
            if (!newTemplateId) {
                await commonQuery.updateRecordById(EmployeeLeaveBalance, {
                    employee_id: { [Op.in]: employeeIds },
                    status: 0
                }, { status: 2 }, t);
                if (!transaction) await t.commit();
                return;
            }

            const template = meta.preFetchedMaster || await commonQuery.findOneRecord(LeaveTemplate, newTemplateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t);
            if (!template) throw new Error("Leave template not found");

            const categoryIds = template.categories.map(c => c.id);

            // 1. Deactivate balances for categories not in the new template
            await commonQuery.updateRecordById(EmployeeLeaveBalance, {
                employee_id: { [Op.in]: employeeIds },
                status: 0,
                leave_category_id: { [Op.notIn]: categoryIds }
            }, { status: 2 }, t);

            // 2. Perform bulk initialization - process in chunks to avoid memory issues
            const chunkSize = 50;
            for (let i = 0; i < employeeIds.length; i += chunkSize) {
                const chunk = employeeIds.slice(i, i + chunkSize);
                const employees = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: chunk } }, {}, t);
                
                for (const emp of employees) {
                    await this.initializeBalance(emp.id, newTemplateId, t, emp, template);
                }
            }

            if (!transaction) await t.commit();
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
            const templates = await LeaveTemplate.findAll({
                where: {
                    accrual_type: 'MONTHLY',
                    status: 0
                },
                include: [{ 
                    model: LeaveTemplateCategory, 
                    as: 'categories', 
                    where: { status: 0 } 
                }],
                transaction
            });

            for (const template of templates) {
                const employees = await Employee.findAll({
                    where: {
                        leave_template: template.id,
                        status: 0
                    },
                    transaction
                });

                for (const employee of employees) {
                    const { start, end } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
                    
                    for (const category of template.categories) {
                        let monthlyRate = category.leave_count / 12; // Default for annual cycles
                        if (template.leave_policy_cycle === 'MONTHLY') {
                            monthlyRate = category.leave_count;
                        } else if (template.leave_policy_cycle === 'QUARTERLY') {
                            monthlyRate = category.leave_count / 3;
                        }

                        const balance = await EmployeeLeaveBalance.findOne({
                            where: {
                                employee_id: employee.id,
                                leave_category_id: category.id,
                                year: end.year(),
                                month: (template.leave_policy_cycle === 'MONTHLY' || template.leave_policy_cycle === 'QUARTERLY') ? end.month() + 1 : null,
                                status: 0
                            },
                            transaction
                        });

                        if (balance) {
                            const newTotal = parseFloat(balance.total_allocated || 0) + monthlyRate;
                            const newPending = parseFloat(balance.pending_leaves || 0) + monthlyRate;
                            
                            await EmployeeLeaveBalance.update({
                                total_allocated: Math.round(newTotal * 10) / 10,
                                pending_leaves: Math.round(newPending * 10) / 10
                            }, {
                                where: { id: balance.id },
                                transaction
                            });
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
            const employees = await Employee.findAll({
                where: {
                    status: 0,
                    leave_template: { [Op.ne]: null }
                },
                include: [{
                    model: LeaveTemplate,
                    as: 'leaveTemplate',
                    include: [{ 
                        model: LeaveTemplateCategory, 
                        as: 'categories', 
                        where: { status: 0 } 
                    }]
                }],
                transaction
            });

            for (const employee of employees) {
                const template = employee.leaveTemplate;
                if (!template) continue;

                const yesterday = today.subtract(1, 'day');
                const { end: lastCycleEnd } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle, yesterday);
                
                if (!yesterday.isSame(lastCycleEnd, 'day')) continue;

                const lastYear = lastCycleEnd.year();
                
                for (const category of template.categories) {
                    const lastBalance = await EmployeeLeaveBalance.findOne({
                        where: {
                            employee_id: employee.id,
                            leave_category_id: category.id,
                            year: lastYear,
                            month: (template.leave_policy_cycle === 'MONTHLY' || template.leave_policy_cycle === 'QUARTERLY') ? lastCycleEnd.month() + 1 : null,
                            status: 0
                        },
                        transaction
                    });

                    if (!lastBalance) continue;

                    let carryForwardAmount = 0;
                    const remaining = parseFloat(lastBalance.pending_leaves || 0);

                    if (category.unused_leave_rule === 'CARRY_FORWARD') {
                        const limit = parseFloat(category.carry_forward_limit || 0);
                        carryForwardAmount = Math.min(remaining, limit);
                    } else if (category.unused_leave_rule === 'ENCASH') {
                        carryForwardAmount = 0;
                    } else {
                        carryForwardAmount = 0;
                    }

                    // 1. Mark OLD balance as processed
                    await EmployeeLeaveBalance.update({ status: 1 }, {
                        where: { id: lastBalance.id },
                        transaction
                    });

                    // 2. Initialize NEW balance for the next cycle
                    await this.initializeBalance(employee.id, template.id, transaction);

                    const { end: newCycleEnd } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
                    const newYear = newCycleEnd.year();
                    const newBalance = await EmployeeLeaveBalance.findOne({
                        where: {
                            employee_id: employee.id,
                            leave_category_id: category.id,
                            year: newYear,
                            month: (template.leave_policy_cycle === 'MONTHLY' || template.leave_policy_cycle === 'QUARTERLY') ? newCycleEnd.month() + 1 : null,
                            status: 0
                        },
                        transaction
                    });

                    if (newBalance) {
                        await EmployeeLeaveBalance.update({
                            carry_forward_leaves: carryForwardAmount,
                            pending_leaves: parseFloat(newBalance.pending_leaves || 0) + carryForwardAmount
                        }, {
                            where: { id: newBalance.id },
                            transaction
                        });
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
     * @param {string} date - Reference date for the adjustment (default today)
     */
    static async adjustLeaveBalance(employeeId, categoryId, amount, transaction = null, date = dayjs(), employee = null, isAllocation = false) {
        if (!employeeId || !categoryId || amount === 0) return;
        
        // Round amount to nearest 0.5
        const roundedAmount = Math.round(amount * 10) / 10;
        if (roundedAmount === 0) return;

        const t = transaction || (await sequelize.transaction());
        try {
            const emp = employee || await commonQuery.findOneRecord(Employee, employeeId, {}, t, false, { company_id: true });
            if (!emp) throw new Error("Employee not found");

            // Determine the correct cycle/year
            // Attempt to use templates from emp if they were included
            const template = emp.leaveTemplate || await commonQuery.findOneRecord(LeaveTemplate, emp.leave_template, {}, t);
            const { end } = this.getCycleDates(emp.joining_date, template ? template.leave_policy_cycle : 'CALENDAR_YEAR', date);
            const year = end.year();

            const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                employee_id: employeeId,
                leave_category_id: categoryId,
                year: year,
                month: (template && (template.leave_policy_cycle === 'MONTHLY' || template.leave_policy_cycle === 'QUARTERLY')) ? end.month() + 1 : null,
                status: 0
            }, {}, t);

            if (!balance) {
                console.warn(`[LeaveBalanceService] No balance found for emp ${employeeId}, category ${categoryId}, year ${year}. Skipping adjustment.`);
                return;
            }

            let used = parseFloat(balance.used_leaves || 0);
            let allocated = parseFloat(balance.total_allocated || 0);
            
            if (isAllocation) {
                allocated = Math.round((allocated - roundedAmount) * 10) / 10;
            } else {
                used = Math.round((used + roundedAmount) * 10) / 10;
            }

            let pending = Math.round((allocated + parseFloat(balance.carry_forward_leaves || 0) - used) * 10) / 10;
            
            // Strict validation: Don't allow negative balance for Paid categories or Comp-Off
            if (pending < 0 && (balance.is_paid || balance.is_compoff)) {
                throw new Error(`Insufficient leave balance in ${balance.leave_category_name}. Available: ${balance.pending_leaves}. Required: ${roundedAmount}.`);
            }

            // For Unpaid (LOP), we can allow "negative" logically but usually we keep pending at 0
            if (pending < 0 && (!balance.is_paid && !balance.is_compoff)) {
                pending = 0;
            }

            await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, {
                total_allocated: allocated,
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
     * @returns {string|null} Error message if adjustment failed
     */
    static async syncLeaveRecord(employeeId, date, categoryId, amount, transaction = null, employee = null) {
        if (!employeeId || !date) return null;
        const t = transaction || (await sequelize.transaction());
        try {
            console.log(`[syncLeaveRecord] Start - Emp: ${employeeId}, Date: ${date}, Category: ${categoryId}, Amount: ${amount}`);
            const AUTO_REASON = "Auto-generated from Attendance";
            
            // 1. Check if a MANUAL approved request exists for this day
            // We search for ANY approved request that covers this date and is NOT auto-generated
            const manualRequest = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id: employeeId,
                start_date: { [Op.lte]: date },
                end_date: { [Op.gte]: date },
                approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                is_encashment: false,
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
            if (manualRequest && amount > 0) {
                console.log(`[syncLeaveRecord] Manual request found: #${manualRequest.id}. Preserving manual leave as amount > 0.`);
                // If we have an auto-generated one, cancel it (manual wins)
                if (existingAuto) {
                    console.log(`[syncLeaveRecord] Cancelling competing auto-request: #${existingAuto.id}`);
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t, date, employee);
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, { approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED, status: 2 }, t);
                }
                if (!transaction) await t.commit();
                return null;
            }

            // --- Manage Auto-Generated Record ---

            // Round amount
            const roundedAmount = Math.round(amount * 10) / 10;

            // CASE A: Amount is 0 (Status changed away from Leave/HalfDay)
            if (roundedAmount === 0) {
                console.log(`[syncLeaveRecord] CASE A: Amount is 0`);
                if (existingAuto) {
                    console.log(`[syncLeaveRecord] Cancelling auto-request because amount is 0: #${existingAuto.id}`);
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t, date, employee);
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, { approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED, status: 2 }, t);
                } 
                
                if (manualRequest) {
                    console.log(`[syncLeaveRecord] Checking manual request cancellation rule for date ${date}...`);
                    // Check if category has an automation rule marking day as 'Present' (Status 0)
                    const category = await commonQuery.findOneRecord(LeaveTemplateCategory, manualRequest.leave_category_id, {}, t);
                    const rules = category?.automation_rules ? JSON.parse(category.automation_rules) : {};
                    const isForcedPresent = String(rules.auto_attendance_status) === "0"; 

                    if (!isForcedPresent) {
                        // If it's a single day manual request, cancel it
                        if (manualRequest.start_date === date && manualRequest.end_date === date) {
                            console.log(`[syncLeaveRecord] Cancelling single-day manual request: #${manualRequest.id}`);
                            await this.adjustLeaveBalance(employeeId, manualRequest.leave_category_id, -manualRequest.total_days, t, date, employee);
                            await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, { approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED }, t);
                        } else {
                            // Multi-day request: We can't easily "split" it, but we MUST refund the balance for this day.
                            console.log(`[syncLeaveRecord] Refunding 1 day from multi-day manual request: #${manualRequest.id}`);
                            // We determine deduction amount (usually 1.0 but could be 0.5 if it was a half day session? 
                            // Standardizing on 1.0 for now for simplification, or 0.5 if sessions indicate it.)
                            let refundAmount = 1.0;
                            if (manualRequest.start_date === date && manualRequest.start_session !== 0) refundAmount = 0.5;
                            else if (manualRequest.end_date === date && manualRequest.end_session !== 0) refundAmount = 0.5;

                            await this.adjustLeaveBalance(employeeId, manualRequest.leave_category_id, -refundAmount, t, date, employee);
                            
                            // Note: We keep the request but add a note or log it somewhere.
                            // In a future update, consider splitting the request into before/after segments.
                            await LeaveRequest.update({ 
                                note: (manualRequest.note || "") + ` [Day ${date} work-overridden: balance refunded]` 
                            }, { where: { id: manualRequest.id }, transaction: t });
                        }
                    } else {
                        console.log(`[syncLeaveRecord] Manual request preserved due to 'Forced Present' rule.`);
                    }
                }
            }
            // CASE B: Category or Amount Changed for existing auto-request
            else if (existingAuto) {
                console.log(`[syncLeaveRecord] CASE B: Existing auto-request found: #${existingAuto.id}`);
                if (existingAuto.leave_category_id !== categoryId || parseFloat(existingAuto.total_days || 0) !== roundedAmount) {
                    console.log(`[syncLeaveRecord] Updating auto-request category or days.`);
                    // Refund OLD
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t, date, employee);
                    // Deduct NEW
                    await this.adjustLeaveBalance(employeeId, categoryId, roundedAmount, t, date, employee);
                    // Update Request
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, {
                        leave_category_id: categoryId,
                        total_days: roundedAmount,
                        approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                        request_type: 'DEBIT'
                    }, t);
                } else {
                    console.log(`[syncLeaveRecord] No changes needed for existing auto-request.`);
                }
            } 
            // CASE C: No existing auto-request, create one
            else {
                console.log(`[syncLeaveRecord] CASE C: Creating new auto-request.`);
                // Deduct Balance
                await this.adjustLeaveBalance(employeeId, categoryId, roundedAmount, t, date, employee);
                
                // Fetch basic employee/company info for the record
                const emp = employee || await commonQuery.findOneRecord(Employee, employeeId, {
                    attributes: ['company_id', 'branch_id']
                }, t);

                // Create Request
                await commonQuery.createRecord(LeaveRequest, {
                    employee_id: employeeId,
                    leave_category_id: categoryId,
                    start_date: date,
                    end_date: date,
                    total_days: roundedAmount,
                    request_type: 'DEBIT',
                    reason: AUTO_REASON,
                    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                    approved_by: 0, // System/Auto
                    company_id: emp?.company_id || 0,
                    branch_id: emp?.branch_id || 0,
                    user_id: 0,
                    status: 0
                }, t);
            }

            if (!transaction) await t.commit();
            return null;
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }
    /**
     * Calculates total leave days for a range, respecting sandwich policy.
     */
    static async calculateWorkingDays(employeeId, startDate, endDate, transaction = null) {
        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);
        
        if (!employee) return 0;
        
        const template = employee.leaveTemplate;
        const countSandwich = template ? template.count_sandwich_leaves : false;

        const start = dayjs(startDate);
        const end = dayjs(endDate);
        const calendarDays = end.diff(start, 'day') + 1;
        
        let workingDays = 0;
        for (let i = 0; i < calendarDays; i++) {
            const cur = start.add(i, 'day').format('YYYY-MM-DD');
            if (countSandwich) {
                workingDays += 1;
            } else {
                const { getDayOffInfo } = require("../helpers/attendanceHelper");
                const { isHoliday, isWeeklyOff } = await getDayOffInfo(employee, cur, transaction);
                if (!isHoliday && !isWeeklyOff) {
                    workingDays += 1;
                }
            }
        }
        return workingDays;
    }
}

module.exports = LeaveBalanceService;
