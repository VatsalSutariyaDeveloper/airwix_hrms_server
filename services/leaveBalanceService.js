const { EmployeeLeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, LeaveRequest, AttendanceTemplate, EmployeeAttendanceTemplate, AttendanceDay, sequelize } = require("../models");
const { commonQuery, Op, Err } = require("../helpers");
const { constants } = require("../helpers/constants");
const dayjs = require("dayjs");
// const { getDayOffInfo } = require("../helpers/attendanceHelper");

/**
 * Helper to get frequency in months for periodic accrual
 */
const getFrequencyMonths = (freq) => {
    switch (freq) {
        case 'monthly': return 1;
        case 'quarterly': return 3;
        case '4_monthly': return 4;
        case 'half_yearly': return 6;
        case 'yearly': return 12;
        default: return 1;
    }
};

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
            const rawEnd = dayjs(templatePeriod.leave_period_end);

            // Determine the span (days) of one cycle window
            const spanDays = rawEnd.diff(rawStart, 'day') + 1; // inclusive

            // Roll the start date forward year by year until the window contains `today`
            let candidateStart = rawStart;
            let candidateEnd = rawEnd;

            // If today is before the very first window, return that first window
            if (!today.isBefore(rawStart)) {
                // Advance until candidateEnd >= today
                while (candidateEnd.isBefore(today, 'day')) {
                    candidateStart = candidateStart.add(1, 'year');
                    candidateEnd = candidateEnd.add(1, 'year');
                }
                // Confirm today is within [candidateStart, candidateEnd]
                if (today.isBefore(candidateStart, 'day')) {
                    // today fell in a gap — step back one year
                    candidateStart = candidateStart.subtract(1, 'year');
                    candidateEnd = candidateEnd.subtract(1, 'year');
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
        console.log("start", start, "end", end)
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
    static async initializeBalance(employeeId, templateId, transaction = null, preFetchedEmployee = null, preFetchedTemplate = null, asOf = null, options = {}, oldBalancesMap = null, meta = {}) {
        const { allowRollover = false } = options;
        const t = transaction || (await sequelize.transaction());
        try {
            let employee = preFetchedEmployee || await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
            if (!employee) throw new Error("Employee not found");

            if (!employee.joining_date) {
                const freshEmployee = await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
                if (freshEmployee) {
                    employee = freshEmployee;
                }
            }

            const template = preFetchedTemplate || await commonQuery.findOneRecord(LeaveTemplate, templateId, {
                include: [{ model: LeaveTemplateCategory, as: "categories", where: { status: 0 } }]
            }, t, true);

            if (!template) throw new Error("Leave template not found or inactive");

            if (template.leave_policy_cycle === 'SERVICE_YEAR' && !employee.joining_date) {
                const validationError = new Err("You need to Add Joining Date to Assign this template");
                validationError.message = { joining_date: "You need to Add Joining Date to Assign this template" };
                throw validationError;
            }

            // --- [MOD] Dynamic Comp-Off Leave Logic based on Attendance Policy ---
            // Fetch attendance template to check holiday policy
            const attendanceTemplate = await commonQuery.findOneRecord(EmployeeAttendanceTemplate, { employee_id: employeeId }, {}, t, true);
            const isCompOffPolicy = attendanceTemplate && attendanceTemplate.holiday_policy === 'COMP_OFF';

            // Filter and manage categories
            let categories = [...(template.categories || [])];
            if (isCompOffPolicy) {
                // If policy is COMP_OFF, ensure a Comp-Off Leave category exists in the list
                if (!categories.some(c => c.is_compoff)) {
                    const masterCompOff = await commonQuery.findOneRecord(LeaveTemplateCategory, { is_compoff: true, status: 0 }, {}, t, false, false);
                    if (masterCompOff) categories.push(masterCompOff);
                }
            } else {
                // If policy is NOT COMP_OFF, exclude Comp-Off Leave category and soft-delete existing Comp-Off Leave balances
                categories = categories.filter(c => !c.is_compoff);

                await commonQuery.hardDeleteRecords(EmployeeLeaveBalance,
                    {
                        employee_id: employeeId,
                        is_compoff: true,
                        status: { [Op.in]: [0, 1] }
                    }, t);
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

                // Parse category automation rules for custom earning/accrual config
                let earningRules = null;
                try {
                    const parsedRules = category.automation_rules ? JSON.parse(category.automation_rules) : {};
                    if (parsedRules && parsedRules.earning_rules) {
                        earningRules = parsedRules.earning_rules;
                    }
                } catch (err) {
                    console.error(`[initializeBalance] Error parsing automation rules for category ${category.id}:`, err);
                }

                if (earningRules && earningRules.accrual_type === 'attendance_based') {
                    // Attendance-based periodic earning (e.g. Y leaves per X days worked in previous period)
                    const today = refDate;
                    const joinDate = dayjs(employee.joining_date);
                    const freqInMonths = getFrequencyMonths(earningRules.frequency || 'yearly');

                    let totalEarned = 0;
                    let anchorStart = start;
                    if (template.leave_policy_cycle === 'MONTHLY' && freqInMonths > 1) {
                        anchorStart = refDate.startOf('year');
                    }

                    let currentPointer = anchorStart.startOf('month');
                    if (joinDate.isAfter(currentPointer)) {
                        currentPointer = joinDate.startOf('month');
                    }

                    const lastEarnedMonth = today.startOf('month');
                    const isCycleStart = today.isSame(anchorStart, 'day') || today.isBefore(anchorStart);

                    if (isCycleStart) {
                        const monthsDiff = today.diff(anchorStart.startOf('month'), 'month');
                        if (monthsDiff % freqInMonths === 0) {
                            const queryStart = anchorStart.subtract(freqInMonths, 'month');
                            const queryEnd = anchorStart.subtract(1, 'day');

                            const attendanceRecords = await AttendanceDay.findAll({
                                where: {
                                    employee_id: employeeId,
                                    attendance_date: {
                                        [Op.between]: [queryStart.format('YYYY-MM-DD'), queryEnd.format('YYYY-MM-DD')]
                                    }
                                },
                                transaction: t
                            });

                            let totalPresentDays = 0;
                            for (const record of attendanceRecords) {
                                const statusVal = parseInt(record.status, 10);
                                if ([0, 7, 12].includes(statusVal)) {
                                    totalPresentDays += 1.0;
                                } else if ([1, 13].includes(statusVal)) {
                                    totalPresentDays += 0.5;
                                }
                            }

                            const reqDays = parseFloat(earningRules.earning_ratio_present_days || 365) || 365;
                            const earnLeaves = parseFloat(earningRules.earning_ratio_leave_value || 21);
                            let computedAllocated = (totalPresentDays / reqDays) * earnLeaves;

                            if (earningRules.max_earning_limit) {
                                const maxLimit = parseFloat(earningRules.max_earning_limit);
                                if (computedAllocated > maxLimit) {
                                    computedAllocated = maxLimit;
                                }
                            }
                            totalEarned = computedAllocated;
                        }
                    } else {
                        while (!currentPointer.isAfter(lastEarnedMonth)) {
                            if (joinDate.isAfter(currentPointer.endOf('month'))) {
                                currentPointer = currentPointer.add(1, 'month');
                                continue;
                            }

                            const monthsDiff = currentPointer.diff(anchorStart.startOf('month'), 'month');
                            if (monthsDiff % freqInMonths === 0) {
                                const queryStart = currentPointer.subtract(freqInMonths, 'month');
                                const queryEnd = currentPointer.subtract(1, 'day');

                                const attendanceRecords = await AttendanceDay.findAll({
                                    where: {
                                        employee_id: employeeId,
                                        attendance_date: {
                                            [Op.between]: [queryStart.format('YYYY-MM-DD'), queryEnd.format('YYYY-MM-DD')]
                                        }
                                    },
                                    transaction: t
                                });

                                let totalPresentDays = 0;
                                for (const record of attendanceRecords) {
                                    const statusVal = parseInt(record.status, 10);
                                    if ([0, 7, 12].includes(statusVal)) {
                                        totalPresentDays += 1.0;
                                    } else if ([1, 13].includes(statusVal)) {
                                        totalPresentDays += 0.5;
                                    }
                                }

                                const reqDays = parseFloat(earningRules.earning_ratio_present_days || 365) || 365;
                                const earnLeaves = parseFloat(earningRules.earning_ratio_leave_value || 21);
                                let periodCredit = (totalPresentDays / reqDays) * earnLeaves;

                                if (earningRules.max_earning_limit) {
                                    const maxLimit = parseFloat(earningRules.max_earning_limit);
                                    if (totalEarned + periodCredit > maxLimit) {
                                        periodCredit = Math.max(0, maxLimit - totalEarned);
                                    }
                                }
                                totalEarned += periodCredit;
                            }
                            currentPointer = currentPointer.add(1, 'month');
                        }
                    }
                    allocated = totalEarned;
                } else if (earningRules && earningRules.accrual_type === 'fixed') {
                    // Category-specific fixed periodic accrual (e.g., quarterly or every 4 months)
                    const today = refDate;
                    const joinDate = dayjs(employee.joining_date);
                    const freqInMonths = getFrequencyMonths(earningRules.frequency);

                    let totalEarned = 0;
                    let anchorStart = start;
                    if (template.leave_policy_cycle === 'MONTHLY' && freqInMonths > 1) {
                        anchorStart = refDate.startOf('year');
                    }

                    let currentPointer = anchorStart.startOf('month');
                    if (joinDate.isAfter(currentPointer)) {
                        currentPointer = joinDate.startOf('month');
                    }

                    const lastEarnedMonth = today.startOf('month');

                    while (!currentPointer.isAfter(lastEarnedMonth)) {
                        if (joinDate.isAfter(currentPointer.endOf('month'))) {
                            currentPointer = currentPointer.add(1, 'month');
                            continue;
                        }

                        const monthsDiff = currentPointer.diff(anchorStart.startOf('month'), 'month');
                        if (monthsDiff > 0 && monthsDiff % freqInMonths === 0) {
                            let credit = parseFloat(earningRules.credit_value || 0);

                            if (joinDate.isSame(currentPointer, 'month')) {
                                const joinDay = joinDate.date();
                                const ruleNormalized = String(template.join_month_rule || 'THRESHOLD_BASED')
                                    .toUpperCase()
                                    .replace(/ /g, '_');
                                if (ruleNormalized === 'THRESHOLD_BASED') {
                                    if (joinDay <= 7) credit = credit;
                                    else if (joinDay <= 22) credit = credit / 2;
                                    else credit = 0;
                                } else if (ruleNormalized === 'FULL_MONTH') {
                                    credit = credit;
                                } else if (ruleNormalized === 'PRO_RATA_DAYS') {
                                    const daysInMonth = currentPointer.daysInMonth();
                                    const daysRemaining = daysInMonth - joinDay + 1;
                                    credit = (daysRemaining / daysInMonth) * credit;
                                }
                            }
                            totalEarned += credit;
                        }
                        currentPointer = currentPointer.add(1, 'month');
                    }
                    allocated = totalEarned;

                } else if (accrualTypeNormalized === 'UPFRONT') {
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
                            } else if (category.unused_leave_rule === 'ENCASH' && remaining > 0) {
                                // Calculate previous cycle end date (the day before new cycle starts)
                                const prevCycleEnd = start.subtract(1, 'day').format('YYYY-MM-DD');

                                // Apply carry_forward_limit to encashment (excess lapses)
                                const limit = parseFloat(category.carry_forward_limit || 0);
                                const encashDays = limit > 0 ? Math.min(remaining, limit) : remaining;
                                const lapsedDays = remaining - encashDays;

                                // Check if encashment request already exists for this cycle
                                const existingEncashment = await commonQuery.findOneRecord(LeaveRequest, {
                                    employee_id: employeeId,
                                    leave_category_id: category.id,
                                    is_encashment: true,
                                    request_type: 'ENCASHMENT',
                                    start_date: prevCycleEnd,
                                }, {}, t);

                                if (!existingEncashment) {
                                    // Auto-create approved encashment request
                                    await commonQuery.createRecord(LeaveRequest, {
                                        employee_id: employeeId,
                                        leave_category_id: category.id,
                                        start_date: prevCycleEnd,
                                        end_date: prevCycleEnd,
                                        total_days: encashDays,
                                        reason: `Auto-generated: ${template.leave_policy_cycle} cycle end encashment${lapsedDays > 0 ? ` (${lapsedDays} days lapsed)` : ''}`,
                                        approval_status: constants.LEAVE_APPROVAL_STATUS.PENDING,
                                        current_level: 1,
                                        is_encashment: true,
                                        is_settled_encashment: false,
                                        request_type: 'ENCASHMENT',
                                    }, t);
                                    console.log(`[Year-End Encash] Created PENDING encashment request for Emp ${employeeId}, Category ${category.leave_category_name}, Days: ${encashDays}${lapsedDays > 0 ? ` (${lapsedDays} lapsed)` : ''}`);
                                }
                                carryForward = 0; // Encashed leaves are not carried forward
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
                    let oldBal = oldBalancesMap.get(category.id);
                    if (!oldBal && category.leave_category_name) {
                        const normName = category.leave_category_name.trim().toLowerCase();
                        oldBal = oldBalancesMap.get(normName);
                    }
                    if (oldBal) {
                        used = parseFloat(oldBal.used_leaves || 0);
                        carryForward = parseFloat(oldBal.carry_forward_leaves || 0);
                    }
                }
                console.log("allocated", allocated, "carryForward", carryForward, "used", used)
                let totalAllowance = Math.round((allocated + carryForward) * 2) / 2;

                // Smart update detection logic:
                if (oldBalancesMap && meta && meta.oldMasterCategoriesMap) {
                    let oldBal = oldBalancesMap.get(category.id);
                    let oldMasterCat = meta.oldMasterCategoriesMap.get(category.id);

                    if (!oldBal && category.leave_category_name) {
                        const normName = category.leave_category_name.trim().toLowerCase();
                        oldBal = oldBalancesMap.get(normName);
                    }

                    if (!oldMasterCat && category.leave_category_name && meta.oldMasterCategoriesMap) {
                        const normName = category.leave_category_name.trim().toLowerCase();
                        for (const [key, val] of meta.oldMasterCategoriesMap.entries()) {
                            if (val.leave_category_name && val.leave_category_name.trim().toLowerCase() === normName) {
                                oldMasterCat = val;
                                break;
                            }
                        }
                    }

                    if (oldBal && oldMasterCat) {
                        // Did the template's count change?
                        const countChanged = parseFloat(oldMasterCat.leave_count || 0) !== parseFloat(category.leave_count || 0);
                        if (!countChanged) {
                            // If it didn't change in the template, KEEP the employee's existing allocated amount!
                            totalAllowance = parseFloat(oldBal.total_allocated || 0);
                        }
                    }
                }

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
            let employee = preFetchedEmployee || await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
            if (!employee) throw new Error("Employee not found");

            if (!employee.joining_date) {
                const freshEmployee = await commonQuery.findOneRecord(Employee, employeeId, {}, t, true);
                if (freshEmployee) {
                    employee = freshEmployee;
                }
            }

            // Step 1: Capture old balance usage data BEFORE soft-deleting
            const oldBalances = await EmployeeLeaveBalance.findAll({
                where: { employee_id: employeeId, status: { [Op.in]: [0, 1] } },
                transaction: t
            });
            const oldBalancesMap = new Map();
            for (const bal of oldBalances) {
                const usage = {
                    used_leaves: bal.used_leaves,
                    carry_forward_leaves: bal.carry_forward_leaves
                };
                oldBalancesMap.set(bal.leave_category_id, usage);
                if (bal.leave_category_name) {
                    oldBalancesMap.set(bal.leave_category_name.trim().toLowerCase(), usage);
                }
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
                const oldMap = employeeOldBalancesMap.get(bal.employee_id);
                const usage = {
                    used_leaves: bal.used_leaves,
                    carry_forward_leaves: bal.carry_forward_leaves,
                    total_allocated: bal.total_allocated
                };
                oldMap.set(bal.leave_category_id, usage);
                if (bal.leave_category_name) {
                    oldMap.set(bal.leave_category_name.trim().toLowerCase(), usage);
                }
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
                    await this.initializeBalance(emp.id, newTemplateId, t, emp, template, null, {}, oldBalancesMap, meta);
                }
            }

            if (!transaction) await t.commit();
        } catch (error) {
            if (!transaction && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * Syncs ONLY the Comp-Off Leave leave category for employees.
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
                    const leaveTemplate = emp.leave_template ? await commonQuery.findOneRecord(LeaveTemplate, emp.leave_template, {}, t, false, {}) : null;
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
                    // Remove Comp-Off Leave balance if policy changed and category is NOT in the main leave template
                    // (Safety check so we don't accidentally delete if it's explicitly part of their leave template)
                    const isExplicitInTemplate = emp.leave_template ? await commonQuery.findOneRecord(LeaveTemplateCategory, { leave_template_id: emp.leave_template, is_compoff: true, status: 0 }, {}, t, false, {}) : null;

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
    static async processMonthlyAccruals(asOf = null, batch_id = null, isManual = false) {
        const refDate = asOf ? dayjs(asOf) : dayjs();

        // Guard: Monthly accruals strictly run on the 1st of the month, unless forced manually.
        if (!isManual && !asOf && refDate.date() !== 1) {
            console.log('ℹ️ Skipping monthly leave accrual: Not the 1st of the month.');
            return;
        }

        console.log('⏰ Running monthly leave accrual task...');
        // Logic: On the 1st of Month N, we credit for Month N-1 (the month just completed).
        const calculationDate = refDate.subtract(1, 'day');

        const transaction = await sequelize.transaction();
        try {
            const templates = await LeaveTemplate.findAll({
                where: {
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
                        // Parse automation rules for custom category level earning/accrual config
                        let earningRules = null;
                        try {
                            const parsedRules = category.automation_rules ? JSON.parse(category.automation_rules) : {};
                            if (parsedRules && parsedRules.earning_rules) {
                                earningRules = parsedRules.earning_rules;
                            }
                        } catch (err) {
                            console.error(`[processMonthlyAccruals] Error parsing automation rules for category ${category.id}:`, err);
                        }

                        let creditToApply = 0;
                        let shouldProcess = false;

                        if (earningRules && earningRules.accrual_type === 'fixed') {
                            // Category-specific fixed periodic accrual (e.g. quarterly or every 4 months)
                            const freqInMonths = getFrequencyMonths(earningRules.frequency);
                            const nextCycleMonth = calculationDate.add(1, 'day').startOf('month');

                            let anchorStart = start;
                            if (template.leave_policy_cycle === 'MONTHLY' && freqInMonths > 1) {
                                anchorStart = calculationDate.startOf('year');
                            }
                            const monthsDiff = nextCycleMonth.diff(anchorStart.startOf('month'), 'month');

                            if (monthsDiff > 0 && monthsDiff % freqInMonths === 0) {
                                shouldProcess = true;
                                let credit = parseFloat(earningRules.credit_value || 0);
                                if (joinDate.isSame(calculationDate, 'month')) {
                                    // Apply join month rule
                                    const joinDay = joinDate.date();
                                    const ruleNormalized = String(template.join_month_rule || 'THRESHOLD_BASED').toUpperCase().replace(/ /g, '_');
                                    if (ruleNormalized === 'THRESHOLD_BASED') {
                                        if (joinDay <= 7) creditToApply = credit;
                                        else if (joinDay <= 22) creditToApply = credit / 2;
                                        else creditToApply = 0;
                                    } else if (ruleNormalized === 'FULL_MONTH') {
                                        creditToApply = credit;
                                    } else if (ruleNormalized === 'PRO_RATA_DAYS') {
                                        const daysInMonth = joinDate.daysInMonth();
                                        const daysRemaining = daysInMonth - joinDay + 1;
                                        creditToApply = (daysRemaining / daysInMonth) * credit;
                                    }
                                } else {
                                    creditToApply = credit;
                                }
                            }
                        } else if (earningRules && earningRules.accrual_type === 'attendance_based') {
                            // Category-specific attendance-based accrual with custom frequency and custom ratios
                            const freqInMonths = getFrequencyMonths(earningRules.frequency || 'yearly');
                            const nextCycleMonth = calculationDate.add(1, 'day').startOf('month');

                            let anchorStart = start;
                            if (template.leave_policy_cycle === 'MONTHLY' && freqInMonths > 1) {
                                anchorStart = calculationDate.startOf('year');
                            }
                            const monthsDiff = nextCycleMonth.diff(anchorStart.startOf('month'), 'month');

                            if (monthsDiff > 0 && monthsDiff % freqInMonths === 0) {
                                shouldProcess = true;
                                const queryStart = nextCycleMonth.subtract(freqInMonths, 'month');
                                const queryEnd = nextCycleMonth.subtract(1, 'day');

                                const attendanceRecords = await AttendanceDay.findAll({
                                    where: {
                                        employee_id: employee.id,
                                        attendance_date: {
                                            [Op.between]: [queryStart.format('YYYY-MM-DD'), queryEnd.format('YYYY-MM-DD')]
                                        }
                                    },
                                    transaction
                                });

                                let totalPresentDays = 0;
                                for (const record of attendanceRecords) {
                                    const statusVal = parseInt(record.status, 10);
                                    if ([0, 7, 12].includes(statusVal)) {
                                        totalPresentDays += 1.0;
                                    } else if ([1, 13].includes(statusVal)) {
                                        totalPresentDays += 0.5;
                                    }
                                }

                                const reqDays = parseFloat(earningRules.earning_ratio_present_days || 365) || 365;
                                const earnLeaves = parseFloat(earningRules.earning_ratio_leave_value || 21);
                                let computedCredit = (totalPresentDays / reqDays) * earnLeaves;

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
                                    let currentAllocated = parseFloat(balance.total_allocated || 0);
                                    if (earningRules.max_earning_limit) {
                                        const maxLimit = parseFloat(earningRules.max_earning_limit);
                                        if (currentAllocated + computedCredit > maxLimit) {
                                            computedCredit = Math.max(0, maxLimit - currentAllocated);
                                        }
                                    }
                                    creditToApply = computedCredit;
                                } else {
                                    creditToApply = computedCredit;
                                }
                            }
                        } else if (template.accrual_type === 'MONTHLY') {
                            // Standard template monthly accrual fallback
                            shouldProcess = true;
                            let monthlyRate = category.leave_count / 12; // Default for annual cycles
                            if (template.leave_policy_cycle === 'MONTHLY') {
                                monthlyRate = category.leave_count;
                            } else if (template.leave_policy_cycle === 'QUARTERLY') {
                                monthlyRate = category.leave_count / 3;
                            }

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
                        }

                        if (shouldProcess) {
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
                                const newTotal = Math.round((parseFloat(balance.total_allocated || 0) + creditToApply) * 2) / 2;
                                const newPending = Math.round((parseFloat(balance.pending_leaves || 0) + creditToApply) * 2) / 2;

                                await commonQuery.updateRecordById(EmployeeLeaveBalance, balance.id, {
                                    total_allocated: newTotal,
                                    pending_leaves: newPending
                                }, transaction, false, true, batch_id);
                            }
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
    static async processYearEndReset(asOf = null, batch_id = null) {
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
                // This correctly includes dynamic categories like Comp-Off Leave that aren't in the template
                const balancesToUpdate = await EmployeeLeaveBalance.findAll({
                    where: {
                        employee_id: employee.id,
                        year: lastYear,
                        month: lastMonth,
                        status: 0
                    },
                    transaction
                });

                for (const bal of balancesToUpdate) {
                    await commonQuery.updateRecordById(EmployeeLeaveBalance, { id: bal.id }, { status: 1 }, transaction, false, {}, batch_id);
                }

                if (balancesToUpdate.length > 0) {
                    console.log(`[Year-End Log] Marked ${balancesToUpdate.length} balances as processed for Emp ${employee.id} (Year: ${lastYear}${lastMonth ? ` Month: ${lastMonth}` : ''}).`);
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
            const template = emp.leaveTemplate || (emp.leave_template ? await commonQuery.findOneRecord(LeaveTemplate, emp.leave_template, {}, t, false, {}) : null);
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

            // Strict validation: Don't allow negative balance for Paid categories or Comp-Off Leave.
            // Thrown as `Err` (not a plain Error) so it reaches the client with this exact message
            // via handleError's `err.handled` shortcut, instead of falling through to a generic
            // "Something went wrong on our servers" — this call is buried several layers deep
            // (e.g. updateAttendanceDay -> manualPunch -> rebuildAttendanceDay -> syncLeaveRecord)
            // where not every caller wraps it in its own try/catch to reformat the message.
            if (pending < 0 && (balance.is_paid || balance.is_compoff)) {
                throw new Err(`Insufficient leave balance in ${balance.leave_category_name}. Available: ${balance.pending_leaves}. Required: ${roundedAmount}.`);
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
                // request_type: 'DEBIT',
                start_date: { [Op.lte]: date },
                end_date: { [Op.gte]: date },
                approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                is_encashment: false,
                status: 0,
                reason: { [Op.ne]: AUTO_REASON }
            }, {}, t, false, {});

            // 2. Find existing auto-generated request for this specific date
            const existingAuto = await commonQuery.findOneRecord(LeaveRequest, {
                employee_id: employeeId,
                // request_type: 'DEBIT',
                start_date: date,
                end_date: date,
                status: 0,
                reason: AUTO_REASON
            }, {}, t, false, {});

            // Round amount
            const roundedAmount = Math.round(amount * 10) / 10;

            // If a manual request covers this day, we should probably not have an auto-generated one competing.
            if (manualRequest && amount > 0) {
                // If we have an auto-generated one, cancel it (manual wins)
                if (existingAuto) {
                    console.log(`[syncLeaveRecord] Cancelling competing auto-request: #${existingAuto.id}`);
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t, date, employee);
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, { approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED, status: 2 }, t, false, {});
                }

                const categoryChanged = categoryId !== undefined && categoryId !== null
                    && Number(categoryId) !== Number(manualRequest.leave_category_id);

                if (!categoryChanged) {
                    console.log(`[syncLeaveRecord] Manual request found: #${manualRequest.id}. Preserving manual leave as amount > 0.`);
                    if (!transaction) await t.commit();
                    return null;
                }

                // --- Category changed on an already-APPROVED manual leave (e.g. admin edited the
                // attendance day from Casual Leave to Paid Leave). The old category's balance must
                // be refunded and the new category's balance deducted for THIS day specifically —
                // the manual request may span multiple days, so a single-day change has to split it
                // the same way a single-day cancellation does (see roundedAmount===0 branch below).
                console.log(`[syncLeaveRecord] Manual request #${manualRequest.id} category changed: ${manualRequest.leave_category_id} -> ${categoryId}`);

                const isSingleDayRequest = manualRequest.start_date === date && manualRequest.end_date === date;

                if (isSingleDayRequest) {
                    const dayAmount = Math.round(parseFloat(manualRequest.total_days || 0) * 10) / 10;
                    await this.adjustLeaveBalance(employeeId, manualRequest.leave_category_id, -dayAmount, t, date, employee);
                    await this.adjustLeaveBalance(employeeId, categoryId, dayAmount, t, date, employee);
                    await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, {
                        leave_category_id: categoryId,
                        reason: (manualRequest.reason && manualRequest.reason !== AUTO_REASON) ? manualRequest.reason : "Leave category updated from Attendance"
                    }, t);
                } else {
                    // Multi-day request: split off just this date into its own APPROVED request under
                    // the new category, mirroring the cancellation-split logic below.
                    let dayAmount = 1.0;
                    if (manualRequest.start_date === date && manualRequest.start_session !== 0) dayAmount = 0.5;
                    else if (manualRequest.end_date === date && manualRequest.end_session !== 0) dayAmount = 0.5;

                    await this.adjustLeaveBalance(employeeId, manualRequest.leave_category_id, -dayAmount, t, date, employee);
                    await this.adjustLeaveBalance(employeeId, categoryId, dayAmount, t, date, employee);

                    const origStartDate = manualRequest.start_date;
                    const origEndDate = manualRequest.end_date;
                    const prevDate = dayjs(date).subtract(1, 'day').format('YYYY-MM-DD');
                    const nextDate = dayjs(date).add(1, 'day').format('YYYY-MM-DD');

                    const getSplitDays = async (sD, eD, sS, eS) => {
                        const employeeRecord = employee || await commonQuery.findOneRecord(Employee, employeeId, {
                            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                        }, t);
                        if (!employeeRecord) return 0;

                        const { totalWorkingDays } = await LeaveBalanceService.computeSandwichAdjustedWorkingDays(
                            employeeRecord, manualRequest.leave_category_id, sD, eD, t,
                            { startSession: sS, endSession: eS }
                        );

                        let workingDays = totalWorkingDays;
                        if (sD === eD && sS !== 0) {
                            workingDays = workingDays > 0 ? 0.5 : 0;
                        } else {
                            if (sS !== 0 && workingDays > 0) workingDays -= 0.5;
                            if (eS !== 0 && sD !== eD && workingDays > 0) workingDays -= 0.5;
                        }
                        return Math.max(workingDays, 0);
                    };

                    const newCategoryPlaceholder = {
                        ...manualRequest.toJSON(),
                        start_date: date,
                        end_date: date,
                        leave_category_id: categoryId,
                        total_days: dayAmount,
                        approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                        reason: "Leave category updated from Attendance"
                    };
                    delete newCategoryPlaceholder.id;
                    delete newCategoryPlaceholder.createdAt;
                    delete newCategoryPlaceholder.updatedAt;

                    if (date === origStartDate) {
                        // Cutting off the first day: remaining request moves start date forward.
                        newCategoryPlaceholder.start_session = manualRequest.start_session;
                        newCategoryPlaceholder.end_session = manualRequest.start_session;
                        const remainingDays = await getSplitDays(nextDate, origEndDate, 0, manualRequest.end_session);
                        await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, {
                            start_date: nextDate,
                            start_session: 0,
                            total_days: remainingDays,
                            reason: (manualRequest.reason || "") + ` [Day ${date} moved to a new category: start date moved to ${nextDate}]`
                        }, t);
                        await commonQuery.createRecord(LeaveRequest, newCategoryPlaceholder, t);
                    } else if (date === origEndDate) {
                        // Cutting off the last day: remaining request moves end date backward.
                        newCategoryPlaceholder.start_session = manualRequest.end_session;
                        newCategoryPlaceholder.end_session = manualRequest.end_session;
                        const remainingDays = await getSplitDays(origStartDate, prevDate, manualRequest.start_session, 0);
                        await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, {
                            end_date: prevDate,
                            end_session: 0,
                            total_days: remainingDays,
                            reason: (manualRequest.reason || "") + ` [Day ${date} moved to a new category: end date moved to ${prevDate}]`
                        }, t);
                        await commonQuery.createRecord(LeaveRequest, newCategoryPlaceholder, t);
                    } else {
                        // Cutting off a middle day: original request splits into two segments.
                        newCategoryPlaceholder.start_session = 0;
                        newCategoryPlaceholder.end_session = 0;
                        const firstSegDays = await getSplitDays(origStartDate, prevDate, manualRequest.start_session, 0);
                        await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, {
                            end_date: prevDate,
                            end_session: 0,
                            total_days: firstSegDays,
                            reason: (manualRequest.reason || "") + ` [Split: Segment 1 ending at ${prevDate}, day ${date} moved to a new category]`
                        }, t);
                        await commonQuery.createRecord(LeaveRequest, newCategoryPlaceholder, t);

                        const secondSegDays = await getSplitDays(nextDate, origEndDate, 0, manualRequest.end_session);
                        const secondSegPlaceholder = {
                            ...manualRequest.toJSON(),
                            start_date: nextDate,
                            end_date: origEndDate,
                            start_session: 0,
                            end_session: manualRequest.end_session,
                            total_days: secondSegDays,
                            approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                            reason: (manualRequest.reason || "") + ` [Split: Segment 2 starting at ${nextDate}]`
                        };
                        delete secondSegPlaceholder.id;
                        delete secondSegPlaceholder.createdAt;
                        delete secondSegPlaceholder.updatedAt;
                        await commonQuery.createRecord(LeaveRequest, secondSegPlaceholder, t);
                    }
                }

                if (!transaction) await t.commit();
                return null;
            }

            // --- Manage Auto-Generated Record ---

            // CASE A: Amount is 0 (Status changed away from Leave/HalfDay)
            if (roundedAmount === 0) {
                console.log(`[syncLeaveRecord] CASE A: Amount is 0`);
                if (existingAuto) {
                    console.log(`[syncLeaveRecord] Cancelling auto-request because amount is 0: #${existingAuto.id}`);
                    await this.adjustLeaveBalance(employeeId, existingAuto.leave_category_id, -existingAuto.total_days, t, date, employee);
                    await commonQuery.updateRecordById(LeaveRequest, existingAuto.id, { approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED, status: 2 }, t, false, {});
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
                            await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, { approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED }, t, false, {});
                        } else {
                            // Multi-day request: Split the request into separate segments
                            console.log(`[syncLeaveRecord] Splitting multi-day manual request: #${manualRequest.id} around date ${date}`);
                            
                            let refundAmount = 1.0;
                            // Check if the cancelled date is on the start or end boundary and has session adjustments
                            if (manualRequest.start_date === date && manualRequest.start_session !== 0) refundAmount = 0.5;
                            else if (manualRequest.end_date === date && manualRequest.end_session !== 0) refundAmount = 0.5;

                            await this.adjustLeaveBalance(employeeId, manualRequest.leave_category_id, -refundAmount, t, date, employee);

                            const origStartDate = manualRequest.start_date;
                            const origEndDate = manualRequest.end_date;
                            const prevDate = dayjs(date).subtract(1, 'day').format('YYYY-MM-DD');
                            const nextDate = dayjs(date).add(1, 'day').format('YYYY-MM-DD');

                            // Delegates to the shared, category-aware sandwich calculation (see
                            // computeSandwichAdjustedWorkingDays) instead of reimplementing the
                            // day-bracket algorithm a second time.
                            const getSplitDays = async (sD, eD, sS, eS) => {
                                const employeeRecord = employee || await commonQuery.findOneRecord(Employee, employeeId, {
                                    include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                                }, t);
                                if (!employeeRecord) return 0;

                                const { totalWorkingDays } = await LeaveBalanceService.computeSandwichAdjustedWorkingDays(
                                    employeeRecord, manualRequest.leave_category_id, sD, eD, t,
                                    { startSession: sS, endSession: eS }
                                );

                                let workingDays = totalWorkingDays;
                                if (sD === eD && sS !== 0) {
                                    workingDays = workingDays > 0 ? 0.5 : 0;
                                } else {
                                    if (sS !== 0 && workingDays > 0) workingDays -= 0.5;
                                    if (eS !== 0 && sD !== eD && workingDays > 0) workingDays -= 0.5;
                                }
                                return Math.max(workingDays, 0);
                            };

                            if (date === origStartDate) {
                                // CASE 1: Cancelling first day
                                // Existing row moves start date forward
                                const newDays = await getSplitDays(nextDate, origEndDate, 0, manualRequest.end_session);
                                await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, {
                                    start_date: nextDate,
                                    start_session: 0,
                                    total_days: newDays,
                                    reason: (manualRequest.reason || "") + ` [Day ${date} cancelled: start date moved to ${nextDate}]`
                                }, t);

                                // Create cancelled placeholder
                                const cancelledPlaceholder = {
                                    ...manualRequest.toJSON(),
                                    start_date: date,
                                    end_date: date,
                                    start_session: manualRequest.start_session,
                                    end_session: manualRequest.start_session,
                                    total_days: refundAmount,
                                    approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED,
                                    reason: `Cancelled due to attendance override`
                                };
                                delete cancelledPlaceholder.id;
                                delete cancelledPlaceholder.createdAt;
                                delete cancelledPlaceholder.updatedAt;
                                await commonQuery.createRecord(LeaveRequest, cancelledPlaceholder, t);

                            } else if (date === origEndDate) {
                                // CASE 2: Cancelling last day
                                // Existing row moves end date backward
                                const newDays = await getSplitDays(origStartDate, prevDate, manualRequest.start_session, 0);
                                await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, {
                                    end_date: prevDate,
                                    end_session: 0,
                                    total_days: newDays,
                                    reason: (manualRequest.reason || "") + ` [Day ${date} cancelled: end date moved to ${prevDate}]`
                                }, t);

                                // Create cancelled placeholder
                                const cancelledPlaceholder = {
                                    ...manualRequest.toJSON(),
                                    start_date: date,
                                    end_date: date,
                                    start_session: manualRequest.end_session,
                                    end_session: manualRequest.end_session,
                                    total_days: refundAmount,
                                    approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED,
                                    reason: `Cancelled due to attendance override`
                                };
                                delete cancelledPlaceholder.id;
                                delete cancelledPlaceholder.createdAt;
                                delete cancelledPlaceholder.updatedAt;
                                await commonQuery.createRecord(LeaveRequest, cancelledPlaceholder, t);

                            } else {
                                // CASE 3: Cancelling a middle day
                                // 1. First segment: origStartDate -> prevDate (Approved)
                                const firstSegDays = await getSplitDays(origStartDate, prevDate, manualRequest.start_session, 0);
                                await commonQuery.updateRecordById(LeaveRequest, manualRequest.id, {
                                    end_date: prevDate,
                                    end_session: 0,
                                    total_days: firstSegDays,
                                    reason: (manualRequest.reason || "") + ` [Split: Segment 1 ending at ${prevDate}]`
                                }, t);

                                // 2. Cancelled day placeholder
                                const cancelledPlaceholder = {
                                    ...manualRequest.toJSON(),
                                    start_date: date,
                                    end_date: date,
                                    start_session: 0,
                                    end_session: 0,
                                    total_days: refundAmount,
                                    approval_status: constants.LEAVE_APPROVAL_STATUS.CANCELLED,
                                    reason: `Split cancellation for day ${date} due to attendance override`
                                };
                                delete cancelledPlaceholder.id;
                                delete cancelledPlaceholder.createdAt;
                                delete cancelledPlaceholder.updatedAt;
                                await commonQuery.createRecord(LeaveRequest, cancelledPlaceholder, t);

                                // 3. Second segment: nextDate -> origEndDate (Approved)
                                const secondSegDays = await getSplitDays(nextDate, origEndDate, 0, manualRequest.end_session);
                                const secondSegPlaceholder = {
                                    ...manualRequest.toJSON(),
                                    start_date: nextDate,
                                    end_date: origEndDate,
                                    start_session: 0,
                                    end_session: manualRequest.end_session,
                                    total_days: secondSegDays,
                                    approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
                                    reason: (manualRequest.reason || "") + ` [Split: Segment 2 starting at ${nextDate}]`
                                };
                                delete secondSegPlaceholder.id;
                                delete secondSegPlaceholder.createdAt;
                                delete secondSegPlaceholder.updatedAt;
                                await commonQuery.createRecord(LeaveRequest, secondSegPlaceholder, t);
                            }
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
     * Merges the template-wide sandwich_rules with a category's automation_rules.sandwich_override
     * (category wins per-field when present/non-null). Falls back to synthesizing an equivalent
     * config from the legacy `count_sandwich_leaves` boolean when sandwich_rules is unset, so
     * existing tenants keep today's exact behavior until they explicitly reconfigure.
     */
    static resolveSandwichConfig(template, category) {
        let templateConfig = template ? template.sandwich_rules : null;
        if (templateConfig && typeof templateConfig === 'string') {
            try { templateConfig = JSON.parse(templateConfig); } catch (e) { templateConfig = null; }
        }
        if (!templateConfig) {
            templateConfig = {
                enabled: !!(template && template.count_sandwich_leaves),
                absorb_weekly_off: true,
                absorb_holiday: true,
                absorb_holiday_types: ['mandatory', 'restricted'],
                max_consecutive_offdays: null,
                half_day_boundary: 'count_full',
            };
        }

        let automationRules = category ? category.automation_rules : null;
        if (automationRules && typeof automationRules === 'string') {
            try { automationRules = JSON.parse(automationRules); } catch (e) { automationRules = null; }
        }
        const categoryOverride = automationRules ? automationRules.sandwich_override : null;

        const merged = categoryOverride
            ? {
                ...templateConfig,
                ...categoryOverride,
                rules: categoryOverride.rules ?? templateConfig.rules,
                applies_to: templateConfig.applies_to ?? null,
            }
            : { ...templateConfig };

        // Check applies_to: if set and category name not in list, disable sandwich for this category
        if (merged.applies_to && Array.isArray(merged.applies_to) && category) {
            const catName = (category.leave_category_name || '').toLowerCase().trim();
            const inList = merged.applies_to.some(n => (n || '').toLowerCase().trim() === catName);
            if (!inList) return { ...merged, enabled: false };
        }

        return merged;
    }

    /**
     * Lightweight check used by attendance-status marking (attendanceHelper.js) — is
     * sandwich absorption enabled at all for this employee/category, without running
     * the full per-day calculation.
     */
    static async isSandwichEnabledForLeave(employee, leaveCategoryId, transaction = null) {
        let category = null;
        if (leaveCategoryId) {
            category = await commonQuery.findOneRecord(LeaveTemplateCategory, leaveCategoryId, {}, transaction, false, {});
        }
        const template = await LeaveBalanceService.resolveEmployeeLeaveTemplate(employee, transaction);
        const config = LeaveBalanceService.resolveSandwichConfig(template, category);
        return !!config.enabled;
    }

    /**
     * Returns the employee's leave template, loading it from `employee.leave_template`
     * when the caller didn't eager-load the `leaveTemplate` association (several
     * attendance code paths pass a pre-fetched employee without it, and silently
     * treating that as "no template" would disable sandwich absorption).
     */
    static async resolveEmployeeLeaveTemplate(employee, transaction = null) {
        if (!employee) return null;
        if (employee.leaveTemplate) return employee.leaveTemplate;
        if (!employee.leave_template) return null;
        return await commonQuery.findOneRecord(LeaveTemplate, employee.leave_template, {}, transaction, false, {});
    }

    /** Whether a given off-day (holiday or weekly-off) can potentially be absorbed. */
    static isDayAbsorbable(config, { isHoliday, isWeeklyOff, holidayType }) {
        // New rule-based format: all off-days are candidates; actual absorption checked per rule
        if (Array.isArray(config.rules)) return isHoliday || isWeeklyOff;
        // Legacy format
        if (isWeeklyOff && config.absorb_weekly_off) return true;
        if (isHoliday && config.absorb_holiday) {
            const types = Array.isArray(config.absorb_holiday_types) && config.absorb_holiday_types.length > 0
                ? config.absorb_holiday_types
                : ['mandatory', 'restricted'];
            const typeLabel = Number(holidayType) === 2 ? 'restricted' : 'mandatory';
            return types.includes(typeLabel);
        }
        return false;
    }

    /**
     * Match an off-day against user-defined sandwich rules.
     * Rules are evaluated first-match-wins. If NO rule matches the combination,
     * the default is TRUE (sandwich applies) — rules act as explicit overrides,
     * not as an allowlist. To exclude a case, add a rule with applicable=false.
     */
    static matchSandwichRules(rules, leftType, offType, rightType) {
        for (const rule of rules) {
            const leftMatch = rule.left === leftType;
            const rightMatch = rule.right === rightType;
            const offMatch = rule.off === 'both' || rule.off === offType;
            if (leftMatch && offMatch && rightMatch) return rule.applicable !== false;
        }
        return true; // no matching rule → default: sandwich applies
    }

    /**
     * Within a marked run of absorbed off-days, drops days in the middle of the run
     * once it exceeds `cap`, keeping the days nearest each working boundary.
     */
    static applyConsecutiveCap(days, nonWorkingDaysToCount, cap) {
        if (cap === null || cap === undefined || cap <= 0) return;
        let runStart = null;
        for (let i = 0; i <= days.length; i++) {
            const marked = i < days.length && nonWorkingDaysToCount.has(days[i]);
            if (marked && runStart === null) {
                runStart = i;
            } else if (!marked && runStart !== null) {
                const runLength = i - runStart;
                if (runLength > cap) {
                    const keepFromStart = Math.ceil(cap / 2);
                    const keepFromEnd = cap - keepFromStart;
                    for (let k = runStart; k < i; k++) {
                        const distFromStart = k - runStart;
                        const distFromEnd = (i - 1) - k;
                        if (distFromStart >= keepFromStart && distFromEnd >= keepFromEnd) {
                            nonWorkingDaysToCount.delete(days[k]);
                        }
                    }
                }
                runStart = null;
            }
        }
    }

    /**
     * half_day_boundary='exempt': when the request's own start/end day is only a
     * half-day (session leave), the off-day run immediately touching that side is
     * un-absorbed rather than counted as a full sandwich block.
     */
    static exemptBoundaryRun(days, dayInfoMap, nonWorkingDaysToCount, side) {
        if (days.length === 0) return;
        if (side === 'start') {
            if (!dayInfoMap.get(days[0]).isWorking) return;
            for (let i = 1; i < days.length && nonWorkingDaysToCount.has(days[i]); i++) {
                nonWorkingDaysToCount.delete(days[i]);
            }
        } else {
            const lastIdx = days.length - 1;
            if (!dayInfoMap.get(days[lastIdx]).isWorking) return;
            for (let i = lastIdx - 1; i >= 0 && nonWorkingDaysToCount.has(days[i]); i--) {
                nonWorkingDaysToCount.delete(days[i]);
            }
        }
    }

    /**
     * Calculates total leave days for a date range, respecting the effective sandwich
     * policy (template default merged with the leave category's override, see
     * resolveSandwichConfig). This is the single source of truth for sandwich-adjusted
     * day counting — replaces the old calculateWorkingDays/getSplitDays duplicates.
     *
     * options: { startSession, endSession } — SMALLINT session values (0=Full,1/2=Half)
     * for the request's own start/end date, used by half_day_boundary='exempt'.
     */
    static async computeSandwichAdjustedWorkingDays(employee, leaveCategoryId, startDate, endDate, transaction = null, options = {}) {
        if (!employee) return { totalWorkingDays: 0, dayBreakdown: [], config: null };

        const { getDayOffInfo } = require("../helpers/attendanceHelper");
        const startSession = options.startSession || 0;
        const endSession = options.endSession || 0;

        let category = null;
        if (leaveCategoryId) {
            category = await commonQuery.findOneRecord(LeaveTemplateCategory, leaveCategoryId, {}, transaction, false, {});
        }
        const template = await LeaveBalanceService.resolveEmployeeLeaveTemplate(employee, transaction);
        const config = LeaveBalanceService.resolveSandwichConfig(template, category);

        const start = dayjs(startDate);
        const end = dayjs(endDate);
        const calendarDays = end.diff(start, 'day') + 1;

        const dayInfoMap = new Map();
        for (let i = 0; i < calendarDays; i++) {
            const cur = start.add(i, 'day').format('YYYY-MM-DD');
            const { isHoliday, isWeeklyOff, holidayDetails } = await getDayOffInfo(employee, cur, transaction);
            const isWorking = !isHoliday && !isWeeklyOff;
            const isAbsorbable = !isWorking && config.enabled && LeaveBalanceService.isDayAbsorbable(config, {
                isHoliday, isWeeklyOff, holidayType: holidayDetails?.holiday_type
            });
            dayInfoMap.set(cur, {
                date: cur,
                isWorking,
                isHoliday,
                isWeeklyOff,
                isAbsorbable,
                holidayName: holidayDetails?.name || null
            });
        }

        const days = Array.from(dayInfoMap.keys()).sort();
        const nonWorkingDaysToCount = new Set();

        if (config.enabled) {
            const rules = Array.isArray(config.rules) ? config.rules : null;

            for (let i = 0; i < days.length; i++) {
                const curInfo = dayInfoMap.get(days[i]);
                if (curInfo.isWorking || !curInfo.isAbsorbable) continue;

                let nearestBeforeIdx = -1;
                for (let j = i - 1; j >= 0; j--) {
                    if (dayInfoMap.get(days[j]).isWorking) { nearestBeforeIdx = j; break; }
                }
                let nearestAfterIdx = -1;
                for (let j = i + 1; j < days.length; j++) {
                    if (dayInfoMap.get(days[j]).isWorking) { nearestAfterIdx = j; break; }
                }
                const hasWorkingBefore = nearestBeforeIdx !== -1;
                const hasWorkingAfter = nearestAfterIdx !== -1;

                let shouldAbsorb = false;
                if (rules) {
                    const offType = curInfo.isHoliday ? 'holiday' : 'weekoff';
                    // Half-day boundary: nearest leave day is the first/last of the span
                    // and that span boundary has a half-day session → match 'halfday' type
                    const leftType = (nearestBeforeIdx === -1) ? 'working'
                        : (nearestBeforeIdx === 0 && startSession !== 0) ? 'halfday'
                        : 'absent';
                    const rightType = (nearestAfterIdx === -1) ? 'working'
                        : (nearestAfterIdx === days.length - 1 && endSession !== 0) ? 'halfday'
                        : 'absent';
                    shouldAbsorb = LeaveBalanceService.matchSandwichRules(rules, leftType, offType, rightType);
                } else {
                    // Legacy format: absorb when leave days on both sides
                    shouldAbsorb = hasWorkingBefore && hasWorkingAfter;
                }

                if (shouldAbsorb) nonWorkingDaysToCount.add(days[i]);
            }

            LeaveBalanceService.applyConsecutiveCap(days, nonWorkingDaysToCount, config.max_consecutive_offdays);

            // Half-day boundary exemption: legacy half_day_boundary='exempt' only
            if (!rules && config.half_day_boundary === 'exempt') {
                if (startSession) LeaveBalanceService.exemptBoundaryRun(days, dayInfoMap, nonWorkingDaysToCount, 'start');
                if (endSession) LeaveBalanceService.exemptBoundaryRun(days, dayInfoMap, nonWorkingDaysToCount, 'end');
            }
        }

        let totalWorkingDays = 0;
        const dayBreakdown = [];
        for (const cur of days) {
            const info = dayInfoMap.get(cur);
            const absorbed = !info.isWorking && nonWorkingDaysToCount.has(cur);
            if (info.isWorking || absorbed) totalWorkingDays += 1;
            dayBreakdown.push({
                date: cur,
                isWorking: info.isWorking,
                absorbedBySandwich: absorbed,
                reason: absorbed ? (info.isHoliday ? 'holiday_sandwiched' : 'weekly_off_sandwiched') : null
            });
        }

        return { totalWorkingDays, dayBreakdown, config };
    }

    /**
     * Backward-compatible wrapper around computeSandwichAdjustedWorkingDays for any
     * caller that only has an employeeId (no category context). Prefer calling
     * computeSandwichAdjustedWorkingDays directly with a leaveCategoryId when available,
     * since a category-level sandwich_override will only apply that way.
     */
    static async calculateWorkingDays(employeeId, startDate, endDate, transaction = null, leaveCategoryId = null) {
        const employee = await commonQuery.findOneRecord(Employee, employeeId, {
            include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
        }, transaction);
        if (!employee) return 0;
        const { totalWorkingDays } = await LeaveBalanceService.computeSandwichAdjustedWorkingDays(employee, leaveCategoryId, startDate, endDate, transaction);
        return totalWorkingDays;
    }

    /**
     * Finds the nearest APPROVED leave request(s) for this employee immediately
     * before/after the given range, within maxGapDays — the basis for cross-request
     * sandwich detection (two separately-filed requests bracketing a weekend/holiday).
     */
    static async findAdjacentApprovedLeave(employeeId, leaveCategoryId, startDate, endDate, maxGapDays, transaction = null, excludeRequestId = null, approvalStatuses = null) {
        const gap = (maxGapDays && maxGapDays > 0) ? maxGapDays : 7;
        const windowStart = dayjs(startDate).subtract(gap, 'day').format('YYYY-MM-DD');
        const windowEnd = dayjs(endDate).add(gap, 'day').format('YYYY-MM-DD');

        const where = {
            employee_id: employeeId,
            approval_status: approvalStatuses ? { [Op.in]: approvalStatuses } : constants.LEAVE_APPROVAL_STATUS.APPROVED,
            status: 0,
            is_encashment: false,
            [Op.or]: [
                { start_date: { [Op.between]: [windowStart, windowEnd] } },
                { end_date: { [Op.between]: [windowStart, windowEnd] } },
            ],
        };
        if (excludeRequestId) where.id = { [Op.ne]: excludeRequestId };

        const candidates = await commonQuery.findAllRecords(LeaveRequest, where, { order: [['start_date', 'ASC']] }, transaction, {});

        let before = null;
        let after = null;
        for (const req of (candidates || [])) {
            if (dayjs(req.end_date).isBefore(dayjs(startDate))) {
                if (!before || dayjs(req.end_date).isAfter(dayjs(before.end_date))) before = req;
            } else if (dayjs(req.start_date).isAfter(dayjs(endDate))) {
                if (!after || dayjs(req.start_date).isBefore(dayjs(after.start_date))) after = req;
            }
        }
        return { before, after };
    }

    /**
     * Computes the gap days strictly between two adjacent leave requests that become
     * sandwich-absorbed only when BOTH requests are considered together (cross-request
     * detection), by running the shared day-calc over their combined span and taking
     * the days that fall in between neither request's own range.
     */
    static async computeCrossRequestGapDays(employee, leaveCategoryId, earlierRequest, laterRequest, transaction = null) {
        // For the span's start boundary: use earlier request's start_session.
        // For the span's end boundary: use later request's end_session, but for a
        // single-day request the half-day session sits in start_session (end_session=0).
        const spanStartSession = earlierRequest.start_session || 0;
        const spanEndSession = laterRequest.start_date === laterRequest.end_date
            ? (laterRequest.end_session || laterRequest.start_session || 0)
            : (laterRequest.end_session || 0);
        const combined = await LeaveBalanceService.computeSandwichAdjustedWorkingDays(
            employee, leaveCategoryId, earlierRequest.start_date, laterRequest.end_date, transaction,
            { startSession: spanStartSession, endSession: spanEndSession }
        );
        const earlierEnd = dayjs(earlierRequest.end_date);
        const laterStart = dayjs(laterRequest.start_date);

        // Collect only the days that fall in the gap between the two leave requests
        const gapDays = combined.dayBreakdown.filter(d => {
            const cur = dayjs(d.date);
            return cur.isAfter(earlierEnd) && cur.isBefore(laterStart);
        });

        // If there are any actual working days in the gap (employee came to office),
        // the sandwich chain is broken — no cross-request absorption applies.
        const hasWorkingDayInGap = gapDays.some(d => d.isWorking && !d.absorbedBySandwich);
        if (hasWorkingDayInGap) return [];

        return gapDays.filter(d => d.absorbedBySandwich);
    }
}

module.exports = LeaveBalanceService;
