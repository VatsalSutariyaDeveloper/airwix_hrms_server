const { EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, LeaveRequest, AttendanceTemplate, EmployeeAttendanceTemplate, sequelize } = require("../models");
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
    /**
     * @param {string|Date} employeeJoiningDate
     * @param {string} cycleType
     * @param {dayjs.Dayjs|string|Date} referenceDate  - The date used to determine which cycle window is active
     * @param {{ leave_period_start?: string, leave_period_end?: string }} templatePeriod
     *        - When the template has explicit custom dates, pass them here so the cycle is computed correctly.
     *          The dates are rolled year-by-year to find the window that contains referenceDate.
     */
    static getCycleDates(employeeJoiningDate, cycleType, referenceDate = dayjs(), templatePeriod = {}) {
        const today = dayjs(referenceDate);
        let start, end;

        // --- Custom fixed-date range (leave_period_start + leave_period_end set on template) ---
        // Works for any cycle type when the admin has pinned explicit start/end dates.
        if (templatePeriod.leave_period_start && templatePeriod.leave_period_end) {
            const rawStart = dayjs(templatePeriod.leave_period_start);
            const rawEnd   = dayjs(templatePeriod.leave_period_end);

            // Determine the span (days) of one cycle window
            const spanDays = rawEnd.diff(rawStart, 'day') + 1; // inclusive

            // Roll the start date forward year by year until the window contains `today`
            let candidateStart = rawStart;
            let candidateEnd   = rawEnd;

            // If today is before the very first window, return that first window
            if (!today.isBefore(rawStart)) {
                // Advance until candidateEnd >= today
                while (candidateEnd.isBefore(today, 'day')) {
                    candidateStart = candidateStart.add(1, 'year');
                    candidateEnd   = candidateEnd.add(1, 'year');
                }
                // Confirm today is within [candidateStart, candidateEnd]
                if (today.isBefore(candidateStart, 'day')) {
                    // today fell in a gap — step back one year
                    candidateStart = candidateStart.subtract(1, 'year');
                    candidateEnd   = candidateEnd.subtract(1, 'year');
                }
            }

            return { start: candidateStart, end: candidateEnd };
        }

        if (cycleType === 'CALENDAR_YEAR') {
            start = today.startOf('year');
            end = today.endOf('year');
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
        } else {
            // Fallback: calendar year
            start = today.startOf('year');
            end = today.endOf('year');
        }
console.log("start",start,"end",end)
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

        const ruleNormalized = String(rule || 'THRESHOLD_BASED').toUpperCase().replace(/ /g, '_');
        if (ruleNormalized === 'THRESHOLD_BASED') {
            if (day <= 7) joinMonthCredit = monthlyRate;
            else if (day <= 22) joinMonthCredit = monthlyRate / 2;
            else joinMonthCredit = 0;
        } else if (ruleNormalized === 'FULL_MONTH') {
            joinMonthCredit = monthlyRate;
        } else if (ruleNormalized === 'PRO_RATA_DAYS') {
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
    static async initializeBalance(employeeId, templateId, transaction = null, preFetchedEmployee = null, preFetchedTemplate = null, asOf = null, options = {}, oldBalancesMap = null) {
        const { allowRollover = false } = options;
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = preFetchedEmployee || await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
            if (!employee) throw new Error("Employee not found");

            const template = preFetchedTemplate || await commonQuery.findOneRecord(LeaveTemplate, templateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t, true);

            if (!template) throw new Error("Leave template not found or inactive");

            // --- [MOD] Dynamic Comp-Off Logic based on Attendance Policy ---
            // Fetch attendance template to check holiday policy
            const attendanceTemplate = await commonQuery.findOneRecord(EmployeeAttendanceTemplate, { employee_id: employeeId }, {}, t, true);
            const isCompOffPolicy = attendanceTemplate && attendanceTemplate.holiday_policy === 'COMP_OFF';
            
            // Filter and manage categories
            let categories = [...(template.categories || [])];
            if (isCompOffPolicy) {
                // If policy is COMP_OFF, ensure a Comp-Off category exists in the list
                if (!categories.some(c => c.is_compoff)) {
                    const masterCompOff = await commonQuery.findOneRecord(LeaveTemplateCategory, { is_compoff: true, status: 0 }, {}, t, false, false);
                    if (masterCompOff) categories.push(masterCompOff);
                }
            } else {
                // If policy is NOT COMP_OFF, exclude Comp-Off category and soft-delete existing Comp-Off balances
                categories = categories.filter(c => !c.is_compoff);
                
                await commonQuery.hardDeleteRecords(EmployeeLeaveBalance, 
                    { 
                        employee_id: employeeId, 
                        is_compoff: true,
                        status: { [Op.in]: [0, 1] }
                    }, t );
            }

            const refDate = asOf ? dayjs(asOf) : dayjs();
            const { start, end } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle, refDate, {
                leave_period_start: template.leave_period_start,
                leave_period_end: template.leave_period_end
            });
            const results = [];

            for (const category of categories) {
                let allocated = 0;

                const accrualTypeNormalized = String(template.accrual_type || '').toUpperCase();

                if (accrualTypeNormalized === 'UPFRONT') {
                    const today = refDate;
                    const joinDate = dayjs(employee.joining_date);

                    // Use the later of today or joining date as the effective start for pro-rata.
                    // - If joining date is in the future, we pro-rate from that future date.
                    // - If already joined, we pro-rate from today (mid-cycle template application).
                    // - Full allocation only if the effective date is at or before the cycle start.
                    const effectiveFrom = joinDate.isAfter(today) ? joinDate : today;

                    if (effectiveFrom.isAfter(start)) {
                        // Pro-rata: calculate based on remaining months in cycle
                        let annualTotal = category.leave_count;
                        if (template.leave_policy_cycle === 'MONTHLY') {
                            annualTotal = category.leave_count * 12;
                        } else if (template.leave_policy_cycle === 'QUARTERLY') {
                            annualTotal = category.leave_count * 4;
                        }
                        allocated = this.calculateProRata(effectiveFrom.toDate(), annualTotal, end, template.join_month_rule);
                    } else {
                        // Full allocation: template applied at or before cycle start
                        allocated = category.leave_count;
                    }
                } else if (accrualTypeNormalized === 'MONTHLY') {

                    const today = refDate;
                    const joinDate = dayjs(employee.joining_date);
                    
                    let totalEarned = 0;
                    let currentPointer = start.startOf('month');
                    if (joinDate.isAfter(currentPointer)) {
                        currentPointer = joinDate.startOf('month');
                    }

                    const lastEarnedMonth = today.subtract(1, 'month').startOf('month');
                    // const lastEarnedMonth = today.startOf('month');

                    let monthlyRate = category.leave_count / 12;

                    if (template.leave_policy_cycle === 'MONTHLY') {
                        monthlyRate = category.leave_count;
                    } else if (template.leave_policy_cycle === 'QUARTERLY') {
                        monthlyRate = category.leave_count / 3;
                    }

                    console.log("----- MONTHLY ACCRUAL DEBUG -----");
                    console.log("Employee:", employeeId);
                    console.log("Category:", category.leave_category_name);
                    console.log("Start:", start.format('MMM YYYY'));
                    console.log("Today:", today.format('MMM YYYY'));
                    console.log("Join Date:", joinDate.format('DD MMM YYYY'));
                    console.log("Pointer Start:", currentPointer.format('MMM YYYY'));
                    console.log("Last Earned Month:", lastEarnedMonth.format('MMM YYYY'));
                    console.log("Monthly Rate:", monthlyRate);

                    while (!currentPointer.isAfter(lastEarnedMonth)) {

                        console.log(`👉 Processing: ${currentPointer.format('MMM YYYY')}`);

                        // Skip if not joined yet
                        if (joinDate.isAfter(currentPointer.endOf('month'))) {
                            console.log("⛔ Not joined yet, skipping");
                            currentPointer = currentPointer.add(1, 'month');
                            continue;
                        }

                        let monthCredit = 0;

                        // 👉 JOIN MONTH LOGIC
                        if (joinDate.isSame(currentPointer, 'month')) {

                            const joinDay = joinDate.date();
                            const ruleNormalized = String(template.join_month_rule || 'THRESHOLD_BASED')
                                .toUpperCase()
                                .replace(/ /g, '_');

                            console.log("Join Month Rule:", ruleNormalized);

                            if (ruleNormalized === 'THRESHOLD_BASED') {

                                if (joinDay <= 7) {
                                    monthCredit = monthlyRate;
                                } else if (joinDay <= 22) {
                                    monthCredit = monthlyRate / 2;
                                } else {
                                    monthCredit = 0;
                                }

                            } else if (ruleNormalized === 'FULL_MONTH') {

                                monthCredit = monthlyRate;

                            } else if (ruleNormalized === 'PRO_RATA_DAYS') {

                                const daysInMonth = currentPointer.daysInMonth();
                                const daysRemaining = daysInMonth - joinDay + 1;

                                monthCredit = (daysRemaining / daysInMonth) * monthlyRate;
                            }

                            console.log(`🟡 Join Month Credit: ${monthCredit}`);

                        } else {
                            // 👉 FULL MONTH CREDIT
                            monthCredit = monthlyRate;
                            console.log(`🟢 Full Month Credit: ${monthCredit}`);
                        }

                        totalEarned += monthCredit;

                        currentPointer = currentPointer.add(1, 'month');
                    }

                    console.log("✅ Total Earned:", totalEarned);

                    allocated = totalEarned;
                }
                // Apply Rounding to Allocation
                allocated = Math.round(allocated * 2) / 2;

                // Metadata to store from template category
                const metaFields = {
                    leave_category_name: category.leave_category_name,
                    unused_leave_rule: category.unused_leave_rule,
                    carry_forward_limit: parseFloat(category.carry_forward_limit || 0),
                    is_paid: category.is_paid,
                    is_compoff: category.is_compoff,
                    automation_rules: category.automation_rules,
                };

                const currentYear = end.year();
                const currentMonth = (template.leave_policy_cycle === 'MONTHLY' || template.leave_policy_cycle === 'QUARTERLY') ? end.month() + 1 : null;

                // 1. Fetch any EXISTING balance for the TARGET cycle (Sync check)
                const targetBalance = await EmployeeLeaveBalance.findOne({
                    where: {
                        employee_id: employeeId,
                        leave_category_id: category.id,
                        year: currentYear,
                        month: currentMonth,
                        status: 0 // Only sync with active records
                    },
                    transaction: t
                });

                // 2. Fetch the LATEST previous balance for ROLLOVER (Source check)
                let carryForward = 0;
                let used = 0;

                if (allowRollover) {
                    const lastBalance = await EmployeeLeaveBalance.findOne({
                        where: {
                            employee_id: employeeId,
                            leave_category_id: category.id,
                            status: { [Op.in]: [0, 1] } // Include processed records for rollover
                        },
                        order: [['id', 'DESC']],
                        transaction: t
                    });

                    if (lastBalance) {
                        const isSameCycle = lastBalance.year === currentYear && 
                                           (currentMonth === null || lastBalance.month === currentMonth);

                        if (isSameCycle) {
                            carryForward = parseFloat(lastBalance.carry_forward_leaves || 0);
                            used = parseFloat(lastBalance.used_leaves || 0);
                        } else {
                            // Rollover calculation from previous cycle
                            const remaining = parseFloat(lastBalance.pending_leaves || 0);
                            if (category.unused_leave_rule === 'CARRY_FORWARD') {
                                const limit = parseFloat(category.carry_forward_limit || 0);
                                carryForward = Math.min(remaining, limit);
                            }
                            used = 0; // New cycle starts with 0 used
                        }
                    }
                } else if (targetBalance) {
                    // Syncing with existing active balance without rollover
                    carryForward = parseFloat(targetBalance.carry_forward_leaves || 0);
                    used = parseFloat(targetBalance.used_leaves || 0);
                } else if (oldBalancesMap) {
                    // When old balances were soft-deleted before this call (template update flow),
                    // use the preserved usage data so employees don't get extra leaves
                    const oldBal = oldBalancesMap.get(category.id);
                    if (oldBal) {
                        used = parseFloat(oldBal.used_leaves || 0);
                        carryForward = parseFloat(oldBal.carry_forward_leaves || 0);
                    }
                }
console.log("allocated",allocated,"carryForward",carryForward,"used",used)
                let totalAllowance = Math.round((allocated + carryForward) * 2) / 2;
                let pending = Math.round((totalAllowance - used) * 2) / 2;

                // Ensure unpaid leaves or zero-allocation categories don't show negative pending leaves
                if ((!category.is_paid && !category.is_compoff) || pending < 0) {
                    pending = Math.max(0, pending);
                }

                let balance;
                if (targetBalance) {
                    // Scenario A: Syncing existing active cycle balance
                    balance = await commonQuery.updateRecordById(EmployeeLeaveBalance, targetBalance.id, {
                        ...metaFields,
                        total_allocated: totalAllowance,
                        carry_forward_leaves: carryForward,
                        used_leaves: used,
                        pending_leaves: pending,
                        leave_template_id: templateId,
                        // year and month are already correct on targetBalance
                    }, t);
                } else {
                    // Scenario B: Creating a NEW cycle balance (even if status 1 records exist elsewhere)
                    balance = await commonQuery.createRecord(EmployeeLeaveBalance, {
                        ...metaFields,
                        employee_id: employeeId,
                        leave_category_id: category.id,
                        year: currentYear,
                        month: currentMonth,
                        leave_template_id: templateId,
                        total_allocated: totalAllowance,
                        carry_forward_leaves: carryForward,
                        used_leaves: used,
                        pending_leaves: pending,
                        company_id: employee.company_id,
                        status: 0 // New records are always active
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
     * Strategy: Capture used leaves → DELETE all existing balances → create fresh from new template with old usage preserved.
     */
    static async syncEmployeeBalances(employeeId, newTemplateId, transaction = null, preFetchedEmployee = null, preFetchedTemplate = null) {
        const t = transaction || (await sequelize.transaction());
        try {
            const employee = preFetchedEmployee || await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
            if (!employee) throw new Error("Employee not found");

            // Step 1: Capture old balance usage data BEFORE soft-deleting
            const oldBalances = await EmployeeLeaveBalance.findAll({
                where: { employee_id: employeeId, status: { [Op.in]: [0, 1] } },
                transaction: t
            });
            const oldBalancesMap = new Map();
            for (const bal of oldBalances) {
                oldBalancesMap.set(bal.leave_category_id, {
                    used_leaves: bal.used_leaves,
                    carry_forward_leaves: bal.carry_forward_leaves
                });
            }

            // Step 2: Soft-delete ALL existing leave balances for this employee
            await EmployeeLeaveBalance.update(
                { status: 2 },
                { where: { employee_id: employeeId, status: { [Op.in]: [0, 1] } }, transaction: t }
            );

            // If no new template assigned, we're done (just clearing)
            if (!newTemplateId) {
                if (!transaction) await t.commit();
                return [];
            }

            const newTemplate = preFetchedTemplate || await commonQuery.findOneRecord(LeaveTemplate, newTemplateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t);

            if (!newTemplate) throw new Error("New leave template not found");

            // Step 3: Create fresh balances from the new template, passing old usage data
            const results = await this.initializeBalance(employeeId, newTemplateId, t, employee, newTemplate, null, {}, oldBalancesMap);

            if (!transaction) await t.commit();
            return results;
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Optimized bulk synchronization of leave balances.
     * Strategy: Capture used leaves → DELETE all existing balances → create fresh from new template with old usage preserved.
     */
    static async bulkSyncEmployeeBalances(employeeIds, newTemplateId, transaction = null, meta = {}) {
        if (!Array.isArray(employeeIds) || employeeIds.length === 0) return;

        const t = transaction || (await sequelize.transaction());
        try {
            // Step 1: Capture old balance usage data BEFORE soft-deleting
            // Build a map: employeeId -> Map(categoryId -> { used_leaves, carry_forward_leaves })
            const allOldBalances = await EmployeeLeaveBalance.findAll({
                where: { employee_id: { [Op.in]: employeeIds }, status: { [Op.in]: [0, 1] } },
                transaction: t
            });
            const employeeOldBalancesMap = new Map();
            for (const bal of allOldBalances) {
                if (!employeeOldBalancesMap.has(bal.employee_id)) {
                    employeeOldBalancesMap.set(bal.employee_id, new Map());
                }
                employeeOldBalancesMap.get(bal.employee_id).set(bal.leave_category_id, {
                    used_leaves: bal.used_leaves,
                    carry_forward_leaves: bal.carry_forward_leaves
                });
            }

            // Step 2: Soft-delete ALL existing leave balances for these employees
            await EmployeeLeaveBalance.update(
                { status: 2 },
                { where: { employee_id: { [Op.in]: employeeIds }, status: { [Op.in]: [0, 1] } }, transaction: t }
            );

            // If no new template, we're done (just clearing)
            if (!newTemplateId) {
                if (!transaction) await t.commit();
                return;
            }

            const template = meta.preFetchedMaster || await commonQuery.findOneRecord(LeaveTemplate, newTemplateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t);
            if (!template) throw new Error("Leave template not found");

            // Step 3: Create fresh balances in chunks, passing old usage data per employee
            const chunkSize = 50;
            for (let i = 0; i < employeeIds.length; i += chunkSize) {
                const chunk = employeeIds.slice(i, i + chunkSize);
                const employees = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: chunk } }, {}, t);

                for (const emp of employees) {
                    const oldBalancesMap = employeeOldBalancesMap.get(emp.id) || null;
                    await this.initializeBalance(emp.id, newTemplateId, t, emp, template, null, {}, oldBalancesMap);
                }
            }

            if (!transaction) await t.commit();
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Syncs ONLY the Comp-Off leave category for employees.
     * Use this when updating attendance templates to avoid resetting other leave balances.
     */
    static async syncCompOffOnly(employeeIds, transaction = null) {
        if (!Array.isArray(employeeIds) || employeeIds.length === 0) return;

        const t = transaction || (await sequelize.transaction());
        try {
            const masterCompOff = await commonQuery.findOneRecord(LeaveTemplateCategory, { is_compoff: true, status: 0 }, {}, t);
            if (!masterCompOff) return;

            const employees = await commonQuery.findAllRecords(Employee, { 
                id: { [Op.in]: employeeIds },
                leave_template: { [Op.ne]: null }
            }, {}, t);
            
            for (const emp of employees) {
                if (!emp.leave_template) continue;

                // Check attendance policy
                const attendanceTemplate = await commonQuery.findOneRecord(EmployeeAttendanceTemplate, { employee_id: emp.id }, {}, t);
                const isCompOffPolicy = attendanceTemplate && (attendanceTemplate.holiday_policy === 'COMP_OFF' || attendanceTemplate.weekly_off_policy === 'COMP_OFF');

                if (isCompOffPolicy) {
                    const leaveTemplate = await commonQuery.findOneRecord(LeaveTemplate, emp.leave_template, {}, t);
                    if (!leaveTemplate) continue;

                    const refDate = dayjs();
                    const { end } = this.getCycleDates(emp.joining_date, leaveTemplate.leave_policy_cycle, refDate, {
                        leave_period_start: leaveTemplate.leave_period_start,
                        leave_period_end: leaveTemplate.leave_period_end
                    });

                    const currentYear = end.year();
                    const currentMonth = (leaveTemplate.leave_policy_cycle === 'MONTHLY' || leaveTemplate.leave_policy_cycle === 'QUARTERLY') ? end.month() + 1 : null;

                    const existing = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
                        employee_id: emp.id,
                        leave_category_id: masterCompOff.id,
                        year: currentYear,
                        month: currentMonth,
                        status: 0
                    }, {}, t);

                    if (!existing) {
                        await commonQuery.createRecord(EmployeeLeaveBalance, {
                            employee_id: emp.id,
                            leave_category_id: masterCompOff.id,
                            leave_category_name: masterCompOff.leave_category_name,
                            unused_leave_rule: masterCompOff.unused_leave_rule,
                            carry_forward_limit: masterCompOff.carry_forward_limit,
                            is_paid: masterCompOff.is_paid,
                            is_compoff: true,
                            automation_rules: masterCompOff.automation_rules,
                            year: currentYear,
                            month: currentMonth,
                            leave_template_id: emp.leave_template,
                            total_allocated: 0,
                            carry_forward_leaves: 0,
                            used_leaves: 0,
                            pending_leaves: 0,
                            company_id: emp.company_id,
                            status: 0
                        }, t);
                    }
                } else {
                    // Remove comp-off balance if policy changed and category is NOT in the main leave template
                    // (Safety check so we don't accidentally delete if it's explicitly part of their leave template)
                    const isExplicitInTemplate = await commonQuery.findOneRecord(LeaveTemplateCategory, { leave_template_id: emp.leave_template, is_compoff: true, status: 0 }, {}, t);

                    if (!isExplicitInTemplate) {
                        await commonQuery.hardDeleteRecords(EmployeeLeaveBalance, {
                            employee_id: emp.id,
                            is_compoff: true,
                            status: { [Op.in]: [0, 1] }
                        }, t);
                    }
                }
            }

            if (!transaction) await t.commit();
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            console.error("❌ Error syncCompOffOnly:", error);
            throw error;
        }
    }

    /**
     * Batch job to add monthly credits.
     */
    static async processMonthlyAccruals(asOf = null) {
        const refDate = asOf ? dayjs(asOf) : dayjs();

        // Guard: Monthly accruals strictly run on the 1st of the month.
        if (!asOf && refDate.date() !== 1) {
            return;
        }

        console.log('⏰ Running monthly leave accrual task...');
        // Logic: On the 1st of Month N, we credit for Month N-1 (the month just completed).
        const calculationDate = refDate.subtract(1, 'day'); 
        
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
                    const joinDate = dayjs(employee.joining_date);

                    // Skip if employee joined AFTER the month we are crediting
                    if (joinDate.isAfter(calculationDate.endOf('month'))) {
                        continue;
                    }

                    const { start, end } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle, calculationDate, {
                        leave_period_start: template.leave_period_start,
                        leave_period_end: template.leave_period_end
                    });
                    
                    for (const category of template.categories) {
                        let monthlyRate = category.leave_count / 12; // Default for annual cycles
                        if (template.leave_policy_cycle === 'MONTHLY') {
                            monthlyRate = category.leave_count;
                        } else if (template.leave_policy_cycle === 'QUARTERLY') {
                            monthlyRate = category.leave_count / 3;
                        }

                        let creditToApply = 0;
                        if (joinDate.isSame(calculationDate, 'month')) {
                            // Apply join month rule if this was their first month
                            const joinDay = joinDate.date();
                            const ruleNormalized = String(template.join_month_rule || 'THRESHOLD_BASED').toUpperCase().replace(/ /g, '_');
                            if (ruleNormalized === 'THRESHOLD_BASED') {
                                if (joinDay <= 7) creditToApply = monthlyRate;
                                else if (joinDay <= 22) creditToApply = monthlyRate / 2;
                                else creditToApply = 0;
                            } else if (ruleNormalized === 'FULL_MONTH') {
                                creditToApply = monthlyRate;
                            } else if (ruleNormalized === 'PRO_RATA_DAYS') {
                                const daysInMonth = joinDate.daysInMonth();
                                const daysRemaining = daysInMonth - joinDay + 1;
                                creditToApply = (daysRemaining / daysInMonth) * monthlyRate;
                            }
                        } else {
                            // Full month earned
                            creditToApply = monthlyRate;
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
                            // Guard: If it was already updated today (the 1st), skip to prevent double-crediting
                            // if initializeBalance already ran for this employee today.
                            const wasUpdatedToday = dayjs(balance.updated_at).isSame(refDate, 'day');
                            if (wasUpdatedToday && !asOf) {
                                console.log(`[Accrual Sync] Skipping emp ${employee.id} cat ${category.id} - already updated today.`);
                                continue;
                            }

                            const newTotal = Math.round((parseFloat(balance.total_allocated || 0) + creditToApply) * 2) / 2;
                            const newPending = Math.round((parseFloat(balance.pending_leaves || 0) + creditToApply) * 2) / 2;
                            
                            await EmployeeLeaveBalance.update({
                                total_allocated: newTotal,
                                pending_leaves: newPending
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
    static async processYearEndReset(asOf = null) {
        const transaction = await sequelize.transaction();
        try {
            const today = asOf ? dayjs(asOf) : dayjs();
            const employees = await Employee.findAll({
                where: {
                    status: 0,
                    leave_template: { 
                        [Op.and]: [
                            { [Op.ne]: null },
                            { [Op.ne]: 0 }
                        ]
                    }
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

            let resetCount = 0;
            // console.log(`[Year-End] Total Active Employees Found: ${employees.length}`);

            for (const employee of employees) {
                const template = employee.leaveTemplate;
                if (!template) continue;

                const yesterday = today.subtract(1, 'day');
                const { end: lastCycleEnd } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle, yesterday, {
                    leave_period_start: template.leave_period_start,
                    leave_period_end: template.leave_period_end
                });
                
                console.log(`[Year-End Log] Checking Emp ${employee.id} (${employee.first_name}): Cycle ${template.leave_policy_cycle}, Yesterday ${yesterday.format('YYYY-MM-DD')}, Last Cycle End ${lastCycleEnd.format('YYYY-MM-DD')}`);

                if (!yesterday.isSame(lastCycleEnd, 'day')) {
                    console.log(`[Year-End Log] Skipping Emp ${employee.id}: Not at cycle end.`);
                    continue;
                }

                console.log(`[Year-End Log] >>> Reset Triggered for Emp ${employee.id}! <<<`);

                const lastYear = lastCycleEnd.year();
                const lastMonth = (template.leave_policy_cycle === 'MONTHLY' || template.leave_policy_cycle === 'QUARTERLY') ? lastCycleEnd.month() + 1 : null;

                console.log(`[Year-End Log] >>> Reset Triggered for Emp ${employee.id}! <<<`);

                // 1. Mark ALL active balances for the cycle that just ended as processed (status 1)
                // This correctly includes dynamic categories like Comp-Off that aren't in the template
                const [updatedCount] = await EmployeeLeaveBalance.update({ status: 1 }, {
                    where: {
                        employee_id: employee.id,
                        year: lastYear,
                        month: lastMonth,
                        status: 0
                    },
                    transaction
                });

                if (updatedCount > 0) {
                    console.log(`[Year-End Log] Marked ${updatedCount} balances as processed for Emp ${employee.id} (Year: ${lastYear}${lastMonth ? ` Month: ${lastMonth}` : ''}).`);
                }

                // 2. Initialize NEW balance for the next cycle
                // Passing allowRollover: true will cause initializeBalance to correctly carry over 
                // the remaining leaves from the now-processed (status 1) balances.
                console.log(`[Year-End Log] Initializing fresh balance for next cycle...`);
                await this.initializeBalance(employee.id, template.id, transaction, employee, template, today.toDate(), { allowRollover: true });
                resetCount++;
                console.log(`[Year-End Log] ✅ Reset Complete for Employee ${employee.id}`);
            }

            if (resetCount > 0) {
                console.log(`⏰ [Year-End Reset] Processed resets for ${resetCount} employees.`);
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
            const { end } = this.getCycleDates(emp.joining_date, template ? template.leave_policy_cycle : 'CALENDAR_YEAR', date, {
                leave_period_start: template?.leave_period_start,
                leave_period_end: template?.leave_period_end
            });
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
