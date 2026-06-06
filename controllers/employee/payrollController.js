const { AttendanceDay, Employee, SalaryTemplate, SalaryTemplateTransaction, SalaryComponent, Payslip, EmployeeIncentive, EmployeeAdvance, EmployeeSalaryTemplate, EmployeeSalaryTemplateTransaction, SalaryRevisionHistory, sequelize, IncentiveType, DesignationMaster, CanteenAttendance, CompanyMaster, LeaveRequest, PaymentHistory, EmployeeWeeklyOff, EmployeeHoliday, ShiftTemplate, EmployeeLeaveBalance, LeaveTemplateCategory, LeaveTemplate, AttendanceTemplate, EmployeeAttendanceTemplate, Department, BranchMaster, User, Reimbursement, ExpenseType, CompanySettings } = require("../../models");
const { commonQuery, handleError, fail, formatDateTime, constants, applyRounding } = require("../../helpers");
const { Op } = require("sequelize");
const dayjs = require("dayjs");
const isBetween = require("dayjs/plugin/isBetween");
dayjs.extend(isBetween);
const pdfService = require("../../helpers/functions/pdfService");
const path = require("path");
const fs = require("fs");
const { handleExport } = require("../../helpers/functions/excelService");
const { ensureLatestPayslip, calculateEmployeeOffDays } = require("../../services/payrollService");
const { calculateTDS } = require("../../helpers/functions/salaryTaxCalculator");
const PFService = require("../../services/compliance/pfService");
const { createNotification } = require("../../services/notificationService");


/**
 * Payroll Controller - Phase 5 Conclusion
 * Handles the "consumption" of attendance data to generate salary summaries.
 */



/**
 * Internal helper to evaluate formula-based components
 */
const evaluateComponentFormula = (formula, valuesMap) => {
    if (!formula) return 0;
    try {
        let evalStr = formula.toUpperCase();

        // Use a more robust regex to find all placeholders like {BASIC}, {BASIC SALARY}, {BASIC_SALARY}
        // This is better than iterating all keys of valuesMap
        evalStr = evalStr.replace(/{([^{}]+)}/g, (match, key) => {
            const cleanKey = key.trim().toUpperCase();
            const normalizedKey = cleanKey.replace(/\s+/g, '_');

            // Check for normalized key first, then exact key, then default to 0
            if (valuesMap.hasOwnProperty(normalizedKey)) return valuesMap[normalizedKey];
            if (valuesMap.hasOwnProperty(cleanKey)) return valuesMap[cleanKey];
            return 0;
        });

        // Clean up any remaining non-math characters for safety
        // Allow digits, basic operators, parentheses, and dot
        evalStr = evalStr.replace(/[^0-9+\-*/(). ]/g, '');

        // Simple evaluation - using Function as a safe alternative to eval
        return new Function(`return ${evalStr}`)() || 0;
    } catch (e) {
        console.error("Formula evaluation failed:", formula, e.message);
        return 0;
    }
};

/**
 * Internal helper to calculate salary for an employee
 */
const performSalaryCalculation = async (employee_id, month, year, transaction = null, options = {}) => {
    const skipStatutory = options.skipStatutory || false;
    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    const endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    // Fetch company settings for rounding configuration
    const companySettings = await commonQuery.findOneRecord(CompanySettings, {
        settings_name: 'round_off_salary',
        status: 0
    }, {}, transaction);
    const roundOffType = companySettings?.settings_value || 0;

    // 1. Fetch Employee with Salary Mapping & Overrides using ORM for automatic nesting
    const employee = await commonQuery.findOneRecord(Employee, employee_id, {
        include: [
            {
                model: SalaryTemplate,
                as: "salaryTemplate",
                include: [{
                    model: SalaryTemplateTransaction,
                    as: "salaryTemplateTransactions",
                    order: [['id', 'ASC']],
                    include: [{ model: SalaryComponent, as: "component" }]
                }]
            },
            {
                model: EmployeeSalaryTemplate,
                as: "employeeSalaryTemplate",
                include: [{
                    separate: true,
                    model: EmployeeSalaryTemplateTransaction,
                    as: "employeeSalaryTemplateTransactions",
                    order: [['id', 'ASC']],
                    include: [{ model: SalaryComponent, as: "component" }]
                }]
            },
            {
                model: DesignationMaster,
                as: "designation",
                attributes: ['designation_name']
            },
            {
                model: EmployeeAdvance,
                as: "employeeAdvances",
                attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'adjusted_in_payroll'],
                where: {
                    adjusted_in_payroll: false,
                    status: 0
                },
                required: false
            },
            {
                model: EmployeeIncentive,
                as: "employeeIncentive",
                attributes: ['id', 'amount', 'incentive_date', 'month', 'year'],
                where: {
                    month: month,
                    year: year
                },
                required: false
            },
            {
                model: Reimbursement,
                as: "reimbursements",
                attributes: ['id', 'amount', 'date', 'description', 'expense_type', 'approval_status', 'payment_type'],
                where: {
                    date: { [Op.between]: [startDate, endDate] },
                    approval_status: constants.REIMBURSEMENT_APPROVAL_STATUS.APPROVED,
                    status: 0,
                    payment_type: 1
                },
                required: false,
                include: [{ model: ExpenseType, as: "expenseType", attributes: ["name"] }]
            },
            {
                model: EmployeeAttendanceTemplate,
                as: "employeeAttendanceTemplate",
                where: { status: 0 },
                required: false
            },
            {
                model: AttendanceTemplate,
                as: "attendanceTemplate",
                required: false
            }
        ]
    }, transaction);

    if (!employee) {
        return fail("Employee not found.");
    }

    const employeeSalaryTemplate = employee.employeeSalaryTemplate;
    const baseSalaryTemplate = employee.salaryTemplate;

    if (!employeeSalaryTemplate && !baseSalaryTemplate) {
        return fail("Employee or Salary Details not Added. Please add Salary Details to the employee first.");
    }

    // Determine which template to use (Override vs Base)
    const template = employeeSalaryTemplate || baseSalaryTemplate;

    // Normalize components list regardless of which template was used
    let rawComponents = employeeSalaryTemplate
        ? (employeeSalaryTemplate.employeeSalaryTemplateTransactions || [])
        : (baseSalaryTemplate.salaryTemplateTransactions || []);

    // Sort by ID ASC to match the sequence in Salary Structure
    rawComponents = [...rawComponents].sort((a, b) => a.id - b.id);

    // Step A: Aggregate Counts
    let presentDays = 0, halfDays = 0, uncategorizedHalfDays = 0, absentDays = 0, leaveDays = 0, holidays = 0, totalFine = 0, totalOTMins = 0, totalWorkedMins = 0, totalOTAmount = 0;
    let unpaidLeaveDays = 0, compoffLeaveDays = 0;

    // A.0 Calculate Weekly Offs and Holidays using common function
    const offDays = await calculateEmployeeOffDays(employee_id, month, year, transaction);
    let weeklyOffs = offDays.goneWeeklyOffs;

    // Prefetch leave configurations to identify Unpaid or CompOff status
    const leaveBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
        employee_id,
        year
    }, {}, transaction);

    // Also fetch categories from the employee's assigned leave template for name fallback
    let templateCategories = [];
    if (employee.leave_template) {
        templateCategories = await commonQuery.findAllRecords(LeaveTemplateCategory, {
            leave_template_id: employee.leave_template
        }, {}, transaction);
    }

    const leaveParamMap = new Map();
    // Initialize with template defaults
    templateCategories.forEach(cat => {
        leaveParamMap.set(cat.id, {
            name: cat.name,
            is_paid: cat.is_paid === true || cat.is_paid === 'true',
            is_compoff: false
        });
    });
    // Supplement with actual balance data
    leaveBalances.forEach(lb => {
        leaveParamMap.set(lb.leave_category_id, {
            name: lb.leave_category_name,
            is_paid: lb.is_paid === true || lb.is_paid === 'true',
            is_compoff: lb.is_compoff === true || lb.is_compoff === 'true'
        });
    });

    // A.1 & A.2 - Weekly offs and holidays already calculated via calculateEmployeeOffDays above

    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
        employee_id,
        attendance_date: { [Op.between]: [startDate, endDate] },
        status: { [Op.ne]: 2 }
    }, {}, transaction, { company_id: true });

    const monthLeaveUsage = {}; // Track usage per category ID for the current month
    const leaveCategoryDetails = {}; // Track usage per category name for leave_details
    const attendanceHolidayDates = new Set();
    attendanceRecords.forEach(day => {
        const catInfo = day.leave_category_id ? leaveParamMap.get(day.leave_category_id) : null;

        // Track current month leave usage
        let dayUsage = 0;
        const status = parseInt(day.status);
        if (status === 6) dayUsage = 1;
        else if (status === 1 || status === 13) dayUsage = 0.5;

        if (dayUsage > 0 && day.leave_category_id) {
            monthLeaveUsage[day.leave_category_id] = (monthLeaveUsage[day.leave_category_id] || 0) + dayUsage;

            const catName = catInfo ? catInfo.name : "Other Leave";
            leaveCategoryDetails[catName] = (leaveCategoryDetails[catName] || 0) + dayUsage;
        }

        switch (parseInt(day.status)) {
            case 0: case 12:
                const attendanceDateStr = dayjs(day.attendance_date).format('YYYY-MM-DD');
                const isWeeklyOff = offDays.weeklyOffList.find(wo => wo.date === attendanceDateStr);
                const isHoliday = offDays.holidayList.find(h => dayjs(h.date).format('YYYY-MM-DD') === attendanceDateStr);

                const lwpBasis = employeeSalaryTemplate?.lwp_calculation_basis || 'WORKING_DAYS';

                if (lwpBasis === 'WORKING_DAYS') {
                    // Don't count weekly offs and holidays as present
                    if (!isWeeklyOff && !isHoliday) {
                        presentDays++;
                    }
                } else {
                    // For FIXED_30_DAYS and DAYS_IN_MONTH, count all present days including weekly offs and holidays
                    presentDays++;
                }
                break;
            case 1: case 13:
                halfDays++;
                if (catInfo) {
                    if (!catInfo.is_paid) unpaidLeaveDays += 0.5;
                    else if (catInfo.is_compoff) compoffLeaveDays += 0.5;
                    else leaveDays += 0.5;
                } else {
                    uncategorizedHalfDays++;
                }
                break;
            case 4:
                holidays++;
                attendanceHolidayDates.add(dayjs(day.attendance_date).format('YYYY-MM-DD'));
                break;
            case 5:
                absentDays++;
                break;
            case 6:
                if (catInfo) {
                    if (!catInfo.is_paid) unpaidLeaveDays++;
                    else if (catInfo.is_compoff) compoffLeaveDays++;
                    else leaveDays++;
                } else {
                    leaveDays++;
                }
                break;
        }
        totalFine += parseFloat(day.fine_amount || 0);
        totalOTAmount += parseFloat(day.overtime_amount || 0);
        totalOTMins += parseInt(day.overtime_minutes || 0);
        totalWorkedMins += parseInt(day.worked_minutes || 0);
    });

    // This ensures if a holiday exists in both attendance (status 4) and template, it's counted only once
    (offDays.goneHolidayList || []).forEach(h => {
        const hDate = dayjs(h.date).format('YYYY-MM-DD');
        const existsInAttendanceHoliday = attendanceHolidayDates.has(hDate);
        if (!existsInAttendanceHoliday) {
            holidays++;
        }
    });

    // Step A.1: Calculate Canteen/Lunch Counts
    const lunchRecords = await commonQuery.findAllRecords(
        CanteenAttendance,
        {
            employee_id,
            date: { [Op.between]: [startDate, endDate] },
        },
        { attributes: ['date', 'created_at'] },
        transaction
    );
    const lunchHistory = lunchRecords.map(r => ({
        date: formatDateTime(r.getDataValue('date'), 'DD-MM-YYYY'),
        time: formatDateTime(r.getDataValue('created_at'), 'hh:mm A')
    }));
    const lunchCount = lunchHistory.length;

    // Logic for LWP
    const totalLWP = absentDays + (uncategorizedHalfDays * 0.5) + unpaidLeaveDays;

    // Total mathematically worked days
    const totalPresentDays = presentDays + (halfDays * 0.5);

    // Step B: Calculate Gross
    const currentMonthlyGross = parseFloat(template.ctc_monthly || 0);
    let monthlyGross = currentMonthlyGross;
    const dailyRate = parseFloat(template.daily_rate || 0);
    const hourlyRate = parseFloat(template.hourly_rate || 0);
    const salaryType = template.salary_type || "Monthly";

    const daysInMonth = dayjs(startDate).daysInMonth();
    let daysInCalculation = daysInMonth;

    if (template.lwp_calculation_basis === "FIXED_30_DAYS") {
        daysInCalculation = 30;
    } else if (template.lwp_calculation_basis === "WORKING_DAYS") {
        daysInCalculation = daysInMonth - offDays.totalWeeklyOffs;
    }

    const payableDaysValue = totalPresentDays + leaveDays + holidays;

    let actualDaysValue = 0;
    if (template.lwp_calculation_basis === "WORKING_DAYS") {
        actualDaysValue = daysInMonth - offDays.totalWeeklyOffs;
    } else if (template.lwp_calculation_basis === "FIXED_30_DAYS") {
        actualDaysValue = 30;
    } else {
        actualDaysValue = daysInMonth;
    }

    // [MOD] Determine unitWorkingHours from shift template (similar to attendanceHelper)
    let unitWorkingHours = 8;
    let shift = null;
    if (employee.shift_template) {
        shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template, {}, transaction);
    }
    if (shift) {
        if (parseFloat(shift.total_payable_hours) > 0) {
            unitWorkingHours = parseFloat(shift.total_payable_hours) / 60;
        } else if (shift.min_full_day_minutes > 0) {
            unitWorkingHours = shift.min_full_day_minutes / 60;
        }
    }

    const employeeEffectiveDate = template.effective_date ? dayjs(template.effective_date) : null;
    let salarySplitInfo = {
        isActive: false,
        effectiveDate: null,
        oldMonthlyGross: currentMonthlyGross,
        newMonthlyGross: currentMonthlyGross,
        weightedMonthlyGross: currentMonthlyGross,
        daysBefore: 0,
        daysAfter: 0,
        beforePayable: 0,
        afterPayable: 0,
        splitCounter: null
    };
    let splitCurrentGross = null;
    let splitLwpDeduction = null;

    const getCalculationDenominator = () => {
        if (template.lwp_calculation_basis === "FIXED_30_DAYS") return 30;
        if (template.lwp_calculation_basis === "WORKING_DAYS") return daysInCalculation;
        return daysInMonth;
    };

    if (salaryType === "Monthly" && employeeEffectiveDate && employeeEffectiveDate.isValid()) {
        const revisionCondition = {
            employee_id,
            effective_date: employeeEffectiveDate.format('YYYY-MM-DD'),
            status: 1
        };
        if (employeeSalaryTemplate?.id) revisionCondition.new_template_id = employeeSalaryTemplate.id;

        const revisionRecord = await commonQuery.findOneRecord(SalaryRevisionHistory, revisionCondition, {
            order: [['revision_date', 'DESC']]
        }, transaction);

        const oldMonthlyGross = parseFloat(revisionRecord?.previous_ctc || currentMonthlyGross);
        const newMonthlyGross = parseFloat(revisionRecord?.new_ctc || currentMonthlyGross);
        salarySplitInfo.oldMonthlyGross = oldMonthlyGross;
        salarySplitInfo.newMonthlyGross = newMonthlyGross;
        salarySplitInfo.effectiveDate = employeeEffectiveDate.format('YYYY-MM-DD');

        const startDt = dayjs(startDate);
        const endDt = dayjs(endDate);
        const denominator = getCalculationDenominator() || 1;

        if (employeeEffectiveDate.isAfter(endDt) && revisionRecord) {
            monthlyGross = oldMonthlyGross;
        } else if (employeeEffectiveDate.isBetween(startDt, endDt, null, '[]') && oldMonthlyGross !== newMonthlyGross) {
            const countWorkingDays = (fromDate, toDate) => {
                if (!fromDate || !toDate || !fromDate.isValid() || !toDate.isValid() || fromDate.isAfter(toDate)) return 0;
                if (template.lwp_calculation_basis !== "WORKING_DAYS") {
                    return toDate.diff(fromDate, 'day') + 1;
                }
                const weeklyOffsBefore = (offDays.weeklyOffList || []).filter(off => {
                    const offDate = dayjs(off.date);
                    return offDate.isBetween(fromDate, toDate, null, '[]');
                }).length;
                return Math.max(0, toDate.diff(fromDate, 'day') + 1 - weeklyOffsBefore);
            };

            const beforeSegmentEnd = employeeEffectiveDate.subtract(1, 'day');
            const daysBefore = countWorkingDays(startDt, beforeSegmentEnd);
            const daysAfter = Math.max(0, denominator - daysBefore);
            monthlyGross = ((oldMonthlyGross * daysBefore) + (newMonthlyGross * daysAfter)) / denominator;
            salarySplitInfo.isActive = true;
            salarySplitInfo.weightedMonthlyGross = monthlyGross;
            salarySplitInfo.daysBefore = daysBefore;
            salarySplitInfo.daysAfter = daysAfter;

            const splitCounter = {
                before: { present: 0, half: 0, uncategorizedHalf: 0, leave: 0, holiday: 0, absent: 0, unpaidLeave: 0 },
                after: { present: 0, half: 0, uncategorizedHalf: 0, leave: 0, holiday: 0, absent: 0, unpaidLeave: 0 }
            };
            const attendanceHolidayDates = new Set();

            attendanceRecords.forEach(day => {
                const dayKey = dayjs(day.attendance_date).format('YYYY-MM-DD');
                const segmentKey = dayjs(dayKey).isBefore(employeeEffectiveDate, 'day') ? 'before' : 'after';
                const catInfo = day.leave_category_id ? leaveParamMap.get(day.leave_category_id) : null;
                const status = parseInt(day.status);

                const isWeeklyOff = offDays.weeklyOffList.find(wo => wo.date === dayKey);
                const isHoliday = offDays.holidayList.find(h => dayjs(h.date).format('YYYY-MM-DD') === dayKey);
                const lwpBasis = employeeSalaryTemplate?.lwp_calculation_basis || 'WORKING_DAYS';

                switch (status) {
                    case 0: case 12:
                        if (lwpBasis === 'WORKING_DAYS') {
                            if (!isWeeklyOff && !isHoliday) {
                                splitCounter[segmentKey].present++;
                            }
                        } else {
                            splitCounter[segmentKey].present++;
                        }
                        break;
                    case 1: case 13:
                        splitCounter[segmentKey].half++;
                        if (catInfo) {
                            if (!catInfo.is_paid) splitCounter[segmentKey].unpaidLeave += 0.5;
                            else splitCounter[segmentKey].leave += 0.5;
                        } else {
                            splitCounter[segmentKey].uncategorizedHalf++;
                        }
                        break;
                    case 4:
                        splitCounter[segmentKey].holiday++;
                        attendanceHolidayDates.add(dayKey);
                        break;
                    case 5:
                        splitCounter[segmentKey].absent++;
                        break;
                    case 6:
                        if (catInfo) {
                            if (!catInfo.is_paid) splitCounter[segmentKey].unpaidLeave++;
                            else splitCounter[segmentKey].leave++;
                        } else {
                            splitCounter[segmentKey].leave++;
                        }
                        break;
                }
            });

            (offDays.goneHolidayList || []).forEach(h => {
                const holidayDate = dayjs(h.date).format('YYYY-MM-DD');
                if (attendanceHolidayDates.has(holidayDate)) return;
                const segmentKey = dayjs(holidayDate).isBefore(employeeEffectiveDate, 'day') ? 'before' : 'after';
                splitCounter[segmentKey].holiday++;
            });

            const beforePayable = splitCounter.before.present + (splitCounter.before.half * 0.5) + splitCounter.before.leave + splitCounter.before.holiday;
            const afterPayable = splitCounter.after.present + (splitCounter.after.half * 0.5) + splitCounter.after.leave + splitCounter.after.holiday;

            salarySplitInfo.beforePayable = beforePayable;
            salarySplitInfo.afterPayable = afterPayable;
            salarySplitInfo.splitCounter = splitCounter;

            const oldDaily = oldMonthlyGross / denominator;
            const newDaily = newMonthlyGross / denominator;

            splitCurrentGross = (oldDaily * beforePayable) + (newDaily * afterPayable);
            splitLwpDeduction = (oldDaily * (splitCounter.before.absent + (splitCounter.before.uncategorizedHalf * 0.5) + splitCounter.before.unpaidLeave))
                + (newDaily * (splitCounter.after.absent + (splitCounter.after.uncategorizedHalf * 0.5) + splitCounter.after.unpaidLeave));
        }
    }

    let perDaySalary = monthlyGross / (daysInCalculation || 1);
    let perHourSalary = perDaySalary / unitWorkingHours;

    if (salaryType === "Daily") {
        // For Daily: Gross is based on worked days + paid off days
        perDaySalary = dailyRate;
        perHourSalary = dailyRate / unitWorkingHours;
        // Total earnings for the month based on daily rate
        const totalPayableDays = totalPresentDays + leaveDays + holidays + weeklyOffs;
        monthlyGross = dailyRate * totalPayableDays;
    } else if (salaryType === "Hourly") {
        // For Hourly: Gross is based on total worked minutes
        perHourSalary = hourlyRate;
        perDaySalary = hourlyRate * unitWorkingHours;
        monthlyGross = hourlyRate * (totalWorkedMins / 60);
    }

    if (salaryType === "Monthly") {
        if (splitCurrentGross === null) {
            splitCurrentGross = (monthlyGross / (daysInCalculation || 1)) * payableDaysValue;
        }
        if (splitLwpDeduction === null) {
            splitLwpDeduction = (totalLWP * perDaySalary);
        }
    }

    const lwpDeductionTotal = salaryType === "Monthly" ? splitLwpDeduction : 0;

    // Check if Overtime should be included in total earnings based on attendance configuration
    const activeAttendanceTemplate = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
    const includeOTInTotal = activeAttendanceTemplate ? (activeAttendanceTemplate.include_overtime_in_total === true || activeAttendanceTemplate.include_overtime_in_total === 'true') : false;
    const otAmount = includeOTInTotal ? totalOTAmount : 0;

    // Step E: Use advances, incentives and reimbursements from employee include (already fetched)
    const incentives = employee.employeeIncentive || [];
    const advances = employee.employeeAdvances || [];
    const reimbursements = employee.reimbursements || [];

    const totalIncentive = incentives.reduce((sum, i) => sum + parseFloat(i.amount || 0), 0);
    const totalReimbursement = reimbursements.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

    // Create overtime history from attendance records
    const overtimeHistory = attendanceRecords
        .filter(day => parseFloat(day.overtime_minutes || 0) > 0 || parseFloat(day.overtime_amount || 0) > 0)
        .map(day => ({
            type: "overtime",
            id: day.id,
            date: day.attendance_date,
            minutes: parseInt(day.overtime_minutes || 0),
            amount: parseFloat(day.overtime_amount || 0),
            note: day.note || '',
            overtime_data: day.overtime_data || null
        }));

    // Create fine history from attendance records
    const fineHistory = attendanceRecords
        .filter(day => parseFloat(day.fine_amount || 0) > 0)
        .map(day => ({
            type: "fine",
            id: day.id,
            date: day.attendance_date,
            amount: parseFloat(day.fine_amount || 0),
            note: day.note || '',
            fine_data: day.fine_data || null
        }));

    // Fetch Payment History for the month
    const paymentHistories = await commonQuery.findAllRecords(PaymentHistory, {
        employee_id,
        month,
        year,
        status: { [Op.ne]: 2 }
    }, {
        attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'payment_type']
    }, transaction);

    // Step E.1: Fetch Approved Encashment Requests (all unsettled, no month/year filter)
    const encashments = await commonQuery.findAllRecords(LeaveRequest, {
        employee_id,
        approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
        is_encashment: true,
        request_type: 'ENCASHMENT',
        is_settled_encashment: false,
        status: 0
    }, {
        include: [{
            model: LeaveTemplateCategory,
            as: "category",
            attributes: ['leave_category_name']
        }]
    }, transaction);

    const totalEncashedDays = encashments.reduce((sum, e) => sum + parseFloat(e.total_days || 0), 0);
    const encashmentAmount = totalEncashedDays * perDaySalary;

    // Step F: Prepare Detailed Breakdown
    const earnings = [], deductions = [], statutory = {}, employer = {};
    let takeHomeEarnings = 0, totalDeductions = 0, bonusData = null;

    // Note: Encashments are tracked separately in encashment_history, not added to earnings

    // Calculate current pro-rated gross/ctc base for formulas to use current amounts
    const { roundedAmount: roundedCurrentGross } = applyRounding((splitCurrentGross !== null ? splitCurrentGross : ((monthlyGross / (daysInCalculation || 1)) * payableDaysValue)), roundOffType);
    const currentGross = roundedCurrentGross;

    // Values map for formula evaluation - initialize with globals
    const valuesMap = {
        BASIC: 0,
        GROSS: currentGross,
        CTC: currentGross,
        CANTEEN_ATTENDANCE: lunchCount,
        DAYS_IN_MONTH: daysInMonth,
        PRESENT_DAYS: totalPresentDays,
        ABSENT_DAYS: absentDays,
        PAYABLE_DAYS: payableDaysValue
    };

    // Pre-process components and pre-populate valuesMap with nominal amounts
    const processedComponents = rawComponents.map(trans => {
        const isModel = typeof trans.get === 'function';
        const plain = isModel ? trans.get({ plain: true }) : trans;
        const comp = plain.component || plain.SalaryComponent || (isModel ? trans.get('component') : null);

        if (comp) {
            const nameKey = comp.component_name.toUpperCase().replace(/\s+/g, '_');
            const cleanKey = comp.component_name.toUpperCase().trim();
            const amount = parseFloat(plain.monthly_amount || 0);

            // Add both normalized and original name keys to valuesMap as initial nominal amounts
            if (valuesMap[nameKey] === undefined) valuesMap[nameKey] = amount;
            if (valuesMap[cleanKey] === undefined) valuesMap[cleanKey] = amount;
        }

        return { plain, comp };
    });
    // First pass to find Basic (many formulas depend on it)
    processedComponents.forEach(({ plain, comp }) => {
        if (comp && (comp.component_name.toLowerCase() === 'basic' || comp.component_name.toLowerCase().includes('system basic'))) {
            const calcType = (plain.calculation_type || comp.calculation_type || 'FIXED').toUpperCase();
            const formula = plain.formula || comp.formula;
            const percentageOf = (plain.percentage_of || comp.percentage_of || 'GROSS').toUpperCase();
            const percentageVal = parseFloat(plain.percentage_value || comp.percentage_value || 0);

            let amount = parseFloat(plain.monthly_amount || 0);
            if (calcType === 'FORMULA' && formula) {
                amount = evaluateComponentFormula(formula, valuesMap);
            } else if (calcType === 'PERCENTAGE' && percentageVal > 0) {
                const baseValue = valuesMap[percentageOf] || valuesMap.GROSS || 0;
                amount = (baseValue * percentageVal) / 100;
            }

            // Apply Attendance/LWP Impact to Basic immediately in Pass 1
            let actualAmount = amount;
            if (salarySplitInfo.isActive) {
                const oldComponentMonthlyAmount = salarySplitInfo.newMonthlyGross > 0 ? (amount * (salarySplitInfo.oldMonthlyGross / salarySplitInfo.newMonthlyGross)) : 0;
                const newComponentMonthlyAmount = amount;
                const oldDaily = oldComponentMonthlyAmount / (daysInCalculation || 1);
                const newDaily = newComponentMonthlyAmount / (daysInCalculation || 1);

                if (calcType === 'ATTENDANCE_BASED') {
                    actualAmount = (oldDaily * salarySplitInfo.beforePayable) + (newDaily * salarySplitInfo.afterPayable);
                } else if (calcType !== 'FIXED' && (comp.is_lwp_impacted || plain.is_lwp_impacted)) {
                    const isAlreadyProRated = (calcType === 'PERCENTAGE' && ['BASIC', 'GROSS', 'CTC'].includes(percentageOf)) || (calcType === 'FORMULA' && (formula.includes('BASIC') || formula.includes('GROSS') || formula.includes('CTC')));
                    if (!isAlreadyProRated) {
                        const beforeLWP = salarySplitInfo.splitCounter.before.absent + (salarySplitInfo.splitCounter.before.uncategorizedHalf * 0.5) + salarySplitInfo.splitCounter.before.unpaidLeave;
                        const afterLWP = salarySplitInfo.splitCounter.after.absent + (salarySplitInfo.splitCounter.after.uncategorizedHalf * 0.5) + salarySplitInfo.splitCounter.after.unpaidLeave;

                        const oldSegmentVal = (oldComponentMonthlyAmount * (salarySplitInfo.daysBefore / (daysInCalculation || 1))) - (oldDaily * beforeLWP);
                        const newSegmentVal = (newComponentMonthlyAmount * (salarySplitInfo.daysAfter / (daysInCalculation || 1))) - (newDaily * afterLWP);
                        actualAmount = oldSegmentVal + newSegmentVal;
                    }
                } else if (calcType === 'FIXED') {
                    actualAmount = (oldDaily * salarySplitInfo.daysBefore) + (newDaily * salarySplitInfo.daysAfter);
                }
            } else if (salaryType === "Hourly") {
                const totalPossibleHours = daysInCalculation * unitWorkingHours;
                const workedHours = totalWorkedMins / 60;
                const hourRatio = totalPossibleHours > 0 ? workedHours / totalPossibleHours : 0;
                actualAmount = (calcType !== 'FIXED') ? (amount * hourRatio) : amount;
            } else {
                if (calcType === 'ATTENDANCE_BASED') {
                    actualAmount = (amount / daysInCalculation) * payableDaysValue;
                } else if (calcType !== 'FIXED' && (comp.is_lwp_impacted || plain.is_lwp_impacted)) {
                    // Only apply LWP impact if not already pro-rated via percentage/formula base
                    const isAlreadyProRated = (calcType === 'PERCENTAGE' && ['BASIC', 'GROSS', 'CTC'].includes(percentageOf)) || (calcType === 'FORMULA' && (formula.includes('BASIC') || formula.includes('GROSS') || formula.includes('CTC')));
                    if (!isAlreadyProRated) {
                        actualAmount = amount - (totalLWP * (amount / daysInCalculation));
                    }
                }
            }

            // Apply Company Rounding to Basic
            const { roundedAmount: roundedBasic } = applyRounding(actualAmount, roundOffType);
            actualAmount = roundedBasic;
            valuesMap.BASIC = actualAmount;

            // Also update by component name in valuesMap
            const nameKey = comp.component_name.toUpperCase().replace(/\s+/g, '_');
            const cleanKey = comp.component_name.toUpperCase().trim();
            valuesMap[nameKey] = actualAmount;
            valuesMap[cleanKey] = actualAmount;
        }
    });

    processedComponents.forEach(({ plain, comp }) => {
        if (!comp) return;

        const calcType = (plain.calculation_type || comp.calculation_type || 'FIXED').toUpperCase();
        const formula = plain.formula || comp.formula;
        const percentageOf = (plain.percentage_of || comp.percentage_of || 'BASIC').toUpperCase();
        const percentageVal = parseFloat(plain.percentage_value || comp.percentage_value || 0);

        let amount = parseFloat(plain.monthly_amount || 0);

        if (calcType === 'FORMULA' && formula) {
            amount = evaluateComponentFormula(formula, valuesMap);
        } else if (calcType === 'PERCENTAGE' && percentageVal > 0) {
            const baseValue = valuesMap[percentageOf] || valuesMap.BASIC || 0;
            amount = (baseValue * percentageVal) / 100;
        }

        // Calculate actual pro-rated amount (Attendance/LWP Impact)
        let actualAmount = amount;
        const isFoodComp = comp.component_name.toLowerCase().includes('food') || comp.component_name.toLowerCase().includes('canteen');

        if (salarySplitInfo.isActive) {
            const oldComponentMonthlyAmount = salarySplitInfo.newMonthlyGross > 0 ? (amount * (salarySplitInfo.oldMonthlyGross / salarySplitInfo.newMonthlyGross)) : 0;
            const newComponentMonthlyAmount = amount;
            const oldDaily = oldComponentMonthlyAmount / (daysInCalculation || 1);
            const newDaily = newComponentMonthlyAmount / (daysInCalculation || 1);

            if (calcType === 'ATTENDANCE_BASED') {
                actualAmount = (oldDaily * salarySplitInfo.beforePayable) + (newDaily * salarySplitInfo.afterPayable);
            } else if (calcType !== 'FIXED' && (comp.is_lwp_impacted || plain.is_lwp_impacted) && !isFoodComp) {
                // Only apply LWP impact if not already pro-rated via percentage/formula base
                const isAlreadyProRated = (calcType === 'PERCENTAGE' && ['BASIC', 'GROSS', 'CTC'].includes(percentageOf)) || (calcType === 'FORMULA' && formula && (formula.includes('BASIC') || formula.includes('GROSS') || formula.includes('CTC')));
                if (!isAlreadyProRated) {
                    const beforeLWP = salarySplitInfo.splitCounter.before.absent + (salarySplitInfo.splitCounter.before.uncategorizedHalf * 0.5) + salarySplitInfo.splitCounter.before.unpaidLeave;
                    const afterLWP = salarySplitInfo.splitCounter.after.absent + (salarySplitInfo.splitCounter.after.uncategorizedHalf * 0.5) + salarySplitInfo.splitCounter.after.unpaidLeave;

                    const oldSegmentVal = (oldComponentMonthlyAmount * (salarySplitInfo.daysBefore / (daysInCalculation || 1))) - (oldDaily * beforeLWP);
                    const newSegmentVal = (newComponentMonthlyAmount * (salarySplitInfo.daysAfter / (daysInCalculation || 1))) - (newDaily * afterLWP);
                    actualAmount = oldSegmentVal + newSegmentVal;
                }
            } else if (calcType === 'FIXED' && !isFoodComp) {
                actualAmount = (oldDaily * salarySplitInfo.daysBefore) + (newDaily * salarySplitInfo.daysAfter);
            }
        } else if (salaryType === "Hourly") {
            const totalPossibleHours = daysInCalculation * unitWorkingHours;
            const workedHours = totalWorkedMins / 60;
            const hourRatio = totalPossibleHours > 0 ? workedHours / totalPossibleHours : 0;
            if (calcType !== 'FIXED' && !isFoodComp) {
                actualAmount = amount * hourRatio;
            } else {
                actualAmount = amount;
            }
        } else {
            if (calcType === 'ATTENDANCE_BASED') {
                actualAmount = (amount / daysInCalculation) * payableDaysValue;
            } else if (calcType !== 'FIXED' && (comp.is_lwp_impacted || plain.is_lwp_impacted) && !isFoodComp) {
                // Only apply LWP impact if not already pro-rated via percentage/formula base
                const isAlreadyProRated = (calcType === 'PERCENTAGE' && ['BASIC', 'GROSS', 'CTC'].includes(percentageOf)) || (calcType === 'FORMULA' && formula && (formula.includes('BASIC') || formula.includes('GROSS') || formula.includes('CTC')));
                if (!isAlreadyProRated) {
                    actualAmount = amount - (totalLWP * (amount / daysInCalculation));
                }
            }
        }

        // Apply Company Rounding to individual component
        const { roundedAmount: roundedCompAmount } = applyRounding(actualAmount, roundOffType);
        actualAmount = roundedCompAmount;

        const nameKey = comp.component_name.toUpperCase().replace(/\s+/g, '_');
        const cleanKey = comp.component_name.toUpperCase().trim();
        valuesMap[nameKey] = actualAmount;
        valuesMap[cleanKey] = actualAmount;

        // Ensure BASIC is always up to date if it's encountered here
        if (comp.component_name.toLowerCase() === 'basic' || comp.component_name.toLowerCase().includes('system basic')) {
            valuesMap.BASIC = actualAmount;
        }

        const isEmployer = plain.is_employer_contribution === true || plain.is_employer_contribution === 'true' || comp.component_type === 'EMPLOYER_CONTRIBUTION';

        if (isEmployer) {
            if (!skipStatutory) {
                employer[comp.component_name] = (employer[comp.component_name] || 0) + amount;
            }
            return;
        }
        if (comp.is_statutory) {
            if (!skipStatutory) {
                statutory[comp.component_name] = (statutory[comp.component_name] || 0) + amount;
                if (comp.component_type === "DEDUCTION") {
                    totalDeductions += amount;
                    deductions.push({ name: comp.component_name, amount: amount.toFixed(2), is_statutory: true });
                } else {
                    takeHomeEarnings += amount;
                    earnings.push({ name: comp.component_name, amount: amount.toFixed(2), actual_amount: amount, is_statutory: true });
                }
            }
            return;
        }
        if (comp.component_type === "EARNING" || comp.component_type === "VARIABLE_EARNING") {
            let finalAmount = actualAmount;

            earnings.push({
                name: comp.component_name,
                amount: finalAmount.toFixed(2),
                actual_amount: finalAmount
            });

            takeHomeEarnings += finalAmount;
        } else if (comp.component_type === "DEDUCTION") {
            const isFoodComp = comp.component_name.toLowerCase().includes('food') || comp.component_name.toLowerCase().includes('canteen');
            // Extract base rate from formula for food components
            let rateValue = parseFloat(plain.monthly_amount || amount || 0);
            if (isFoodComp && (plain.formula || comp.formula)) {
                const formulaStr = plain.formula || comp.formula;
                const rateMap = { ...valuesMap, CANTEEN_ATTENDANCE: 1 };

                const calculatedRate = evaluateComponentFormula(formulaStr, rateMap);
                if (calculatedRate > 0) {
                    rateValue = calculatedRate;
                }
            }

            deductions.push({
                name: comp.component_name,
                amount: actualAmount.toFixed(2),
                is_food: isFoodComp,
                meal_count: lunchCount,
                rate: rateValue
            });
            totalDeductions += actualAmount;
        } else if (comp.component_type === "BENEFIT") {
            earnings.push({
                name: comp.component_name,
                amount: actualAmount.toFixed(2),
                actual_amount: actualAmount,
                is_benefit: true
            });
            takeHomeEarnings += actualAmount;
        }
    });


    // Add OT and Incentives
    if (otAmount > 0) {
        earnings.push({ name: "Overtime", amount: otAmount.toFixed(2), is_ot: true });
        takeHomeEarnings += otAmount;
    }

    // Add single Incentive earning with total amount
    if (totalIncentive > 0) {
        earnings.push({ name: "Incentive", amount: totalIncentive.toFixed(2), actual_amount: totalIncentive, is_incentive: true });
        takeHomeEarnings += totalIncentive;
    }

    // Add reimbursement to takeHomeEarnings (but not to earnings array to avoid storing in earning_details)
    if (totalReimbursement > 0) {
        takeHomeEarnings += totalReimbursement;
    }

    // Remove individual incentive additions from the loop below
    // incentives.forEach(inc => {
    //     const amt = parseFloat(inc.amount || 0);
    //     earnings.push({ name: inc.incentiveType?.name || "Incentive", base_amount: amt, actual_amount: amt, is_adjustment: true });
    //     takeHomeEarnings += amt;
    // });

    if (totalFine > 0) {
        deductions.push({ name: "Fines", amount: totalFine.toFixed(2), is_fine: true });
        totalDeductions += totalFine;
    }

    // Add advances to deductions
    // if (totalAdvance > 0) {
    //     deductions.push({ name: "Advance", amount: parseFloat(totalAdvance.toFixed(2)), is_advance: true });
    //     totalDeductions += totalAdvance;
    // }

    // Step G: Process Statutory Config (PF, ESI, PT, LWF)
    if (template.statutory_config && !skipStatutory) {
        const sc = template.statutory_config;

        const addStatRecord = (name, amount, isEmployer = false) => {
            if (!amount || amount <= 0) return;
            if (isEmployer) {
                if (!employer[name]) employer[name] = parseFloat(amount);
            } else {
                if (!statutory[name]) {
                    statutory[name] = parseFloat(amount);
                    if (!deductions.find(d => d.name === name)) {
                        deductions.push({ name, amount: amount.toFixed(2), is_statutory: true });
                        totalDeductions += parseFloat(amount);
                    }
                }
            }
        };

        // Employee Shares
        if (sc.employee_pf?.enabled) {
            const pfResult = PFService.calculatePF(valuesMap.BASIC || 0, {
                pf_calculation_type: sc.employee_pf.calculation_type,
                pf_manual_amount: sc.employee_pf.manual_amount,
                restrict_to_ceiling: sc.employee_pf.restrict_to_ceiling
            });
            addStatRecord("Employee PF", pfResult.employee_pf, false);
        }
        if (sc.employee_esi?.enabled) addStatRecord("Employee ESI", sc.employee_esi.amount, false);
        if (sc.pt?.enabled) addStatRecord("Professional Tax", sc.pt.amount, false);
        if (sc.employee_lwf?.enabled) addStatRecord("Employee LWF", sc.employee_lwf.amount, false);

        // Employer Shares
        if (sc.employer_pf?.enabled) {
            const pfResult = PFService.calculatePF(valuesMap.BASIC || 0, {
                pf_calculation_type: sc.employer_pf.calculation_type,
                pf_manual_amount: sc.employer_pf.manual_amount,
                restrict_to_ceiling: sc.employer_pf.restrict_to_ceiling
            });
            addStatRecord("Employer PF", pfResult.employer_pf, true);

            // If PF Admin/EDLI charges are calculated via service
            if (sc.pf_edli_admin?.enabled) {
                addStatRecord("PF EDLI/Admin", pfResult.admin_charges + pfResult.edli_amount, true);
            }
        }
        if (sc.employer_esi?.enabled) addStatRecord("Employer ESI", sc.employer_esi.amount, true);
        if (sc.employer_lwf?.enabled) addStatRecord("Employer LWF", sc.employer_lwf.amount, true);
        if (sc.pf_edli_admin?.enabled) addStatRecord("PF EDLI/Admin", sc.pf_edli_admin.amount, true);

        // Gratuity Provision (Employer Side)
        if (sc.gratuity?.enabled) {
            const joiningDate = dayjs(employee.joining_date);
            const payrollDate = dayjs(startDate);
            const serviceYears = payrollDate.diff(joiningDate, 'year', true);

            if (serviceYears >= 5) {
                const basic = valuesMap.BASIC || 0;
                const { roundedAmount: roundedGratuity } = applyRounding(basic * 0.0481, roundOffType);
                const amount = roundedGratuity;
                addStatRecord("Gratuity Provision", amount, true);
            }
        }

        // Leave Encashment Provision (Employer Side)
        if (sc.leave_encashment?.enabled) {
            const basic = valuesMap.BASIC || 0;
            const baseAmount = sc.leave_encashment.amount || basic;
            const calcType = sc.leave_encashment.calculation_type || 'Attendance';

            let amount = 0;
            if (calcType === 'Fixed') {
                amount = sc.leave_encashment.amount || 0;
            } else if (calcType === 'Attendance') {
                // amount / workingday * 1.25 (roughly 4.81% of monthly)
                const { roundedAmount: roundedEncashment } = applyRounding(baseAmount * 0.0481, roundOffType);
                amount = roundedEncashment;
            }
            addStatRecord("Leave Encashment Provision", amount, true);
        }

        // Statutory Bonus Provision & Initialization
        bonusData = null;
        if (sc.bonus?.enabled) {
            const basic = valuesMap.BASIC || 0;
            const percentage = parseFloat(sc.bonus.percentage);
            const paymentFrequency = sc.bonus.payment_frequency || 'Yearly';
            const payoutMonth = parseInt(sc.bonus.payout_month || 11);

            // Calculate current month's provision
            const { roundedAmount: roundedBonus } = applyRounding(basic * (percentage / 100), roundOffType);
            const currentMonthBonus = roundedBonus;

            // Query previous finalized payslips to find accumulated bonus since last payout
            let pastAccrued = 0;
            let lastPayoutPayslipId = null;

            const pastPayslips = await commonQuery.findAllRecords(Payslip, {
                employee_id,
                status: { [Op.in]: [1, 3] } // Finalized or Paid
            }, {
                order: [['year', 'DESC'], ['month', 'DESC']]
            }, transaction);

            const accruedPayslips = [];
            for (const ps of pastPayslips) {
                const earningDetails = ps.earning_details || {};
                const hasBonusPaid = earningDetails["Statutory Bonus"] || earningDetails["Statutory_Bonus"] || earningDetails["bonus"] || earningDetails["Bonus"];

                if (hasBonusPaid && parseFloat(hasBonusPaid) > 0) {
                    lastPayoutPayslipId = ps.id;
                    break; // Stop going further back as this was the last payout
                }

                const employerDetails = ps.employer_details || {};
                const provision = employerDetails["Bonus Provision"] || employerDetails["Bonus_Provision"] || employerDetails["Bonus Accrued"] || 0;
                pastAccrued += parseFloat(provision);
                accruedPayslips.push({
                    payslip_id: ps.id,
                    month: ps.month,
                    year: ps.year,
                    provision: parseFloat(provision)
                });
            }

            let accumulatedBonus = pastAccrued + currentMonthBonus;
            if (options.bonus_override_amount !== undefined && options.bonus_override_amount !== null && !isNaN(parseFloat(options.bonus_override_amount))) {
                accumulatedBonus = parseFloat(options.bonus_override_amount);
            }

            bonusData = {
                enabled: true,
                percentage,
                payment_frequency: paymentFrequency,
                payout_month: payoutMonth,
                current_month_bonus: currentMonthBonus,
                past_accrued: pastAccrued,
                accumulated_bonus: accumulatedBonus,
                last_payout_payslip_id: lastPayoutPayslipId,
                accrued_payslips_count: accruedPayslips.length
            };

            // Determine if we should pay/initialize the bonus in this payslip
            const isPayoutMonth = paymentFrequency === 'Yearly' && parseInt(payoutMonth) === parseInt(month);

            let shouldPayBonus = false;
            if (options.initialize_bonus !== undefined && options.initialize_bonus !== null) {
                // Explicit user override (either true or false) takes absolute precedence
                shouldPayBonus = !!options.initialize_bonus;
            } else {
                // Default scheduled behavior
                shouldPayBonus = (paymentFrequency === 'Monthly') || isPayoutMonth;
            }

            if (shouldPayBonus) {
                bonusData.initialized_this_period = true;

                // Add "Statutory Bonus" to earnings array
                earnings.push({
                    name: "Statutory Bonus",
                    amount: accumulatedBonus.toFixed(2),
                    actual_amount: accumulatedBonus,
                    is_bonus: true
                });
                takeHomeEarnings += accumulatedBonus;
            }

            // Always add the monthly provision to employer side (unless skipStatutory is true and we aren't initializing)
            if (!skipStatutory || shouldPayBonus) {
                addStatRecord("Bonus Provision", currentMonthBonus, true);
            }
        }
    }


    // Step H: Calculate Statutory TDS (Tax Deducted at Source)
    let tdsAmount = 0;
    let tdsPercentage = 0;
    let tdsCalculationData = null;
    if (template.statutory_config && template.statutory_config.tds && template.statutory_config.tds.enabled && !skipStatutory) {
        const tdsConfig = template.statutory_config.tds;

        // India Financial Year Logic (April to March)
        const currentMonth = parseInt(month);
        const currentYear = parseInt(year);
        let fyStartYear = currentMonth < 4 ? currentYear - 1 : currentYear;

        // Calculate months left in FY (including current)
        // monthsSpent: April=0, May=1... March=11
        let monthsSpent = (currentMonth >= 4) ? (currentMonth - 4) : (currentMonth + 8);
        let monthsRemaining = 12 - monthsSpent;

        // Fetch already deducted TDS in this FY
        // This ensures tax is spread over remaining months if it wasn't deducted correctly before
        const previousPayslips = await Payslip.findAll({
            where: {
                employee_id,
                [Op.or]: [
                    { year: fyStartYear, month: { [Op.gte]: 4 } },
                    { year: fyStartYear + 1, month: { [Op.lte]: 3 } }
                ]
            },
            transaction
        });

        let taxPaidAlready = 0;
        let actualYTD = 0;
        previousPayslips.forEach(p => {
            // Only count months strictly BEFORE the current period
            if (p.year < currentYear || (p.year === currentYear && p.month < currentMonth)) {
                const statutoryDetails = p.statutory_details || {};
                taxPaidAlready += parseFloat(statutoryDetails['Income Tax (TDS)'] || 0);
                actualYTD += parseFloat(p.total_earnings || p.break_down?.total_earnings || 0);
            }
        });

        if (tdsConfig.calculation_type === 'Manual Amount') {
            tdsAmount = parseFloat(tdsConfig.amount || 0);
            tdsCalculationData = { calculation_type: 'Manual', amount: tdsAmount, monthlyTDS: tdsAmount };
        } else if (tdsConfig.calculation_type !== 'None') {
            // Advanced Projection Approach:
            // Estimated Annual Gross = Actual YTD (from prev months) + Current Month Actual + Projected Remaining Months
            const currentMonthActual = takeHomeEarnings;
            const projectedRemaining = parseFloat(template.ctc_monthly || 0) * (monthsRemaining - 1);

            const annualGross = actualYTD + currentMonthActual + projectedRemaining;

            // Map regime from config - support both 'regime' field and 'calculation_type' containing regime name
            let regime = 'new_regime';
            if (tdsConfig.regime) {
                regime = tdsConfig.regime === 'OLD' ? 'old_regime' : 'new_regime';
            } else if (tdsConfig.calculation_type) {
                const calcType = tdsConfig.calculation_type.toLowerCase();
                if (calcType.includes('old')) {
                    regime = 'old_regime';
                } else if (calcType.includes('new')) {
                    regime = 'new_regime';
                }
                // 'System Calculated' or 'Smart System Calculated' will default to new_regime
            }

            // Deductions/Exemptions from config (80C, 80D, etc.)
            const exemptions = parseFloat(tdsConfig.exemptions || 0);

            const tdsResult = calculateTDS(annualGross, regime, exemptions, taxPaidAlready, monthsRemaining);

            tdsAmount = tdsResult.monthlyTDS;
            tdsPercentage = tdsResult.percentage;
            tdsCalculationData = tdsResult;
        }
    }

    if (tdsAmount > 0) {
        statutory["Income Tax (TDS)"] = tdsAmount;
        statutory["Income Tax (TDS) %"] = tdsPercentage;
        deductions.push({ name: "Income Tax (TDS)", amount: tdsAmount.toFixed(2), is_statutory: true });
        totalDeductions += tdsAmount;
    }
    const netPayable = takeHomeEarnings - totalDeductions;

    // Apply rounding based on company settings
    const { roundedAmount: roundedNetPayable, roundOffAmount } = applyRounding(netPayable, roundOffType);

    // Calculate totals for breakdown arrays
    const totalEarningsBreakdown = earnings.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
    const totalDeductionsBreakdown = deductions.reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);

    // Calculate payment sums
    const salaryPayments = paymentHistories.filter(ph => ph.payment_type === 'Salary');
    const salarySum = salaryPayments.reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0);
    const advanceSum = (employee.employeeAdvances || []).reduce((sum, ea) => sum + parseFloat(ea.amount || 0), 0);

    return {
        employee: {
            id: employee.id,
            name: employee.first_name,
            code: employee.employee_code,
            template: template.template_name,
            template_id: template.id,
            designation: employee.designation?.designation_name,
            joining_date: employee.joining_date
        },
        period: { month, year, daysInMonth, daysInCalculation, monthName: formatDateTime(new Date(year, month - 1, 1), "MMMM") },
        attendance: { presentDays, halfDays, totalPresentDays, absentDays, leaveDays, unpaidLeaveDays, compoffLeaveDays, weeklyOffs, holidays, totalWeeklyOffs: offDays.totalWeeklyOffs, totalHolidays: offDays.totalHolidays, goneWeeklyOffs: offDays.goneWeeklyOffs, goneHolidays: offDays.goneHolidays, totalLWP, lunchCount, lunchHistory, payableDays: parseFloat(payableDaysValue).toFixed(1), actualDaysValue, leave_category_details: leaveCategoryDetails },
        salary: {
            ctc_monthly: monthlyGross,
            perDaySalary: perDaySalary.toFixed(2),
            lwpDeduction: lwpDeductionTotal.toFixed(2),
            totalFine: totalFine,
            overtimeAmount: otAmount.toFixed(2),
            incentiveAmount: totalIncentive,
            reimbursementAmount: totalReimbursement,
            // advanceAmount: totalAdvance.toFixed(2),
            encashmentAmount: encashmentAmount,
            tdsPercentage: tdsPercentage.toFixed(2),
            salary_split: salarySplitInfo.effectiveDate ? {
                effective_date: salarySplitInfo.effectiveDate,
                old_ctc_monthly: salarySplitInfo.oldMonthlyGross,
                new_ctc_monthly: salarySplitInfo.newMonthlyGross
            } : null,
            netPayable: roundedNetPayable,
            unroundedNetPayable: netPayable,
            roundOffAmount: roundOffAmount,
            takeHomeEarnings: takeHomeEarnings,
            totalDeductions: totalDeductions
        },
        breakdown: {
            earnings,
            deductions,
            statutory,
            employer,
            total_earnings: totalEarningsBreakdown,
            total_deductions: totalDeductionsBreakdown
        },
        overtime_history: overtimeHistory,
        fine_history: fineHistory,
        reimbursement_history: reimbursements.map(r => ({
            id: r.id,
            amount: r.amount,
            date: r.date,
            description: r.description,
            expense_type: r.expenseType?.name,
        })),
        encashment_history: {
            history: encashments.map(e => ({
                id: e.id,
                days: parseFloat(e.total_days || 0),
                amount: (parseFloat(e.total_days || 0) * perDaySalary).toFixed(2),
                leave_category_id: e.leave_category_id,
                leave_category_name: e.category?.leave_category_name || null,
                request_date: e.start_date
            })),
            sum: encashmentAmount.toFixed(2),
        },
        payment_history: {
            salary: {
                history: salaryPayments.map(ph => ({
                    id: ph.id,
                    amount: ph.amount,
                    payment_mode: ph.payment_mode,
                    payment_date: ph.payment_date,
                    payment_type: ph.payment_type
                })),
                sum: salarySum.toFixed(2)
            },
            advance: {
                history: (employee.employeeAdvances || []).map(ea => ({
                    id: ea.id,
                    amount: ea.amount,
                    payment_mode: ea.payment_mode,
                    payment_date: ea.payment_date,
                    payment_type: 'Advance',
                    adjusted_in_payroll: ea.adjusted_in_payroll
                })),
                sum: advanceSum.toFixed(2)
            },
            grand_total: (salarySum + advanceSum).toFixed(2)
        },
        employee_incentive_history: (employee.employeeIncentive || []).map(advance => advance.get({ plain: true })),
        bonus_data: bonusData,
        // tds_calculation_data: tdsCalculationData,
        // tdsDetails: tdsCalculationData,
        leave_balances: Array.from(leaveParamMap.entries()).map(([catId, info]) => {
            const balanceRecord = leaveBalances.find(lb => lb.leave_category_id === catId);
            return {
                leave_category_id: catId,
                leave_category_name: info.name,
                used_leaves: monthLeaveUsage[catId] || 0,
                balance: balanceRecord ? balanceRecord.pending_leaves : 0
            };
        }),
        meta: { branch_id: employee.branch_id, company_id: employee.company_id }
    };
};

/**
 * Helper to convert an existing Payslip record into the summary format
 * used by the Payroll Processor UI.
 */
const formatPayslipToSummary = async (payslip) => {
    // 1. Attendance Summary Reconstruct
    const daysInCalculation = parseFloat(payslip.days_in_calculation || 0);
    const absentDays = parseFloat(payslip.absent_days || 0);
    const halfDays = parseFloat(payslip.half_days || 0);
    const presentDays = parseFloat(payslip.present_days || 0);
    const leaveDays = parseFloat(payslip.lp_days || 0);
    const unpaidLeaveDays = parseFloat(payslip.ul_days || 0);
    const weeklyOffs = parseFloat(payslip.wo_days || 0);
    const holidays = parseFloat(payslip.ph_days || 0);

    const totalPresentDays = presentDays + (halfDays * 0.5);
    const totalLWP = absentDays + unpaidLeaveDays;

    // 2. Fetch Employee and Template details
    const employeeData = await commonQuery.findOneRecord(Employee, { id: payslip.employee_id }, {
        include: [
            { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
            { model: EmployeeSalaryTemplate, as: 'employeeSalaryTemplate', attributes: ['id', 'lwp_calculation_basis'] }
        ]
    });

    const template = await commonQuery.findOneRecord(EmployeeSalaryTemplate, { id: employeeData.employeeSalaryTemplate?.id || 0 });

    // 3. Period
    const daysInMonth = dayjs(`${payslip.year}-${payslip.month}-01`).daysInMonth();
    const monthName = formatDateTime(new Date(payslip.year, parseInt(payslip.month) - 1, 1), "MMMM");

    // 4. Salary and Totals
    const fixedGross = parseFloat(payslip.fixed_gross || 0);
    const perDaySalary = daysInCalculation > 0 ? (fixedGross / daysInCalculation) : 0;
    const lwpDeduction = totalLWP * perDaySalary;

    const earningDetails = payslip.earning_details || {};
    const deductionDetails = payslip.deduction_details || {};

    const getSum = (details, keywords) => Object.entries(details || {})
        .filter(([name]) => keywords.some(k => name.toLowerCase().includes(k)))
        .reduce((sum, [, val]) => sum + parseFloat(val || 0), 0);

    const totalFine = getSum(deductionDetails, ['fine', 'misc', 'adjustment', 'food']);
    const otAmount = getSum(earningDetails, ['overtime', 'ot']);
    const totalIncentive = getSum(earningDetails, ['incentive', 'bonus']);
    const totalReimbursement = getSum(earningDetails, ['reimbursement']);
    const encashmentAmount = getSum(earningDetails, ['encashment']);
    const advanceAmount = getSum(deductionDetails, ['advance', 'loan']);

    // 6. Payment History
    const paymentHistories = payslip.payment_history?.advances_adjusted || [];

    // 7. Lunch History
    const lunchRecords = await commonQuery.findAllRecords(CanteenAttendance, {
        employee_id: payslip.employee_id,
        date: {
            [Op.between]: [
                dayjs(`${payslip.year}-${payslip.month}-01`).startOf('month').format('YYYY-MM-DD'),
                dayjs(`${payslip.year}-${payslip.month}-01`).endOf('month').format('YYYY-MM-DD')
            ]
        },
        status: { [Op.ne]: 2 }
    });
    const lunchHistory = lunchRecords.map(lr => ({
        date: lr.date,
        time: dayjs(lr.createdAt).format('hh:mm A')
    }));

    // 8. Fetch Incentive and Overtime History
    const startDate = dayjs(`${payslip.year}-${payslip.month}-01`).startOf('month').format('YYYY-MM-DD');
    const endDate = dayjs(`${payslip.year}-${payslip.month}-01`).endOf('month').format('YYYY-MM-DD');

    // Fetch incentive history
    const incentives = await commonQuery.findAllRecords(EmployeeIncentive, {
        employee_id: payslip.employee_id,
        month: payslip.month,
        year: payslip.year,
        status: { [Op.ne]: 2 }
    });

    const employeeIncentiveHistory = incentives.map(inc => ({
        id: inc.id.toString(),
        amount: inc.amount,
        incentive_date: inc.incentive_date,
        month: inc.month,
        year: inc.year
    }));

    // Fetch overtime history from attendance records
    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
        employee_id: payslip.employee_id,
        attendance_date: { [Op.between]: [startDate, endDate] },
        status: { [Op.ne]: 2 }
    }, {}, null, { company_id: true });

    const overtimeHistory = attendanceRecords
        .filter(day => parseFloat(day.overtime_minutes || 0) > 0 || parseFloat(day.overtime_amount || 0) > 0)
        .map(day => ({
            type: "overtime",
            id: day.id,
            date: day.attendance_date,
            minutes: parseInt(day.overtime_minutes || 0),
            amount: parseFloat(day.overtime_amount || 0),
            note: day.note || '',
            overtime_data: day.overtime_data || null
        }));

    const fineHistory = attendanceRecords
        .filter(day => parseFloat(day.fine_minutes || 0) > 0 || parseFloat(day.fine_amount || 0) > 0)
        .map(day => ({
            type: "fine",
            id: day.id,
            date: day.attendance_date,
            minutes: parseInt(day.fine_minutes || 0),
            amount: parseFloat(day.fine_amount || 0),
            note: day.note || '',
            fine_data: day.fine_data || null
        }));

    // 8. Final Summary Object
    return {
        id: payslip.id,
        is_finalized: true,
        employee: {
            id: employeeData.id,
            name: employeeData.first_name,
            code: employeeData.employee_code,
            template: template?.template_name || "N/A",
            template_id: template?.id || 0,
            joining_date: employeeData.joining_date,
            designation: employeeData.designation?.designation_name || "N/A"
        },
        period: {
            month: parseInt(payslip.month),
            year: parseInt(payslip.year),
            daysInMonth,
            daysInCalculation,
            monthName
        },
        attendance: {
            presentDays,
            halfDays,
            totalPresentDays,
            absentDays,
            leaveDays,
            unpaidLeaveDays,
            compoffLeaveDays: 0,
            weeklyOffs,
            holidays,
            totalLWP,
            lunchCount: payslip.lunch_count || 0,
            lunchHistory,
            payableDays: parseFloat(payslip.pd_days || 0).toString(),
            actualDaysValue: daysInCalculation,
            leave_category_details: payslip.leave_details || {}
        },
        salary: {
            ctc_monthly: fixedGross,
            perDaySalary: perDaySalary.toFixed(2),
            lwpDeduction: lwpDeduction.toFixed(2),
            totalFine: totalFine.toFixed(2),
            overtimeAmount: otAmount.toFixed(2),
            incentiveAmount: totalIncentive.toFixed(2),
            reimbursementAmount: totalReimbursement.toFixed(2),
            encashmentAmount: encashmentAmount.toFixed(2),
            advanceAmount: advanceAmount,
            netPayable: parseFloat(payslip.net_salary || 0).toFixed(2),
            roundOffAmount: parseFloat(payslip.round_off_amount || 0).toFixed(2),
            takeHomeEarnings: parseFloat(payslip.paid_gross || 0).toFixed(2),
            total_deductions: parseFloat(payslip.total_deduction || 0).toFixed(2),
            totalDeductions: parseFloat(payslip.total_deduction || 0).toFixed(2)
        },
        breakdown: {
            earnings: payslip.break_down?.earnings || [],
            deductions: payslip.break_down?.deductions || [],
            statutory: payslip.statutory_details || {},
            employer: payslip.employer_details || payslip.break_down?.employer || {},
            total_earnings: parseFloat(payslip.paid_gross || 0).toFixed(2),
            total_deductions: parseFloat(payslip.total_deduction || 0).toFixed(2)
        },
        payment_history: {
            salary: {
                history: payslip.payment_history?.salary_payments || [],
                sum: (payslip.payment_history?.salary_payments || []).reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0).toFixed(2)
            },
            advance: {
                history: (paymentHistories || []).map(ph => ({
                    id: ph.advance_id,
                    amount: ph.amount,
                    payment_mode: ph.payment_mode,
                    payment_date: ph.payment_date,
                    notes: ph.notes
                })),
                sum: (paymentHistories || []).reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0).toFixed(2)
            },
            grand_total: ((payslip.payment_history?.salary_payments || []).reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0) + (paymentHistories || []).reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0)).toFixed(2)
        },
        overtime_history: overtimeHistory,
        fine_history: fineHistory,
        reimbursement_history: payslip.reimbursement_details || [],
        encashment_history: payslip.encashment_details || {},
        employee_incentive_history: employeeIncentiveHistory,
        leave_balances: payslip.leave_balances || [],
    };
};

/**
 * Helper to fetch salary summary (checks for existing payslip first, then fresh calculation)
 */
const fetchSalarySummary = async (employee_id, month, year, options = {}) => {
    // 1. Check if a finalized/paid payslip already exists.
    const existingPayslips = await commonQuery.findAllRecords(Payslip, {
        employee_id,
        month,
        year,
        status: { [Op.in]: [1, 3] } // Finalized or Paid
    }, {
        order: [['id', 'ASC']],
        include: [{
            model: Employee,
            as: "employee",
            attributes: ['id', 'first_name', 'employee_code'],
            include: [{ model: DesignationMaster, as: "designation", attributes: ['designation_name'] }]
        }]
    });

    if (existingPayslips && existingPayslips.length > 0) {
        // Return all payslips if there are multiple
        const summaries = await Promise.all(existingPayslips.map(ps => formatPayslipToSummary(ps)));
        return summaries.length === 1 ? summaries[0] : { multiple: true, payslips: summaries };
    }

    // 2. Otherwise perform fresh calculation based on attendance and template
    return await performSalaryCalculation(employee_id, month, year, null, options);
};

exports.calculateMonthlySalary = async (req, res) => {
    try {
        const { employee_id, month, year, initialize_bonus, bonus_override_amount } = req.body;
        if (!employee_id || !month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee, Month, and Year are required" });
        }

        const summary = await fetchSalarySummary(employee_id, month, year, { skipStatutory: false, initialize_bonus, bonus_override_amount });
        return res.ok(summary);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.calculateMonthlySalaryBulk = async (req, res) => {
    try {
        const { employee_ids, month, year } = req.body;
        if (!employee_ids || !Array.isArray(employee_ids) || !month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee IDs (array), Month, and Year are required" });
        }

        const results = await Promise.all(employee_ids.map(async (id) => {
            try {
                const data = await fetchSalarySummary(id, month, year, { skipStatutory: false });
                return {
                    employee_id: id,
                    success: true,
                    data
                };
            } catch (err) {
                console.error(`Error calculating salary for employee ${id}:`, err);
                return {
                    employee_id: id,
                    success: false,
                    message: err.message
                };
            }
        }));

        return res.ok({
            success_count: results.filter(r => r.success).length,
            failed_count: results.filter(r => !r.success).length,
            results
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Internal helper to finalize a single employee's payroll
 */
const internalFinalizePayroll = async (employee_id, month, year, generate_additional = false, transaction, req, advance_ids_to_adjust = [], net_take_home_pay = null, encashment_ids_to_adjust = [], round_off_amount = null, initialize_bonus = false, bonus_override_amount = null) => {
    const summary = await performSalaryCalculation(employee_id, month, year, transaction, { initialize_bonus, bonus_override_amount });

    // 1. Check if already finalized (Main sequence)
    const existingMain = await commonQuery.findOneRecord(Payslip, {
        employee_id, month, year, status: { [Op.in]: [1, 3] }
    }, {}, transaction);

    if (existingMain && !generate_additional) {
        throw new Error("Main payroll for this month is already finalized. Use 'generate_additional' to create a supplementary payslip.");
    }

    const calculatedNetSalaryAmount = parseFloat(summary.salary?.netPayable || 0) || 0;
    const netSalaryAmount = net_take_home_pay ? parseFloat(net_take_home_pay) : calculatedNetSalaryAmount;
    const paidAmount = parseFloat(summary.payment_history?.salary?.sum || 0) || 0;
    const pendingAmount = Math.max(netSalaryAmount - paidAmount, 0);

    // Create or Update Draft
    const payslipPayload = {
        employee_id,
        month,
        year,
        // Attendance
        days_in_calculation: summary.period.daysInCalculation,
        present_days: summary.attendance.presentDays,
        absent_days: summary.attendance.absentDays,
        half_days: summary.attendance.halfDays,
        pd_days: summary.attendance.payableDays,
        wo_days: summary.attendance.weeklyOffs,
        ph_days: summary.attendance.holidays,
        lp_days: summary.attendance.leaveDays,
        ul_days: summary.attendance.unpaidLeaveDays,
        total_days: summary.period.daysInMonth,
        leave_details: summary.attendance.leave_category_details,
        lunch_count: summary.attendance.lunchCount || 0,

        // Dynamic JSON Components
        salary_template_id: summary.employee.template_id,
        earning_details: (summary.breakdown.earnings || []).reduce((acc, e) => {
            acc[e.name] = e.actual_amount;
            return acc;
        }, {}),
        deduction_details: (summary.breakdown.deductions || []).reduce((acc, d) => {
            acc[d.name] = d.amount;
            return acc;
        }, {}),
        statutory_details: summary.breakdown.statutory || {},
        employer_details: summary.breakdown.employer || {},
        reimbursement_details: summary.reimbursement_history || [],
        encashment_details: {},
        payment_history: {
            ...(summary.payment_history || {}),
            advances_adjusted: []
        },

        // Summary Totals
        fixed_gross: summary.salary.ctc_monthly,
        paid_gross: summary.salary.takeHomeEarnings, // Total Earnings before deductions
        total_deduction: summary.salary.totalDeductions,
        net_salary: net_take_home_pay ? parseFloat(net_take_home_pay) : summary.salary.netPayable,
        round_off_amount: round_off_amount !== null ? parseFloat(round_off_amount) : (summary.salary.roundOffAmount || 0),
        paid_amount: paidAmount,
        pending_amount: pendingAmount,

        break_down: summary.breakdown,
        tds_calculation_data: summary.tds_calculation_data,
        leave_balances: summary.leave_balances,
        status: 1, // Finalized
        user_id: req.user?.id || 0,
        company_id: summary.meta?.company_id || req.user?.company_id,
        branch_id: summary.meta?.branch_id
    };

    // Check for existing draft (for later use)
    const draft = await commonQuery.findOneRecord(Payslip, { employee_id, month, year, status: 0 }, {}, transaction);

    // Process advances first (collect data)
    const advances_adjusted = [];

    if (advance_ids_to_adjust && advance_ids_to_adjust.length > 0) {
        // First, get all pending advances for this employee
        const allPendingAdvances = await commonQuery.findAllRecords(EmployeeAdvance, {
            employee_id,
            status: 0,
            adjusted_in_payroll: false
        }, {}, transaction);

        // Filter to only the IDs that actually exist and are pending
        const validIds = allPendingAdvances
            .filter(a => advance_ids_to_adjust.includes(a.id))
            .map(a => a.id);

        if (validIds.length === 0) {
            throw new Error(`Invalid advance IDs provided. Available pending advance IDs: ${allPendingAdvances.map(a => a.id).join(', ')}`);
        }

        const advanceWhereCondition = {
            employee_id,
            status: 0,
            adjusted_in_payroll: false,
            id: { [Op.in]: validIds }
        };

        const employeeAdvances = await commonQuery.findAllRecords(EmployeeAdvance, advanceWhereCondition, {}, transaction);

        if (employeeAdvances.length > 0) {
            // Update selected advances to mark them as adjusted in payroll
            await commonQuery.updateRecordById(EmployeeAdvance, advanceWhereCondition, { adjusted_in_payroll: true, status: 1 }, transaction);

            // Collect advance details for payment history
            employeeAdvances.forEach(advance => {
                advances_adjusted.push({
                    advance_id: advance.id,
                    amount: advance.amount,
                    payment_date: advance.payment_date,
                    payment_mode: advance.payment_mode,
                    notes: advance.notes
                });
            });
        }
    }

    // Process encashments (collect data)
    let encashmentUpdateData = null;

    if (encashment_ids_to_adjust && encashment_ids_to_adjust.length > 0) {
        const allEncashmentIds = (summary.encashment_history?.history || []).map(e => e.id);
        let encashmentIdsToSettle = allEncashmentIds.filter(id => encashment_ids_to_adjust.includes(id));

        if (encashmentIdsToSettle.length === 0) {
            throw new Error(`Invalid encashment IDs provided. Available encashment IDs: ${allEncashmentIds.join(', ') || 'none'}`);
        }

        if (encashmentIdsToSettle.length > 0) {
            await commonQuery.updateRecordById(
                LeaveRequest,
                { id: { [Op.in]: encashmentIdsToSettle }, employee_id },
                { is_settled_encashment: true },
                transaction
            );

            const settledHistory = summary.encashment_history?.history?.filter(e => encashmentIdsToSettle.includes(e.id)) || [];
            const settledSum = settledHistory.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
            const settledDays = settledHistory.reduce((sum, e) => sum + parseFloat(e.days || 0), 0);

            encashmentUpdateData = {
                history: settledHistory,
                sum: settledSum.toFixed(2),
            };
        }
    }

    // Add collected data to payslip payload
    if (advances_adjusted.length > 0) {
        payslipPayload.payment_history.advances_adjusted = advances_adjusted;
    }
    if (encashmentUpdateData) {
        payslipPayload.encashment_details = encashmentUpdateData;
    }

    // Single create/update at the end with full data
    let finalizedPayslip;
    if (draft) {
        finalizedPayslip = await commonQuery.updateRecordById(Payslip, draft.id, payslipPayload, transaction);
    } else {
        finalizedPayslip = await commonQuery.createRecord(Payslip, payslipPayload, transaction);
    }

    // Lock Attendance Records
    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    const endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    await AttendanceDay.update({ is_locked: true }, {
        where: {
            employee_id,
            attendance_date: { [Op.between]: [startDate, endDate] }
        },
        transaction
    });

    //Send Notification to Employee
    try {
        const targetUser = await commonQuery.findOneRecord(User, { employee_id: employee_id }, {}, transaction);
        if (targetUser) {
            const monthName = dayjs().month(month - 1).format('MMMM');
            await createNotification({
                user_id: targetUser.id,
                title: "Payslip Generated",
                message: `Your payslip for ${monthName} ${year} has been generated. You can now view and download it.`,
                type: "PAYROLL",
                reference_id: finalizedPayslip.id,
                status_code: 0,
                company_id: summary.meta?.company_id || req.user?.company_id,
                branch_id: summary.meta?.branch_id
            }, transaction);
        }
    } catch (notifyErr) {
        console.error("Payslip Notification Error:", notifyErr.message);
    }

    return {
        id: finalizedPayslip.id,
        netPayable: summary.salary.netPayable
    };
};

exports.finalizeMonthlySalary = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { employee_id, month, year, generate_additional = false, advance_ids_to_adjust = [], net_take_home_pay = null, encashment_ids_to_adjust = [], round_off_amount = null, initialize_bonus = false, bonus_override_amount = null } = req.body;
        if (!employee_id || !month || !year) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { message: "Employee, Month, and Year are required" });
        }

        const summaryData = await internalFinalizePayroll(employee_id, month, year, generate_additional, transaction, req, advance_ids_to_adjust, net_take_home_pay, encashment_ids_to_adjust, round_off_amount, initialize_bonus, bonus_override_amount);

        await transaction.commit();
        return res.success("PAYROLL_FINALIZED", {
            message: "Payroll finalized and attendance locked successfully",
            id: summaryData.id,
            netPayable: summaryData.netPayable
        });

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Delete a payslip and unlock associated attendance records
 */
exports.deletePayslip = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.body;
        if (!id) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { message: "Payslip ID is required" });
        }

        const payslip = await commonQuery.findOneRecord(Payslip, id, {}, transaction);
        if (!payslip) {
            await transaction.rollback();
            return res.error("NOT_FOUND", { message: "Payslip not found" });
        }

        if (payslip.status === 3) {
            await transaction.rollback();
            return res.error("NOT_ALLOWED", { message: "Cannot delete a paid payslip." });
        }

        const startDate = dayjs(`${payslip.year}-${payslip.month}-01`).startOf('month').format('YYYY-MM-DD');
        const endDate = dayjs(`${payslip.year}-${payslip.month}-01`).endOf('month').format('YYYY-MM-DD');

        // Reset employee advances that were adjusted in this payslip
        const advancesAdjusted = payslip.payment_history?.advances_adjusted || [];
        if (advancesAdjusted.length > 0) {
            const advanceIds = advancesAdjusted.map(a => a.advance_id);
            await commonQuery.updateRecordById(EmployeeAdvance, {
                id: { [Op.in]: advanceIds },
                employee_id: payslip.employee_id
            }, {
                adjusted_in_payroll: false,
                status: 0
            }, transaction);
        }

        // Reset leave request encashments that were settled in this payslip
        const encashmentsSettled = payslip.encashment_details?.history || [];
        if (encashmentsSettled.length > 0) {
            const encashmentIds = encashmentsSettled.map(e => e.id);
            await commonQuery.updateRecordById(LeaveRequest, {
                id: { [Op.in]: encashmentIds },
                employee_id: payslip.employee_id
            }, {
                is_settled_encashment: false
            }, transaction);
        }

        // Unlock Attendance
        await AttendanceDay.update({ is_locked: false }, {
            where: {
                employee_id: payslip.employee_id,
                attendance_date: { [Op.between]: [startDate, endDate] }
            },
            transaction
        });

        // Hard delete payslip record
        await payslip.destroy({ transaction });

        await transaction.commit();
        return res.success("PAYSLIP_DELETED", { message: "Payslip deleted and attendance records unlocked." });
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.calculateBatchMonthlySalary = async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        const employees = await Employee.findAll({
            where: {
                status: 0,
                staff_type: { [Op.in]: ["Regular", "Trainee"] }
            }
        });

        const summaries = [];
        const errors = [];

        for (const emp of employees) {
            try {
                const summary = await performSalaryCalculation(emp.id, month, year, null, { skipStatutory: false });
                summaries.push(summary);
            } catch (err) {
                errors.push({ employee_id: emp.id, name: emp.first_name, error: err.message });
            }
        }

        return res.ok({
            success_count: summaries.length,
            error_count: errors.length,
            summaries,
            errors
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getEmployeePayslip = async (req, res) => {
    try {
        const { employee_id } = req.body;
        if (!employee_id) {
            return res.error("VALIDATION_ERROR", { message: "Employee ID is required" });
        }

        const payslips = await commonQuery.findAllRecords(Payslip, {
            employee_id,
            status: { [Op.in]: [1, 3] } // Finalized or Paid
        }, {
            order: [['year', 'DESC'], ['month', 'DESC']]
        });

        const formattedList = payslips.map(p => {
            const monthName = formatDateTime(new Date(2000, p.month - 1, 1), "MMM");
            return {
                id: p.id,
                month: p.month,
                year: p.year,
                month_year_string: `${monthName} ${p.year}`,
                ctc: p.fixed_gross || p.paid_gross,
                net_payable: p.net_salary || p.net_payable,
                status: p.status,
                status_text: p.status === 1 ? "Finalized" : "Paid"
            };
        });

        return res.ok(formattedList);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Helper function to process payslip data with calculated sums
 */
const processPayslipData = (payslips) => {
    return payslips.map(payslip => {
        // Calculate earnings sum from break_down.earnings
        const earningsSum = (payslip.break_down?.earnings || [])
            .reduce((sum, earning) => sum + parseFloat(earning.actual_amount || earning.amount || 0), 0);

        // Calculate deductions sum from break_down.deductions
        const regularDeductionsSum = (payslip.break_down?.deductions || [])
            .reduce((sum, deduction) => sum + parseFloat(deduction.amount || 0), 0);

        // Calculate statutory deductions sum from statutory_details
        const statutoryDeductionsSum = Object.values(payslip.statutory_details || {})
            .filter(value => typeof value === 'number' && !String(value).includes('%'))
            .reduce((sum, amount) => sum + parseFloat(amount || 0), 0);

        // Total deductions including statutory
        const totalDeductionsSum = regularDeductionsSum + statutoryDeductionsSum;

        const tdsData = payslip.tds_calculation_data || {};
        const actualTds = parseFloat(payslip.statutory_details?.['Income Tax (TDS)'] || 0);

        return {
            id: payslip.id,
            employee_id: payslip.employee_id,
            employee_name: payslip.employee?.first_name || "",
            employee_code: payslip.employee?.employee_code || "",
            designation: payslip.employee?.designation?.designation_name || "",
            month: payslip.month,
            year: payslip.year,
            pd_days: payslip.pd_days,
            ph_days: payslip.ph_days,
            wo_days: payslip.wo_days,
            wp_days: payslip.wp_days,
            present_days: payslip.present_days,
            absent_days: payslip.absent_days,
            total_days: payslip.total_days,
            lunch_count: payslip.lunch_count,
            paid_gross: payslip.paid_gross,
            total_deduction: payslip.total_deduction,
            net_salary: payslip.net_salary,
            earnings_sum: parseFloat(earningsSum.toFixed(2)),
            deductions_sum: parseFloat(totalDeductionsSum.toFixed(2)),
            paid_amount: parseFloat(payslip.paid_amount || 0),
            pending_amount: parseFloat(payslip.pending_amount || 0),

            // TDS Data
            annual_gross: tdsData.annualGross || 0,
            standard_deduction: tdsData.standardDeduction || 0,
            taxable_income: tdsData.taxableIncome || 0,
            annual_tax: tdsData.annualTax || 0,
            monthly_tds: tdsData.monthlyTDS || 0,
            tds_percentage: tdsData.percentage || 0,
            regime: tdsData.regime || 'new_regime',
            actual_tds_deducted: actualTds,
            exemption_amount: (tdsData.exemptions || []).reduce((sum, e) => sum + parseFloat(e.amount || 0), 0)
        };
    });
};

exports.getPayslipEmployeeList = async (req, res) => {
    try {
        const { year, department_id } = req.body;
        if (!year) {
            return res.error("VALIDATION_ERROR", { message: "Year is required" });
        }

        const employeeWhere = {};
        if (department_id && department_id !== 'All' && department_id !== 0 && department_id !== '0') {
            employeeWhere.department_id = department_id;
        }

        const fieldConfig = [
            ["employee.first_name", true, true],
            ["employee.employee_code", true, true]
        ];

        const data = await commonQuery.fetchPaginatedData(
            Payslip,
            {
                ...req.body,
                filter: {
                    ...req.body?.filter,
                    year
                }
            },
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: 'employee',
                        where: employeeWhere,
                        attributes: ['id', 'employee_code', 'first_name'],
                        include: [{ model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }]
                    }
                ]
            }
        )

        // Process each payslip to add calculated sums
        data.items = processPayslipData(data.items);

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPayslipView = async (req, res) => {
    try {
        const { employee_id, year } = req.body;
        if (!employee_id || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee ID and Year are required" });
        }

        const data = await commonQuery.findAllRecords(
            Payslip,
            { employee_id, year },
            {
                include: [
                    {
                        model: Employee,
                        as: 'employee',
                        attributes: ['id', 'employee_code', 'first_name'],
                        include: [{ model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }]
                    }
                ]
            }
        )

        // Process each payslip to add calculated sums
        const processedData = processPayslipData(data);

        return res.ok({ items: processedData });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.exportPayrollView = async (req, res) => {
    try {
        const { employee_id, year } = req.body;
        if (!employee_id || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee ID and Year are required" });
        }

        // Get payslip data (same logic as getPayslipView)
        const data = await commonQuery.findAllRecords(
            Payslip,
            { employee_id, year },
            {
                include: [
                    {
                        model: Employee,
                        as: 'employee',
                        attributes: ['id', 'employee_code', 'first_name', 'pan_number'],
                        include: [{ model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }]
                    }
                ]
            }
        );

        // Process each payslip to add calculated sums
        const processedData = processPayslipData(data);

        if (processedData.length === 0) {
            return res.error("NO_DATA", { message: "No payslip data found for this employee and year" });
        }

        // Define Excel column mappers
        const mappers = [
            { header: "ID", key: "id" },
            { header: "Employee ID", key: "employee_id" },
            { header: "Employee Name", key: "employee_name" },
            { header: "Employee Code", key: "employee_code" },
            { header: "Job Title", key: "designation" },
            { header: "Month", key: "month" },
            { header: "Year", key: "year" },
            { header: "Regime", key: "regime" },
            { header: "Earnings", key: "annual_gross" },
            { header: "Exemptions", key: "exemption_amount" },
            { header: "Deductions", key: "actual_deduction" },
            { header: "Standard Deduction", key: "standard_deduction" },
            { header: "Taxable Income", key: "taxable_income" },
            { header: "Tax Liability", key: "monthly_tds" },
            { header: "Paid Gross", key: "paid_gross" },
            { header: "Net Salary", key: "net_salary" }
        ];

        // Generate Excel file
        const { excelBuffer, jsonData } = await handleExport({
            model: Payslip,
            queryOptions: { where: { employee_id, year } },
            mappers,
            commonData: {}
        });

        // Map processed data to match the export structure
        const exportData = processedData.map(item => {
            const row = {};
            mappers.forEach(mapper => {
                row[mapper.header] = item[mapper.key] || '';
            });
            return row;
        });

        // Create Excel from processed data
        const xlsx = require('xlsx');
        const worksheet = xlsx.utils.json_to_sheet(exportData);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, `Payroll_${employee_id}_${year}`);
        const excelBufferFinal = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });

        // Set response headers for file download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=payroll_${employee_id}_${year}.xlsx`);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

        return res.send(excelBufferFinal);

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getCalculationHistory = async (req, res) => {
    try {
        // Configuration for searchable and sortable fields
        const fieldConfig = [
            ['year', false, true],
            ['month', false, true],
            ['status', false, true],
            ['ctc_monthly', false, true],
            ['net_payable', false, true],
            ['employee.first_name', true, true],
            ['employee.employee_code', true, true]
        ];

        const result = await commonQuery.fetchPaginatedData(
            Payslip,
            req.body,
            fieldConfig,
            {
                include: [{
                    model: Employee,
                    as: "employee",
                    attributes: ['id', 'first_name', 'employee_code']
                }]
            }
        );

        // Format items for the response
        result.items = result.items.map(p => {
            const monthName = formatDateTime(new Date(2000, p.month - 1, 1), "MMM");
            const firstName = p.employee?.first_name || "";

            return {
                id: p.id,
                employee_id: p.employee_id,
                employee_name: firstName.trim(),
                employee_code: p.employee?.employee_code || "N/A",
                month: p.month,
                year: p.year,
                month_year_string: `${monthName} ${p.year}`,
                ctc: p.fixed_gross || p.ctc_monthly,
                net_payable: p.net_salary || p.net_payable,
                status: p.status,
                status_text: p.status === 0 ? "Draft" : (p.status === 1 ? "Finalized" : "Paid")
            };
        });

        return res.ok(result);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAvailableMonthsForCalculation = async (req, res) => {
    try {
        let { employee_id, year } = req.body;
        const company_id = req.user.company_id;
        const selectedYear = year || new Date().getFullYear();

        // Get min and max years across both attendance and payslips
        let yearRangeQuery = "";
        let yearReplacements = { company_id };

        if (!employee_id && !req.user.employee_id) {
            yearRangeQuery = `
                SELECT MIN(year) as min_year, MAX(year) as max_year FROM (
                    SELECT EXTRACT(YEAR FROM ad.attendance_date)::INTEGER as year 
                    FROM attendance_day ad 
                    JOIN employees e ON ad.employee_id = e.id 
                    WHERE e.company_id = :company_id AND ad.status != 2
                    UNION
                    SELECT year FROM payslips WHERE company_id = :company_id
                ) combined_years`;
        } else {
            const targetEmployeeId = employee_id || req.user.employee_id;
            yearRangeQuery = `
                SELECT MIN(year) as min_year, MAX(year) as max_year FROM (
                    SELECT EXTRACT(YEAR FROM attendance_date)::INTEGER as year 
                    FROM attendance_day 
                    WHERE employee_id = :employee_id AND status != 2
                    UNION
                    SELECT year FROM payslips WHERE employee_id = :employee_id
                ) combined_years`;
            yearReplacements.employee_id = targetEmployeeId;
        }

        const [yearRange] = await sequelize.query(yearRangeQuery, {
            replacements: yearReplacements,
            type: sequelize.QueryTypes.SELECT
        });

        // If no employee_id provided, we assume we want the overall company-wide payroll cycles
        if (!employee_id && !req.user.employee_id) {
            // 1. Get unique months for the selected year from AttendanceDay
            const attendanceMonths = await sequelize.query(`
                SELECT DISTINCT 
                    EXTRACT(MONTH FROM attendance_date)::INTEGER as month,
                    EXTRACT(YEAR FROM attendance_date)::INTEGER as year
                FROM attendance_day ad
                JOIN employees e ON ad.employee_id = e.id
                WHERE e.company_id = :company_id AND ad.status != 2 
                AND EXTRACT(YEAR FROM attendance_date) = :year
                ORDER BY month DESC
            `, {
                replacements: { company_id, year: selectedYear },
                type: sequelize.QueryTypes.SELECT
            });

            // 2. Get existing payslip summaries by month for the selected year
            const payslipSummaries = await Payslip.findAll({
                where: { company_id, year: selectedYear },
                attributes: [
                    'month', 'year',
                    [sequelize.fn('SUM', sequelize.col('fixed_gross')), 'total_ctc'],
                    [sequelize.fn('SUM', sequelize.col('net_salary')), 'total_net_payable'],
                    [sequelize.fn('COUNT', sequelize.col('id')), 'employee_count'],
                    [sequelize.fn('MAX', sequelize.col('status')), 'status']
                ],
                group: ['month', 'year']
            });

            // 3. Combine and Format
            const monthSet = new Set();
            attendanceMonths.forEach(am => monthSet.add(am.month));
            payslipSummaries.forEach(ps => monthSet.add(ps.month));

            const sortedMonths = Array.from(monthSet).sort((a, b) => b - a);

            const result = sortedMonths.map(month => {
                const summary = payslipSummaries.find(ps => parseInt(ps.month) === month);
                const monthName = formatDateTime(new Date(selectedYear, month - 1, 1), "MMM");
                const statusValue = summary ? parseInt(summary.getDataValue('status')) : 0;

                return {
                    month: month,
                    year: selectedYear,
                    label: `${monthName} ${selectedYear}`,
                    ctc: summary ? parseFloat(summary.getDataValue('total_ctc') || 0).toFixed(2) : "0.00",
                    net_payable: summary ? parseFloat(summary.getDataValue('total_net_payable') || 0).toFixed(2) : "0.00",
                    employee_count: summary ? summary.getDataValue('employee_count') : 0,
                    status: statusValue === 0 ? "Draft" : (statusValue === 1 ? "Finalized" : (statusValue === 2 ? "Paid" : "Running"))
                };
            });

            return res.ok({
                min_year: yearRange?.min_year || selectedYear,
                max_year: yearRange?.max_year || selectedYear,
                data: result
            });
        }

        const targetEmployeeId = employee_id || req.user.employee_id;

        // Individual employee logic
        // 1. Get unique months for the selected year from AttendanceDay
        const attendanceMonths = await sequelize.query(`
            SELECT DISTINCT 
                EXTRACT(MONTH FROM attendance_date)::INTEGER as month,
                EXTRACT(YEAR FROM attendance_date)::INTEGER as year
            FROM attendance_day
            WHERE employee_id = :employee_id AND status != 2
            AND EXTRACT(YEAR FROM attendance_date) = :year
            ORDER BY month DESC
        `, {
            replacements: { employee_id: targetEmployeeId, year: selectedYear },
            type: sequelize.QueryTypes.SELECT
        });

        // 2. Get existing payslips for the selected year
        const existingPayslips = await commonQuery.findAllRecords(Payslip, {
            employee_id: targetEmployeeId,
            year: selectedYear
        });

        // 3. Combine unique months
        const monthSet = new Set();
        attendanceMonths.forEach(am => monthSet.add(am.month));
        existingPayslips.forEach(ep => monthSet.add(ep.month));

        const sortedMonths = Array.from(monthSet).sort((a, b) => b - a);

        // 4. Format Result
        const result = [];
        for (const month of sortedMonths) {
            const existing = existingPayslips.find(p => p.month === month);
            const monthName = formatDateTime(new Date(selectedYear, month - 1, 1), "MMM");

            let ctc = "0.00";
            let net_payable = "0.00";
            let payslip_id = null;

            if (existing) {
                ctc = existing.fixed_gross || existing.ctc_monthly || 0;
                net_payable = existing.net_salary || existing.net_payable || 0;
                payslip_id = existing.id;
            } else {
                try {
                    const summary = await performSalaryCalculation(targetEmployeeId, month, selectedYear);
                    if (summary && summary.salary) {
                        ctc = summary.salary.ctc_monthly;
                        net_payable = summary.salary.netPayable;
                    }
                } catch (e) {
                    console.error(`Calculation failed for ${monthName} ${selectedYear}:`, e.message);
                }
            }

            result.push({
                month: month,
                year: selectedYear,
                label: `${monthName} ${selectedYear}`,
                is_calculated: !!existing,
                ctc,
                net_payable,
                payslip_id,
                status: existing ? (existing.status === 0 ? "Draft" : (existing.status === 1 ? "Finalized" : "Paid")) : "No Calculation"
            });
        }

        console.log("yearRange--------------------\n", yearRange);

        return res.ok({
            min_year: yearRange?.min_year || selectedYear,
            max_year: yearRange?.max_year || selectedYear,
            data: result
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Get detailed data for a specific payslip by ID
 */
exports.getPayslipById = async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) {
            return res.error("VALIDATION_ERROR", { message: "Payslip ID is required" });
        }

        const payslip = await commonQuery.findOneRecord(Payslip, id, {
            include: [{
                model: Employee,
                as: "employee",
                attributes: ['id', 'first_name', 'employee_code', 'department_id', 'joining_date', 'uan_number', 'pan_number', 'bank_name', 'bank_account_number'],
                include: [{ model: DesignationMaster, as: "designation", attributes: ['designation_name'] }]
            }]
        });

        if (!payslip) {
            return res.error("NOT_FOUND", { message: "Payslip not found" });
        }

        if (!payslip.month || !payslip.year) {
            return res.error("VALIDATION_ERROR", { message: "Payslip record is missing month or year data" });
        }

        const monthName = formatDateTime(new Date(payslip.year, parseInt(payslip.month) - 1, 1), "MMMM");

        // Fetch current adjustments to show updated ones if in Draft or just for view
        const year = parseInt(payslip.year);
        const month = parseInt(payslip.month);
        const monthDate = dayjs(`${year}-${month}-01`);

        if (!monthDate.isValid()) {
            return res.error("VALIDATION_ERROR", { message: "Payslip has an invalid month or year" });
        }
        const monthStr = monthDate.format('YYYY-MM-DD');

        const incentives = await commonQuery.findAllRecords(EmployeeIncentive, {
            employee_id: payslip.employee_id,
            month: month,
            year: year,
            status: { [Op.ne]: 2 }
        }, {
            include: [{ model: IncentiveType, as: "incentiveType", attributes: ["name"] }]
        });
        const advances = await commonQuery.findAllRecords(EmployeeAdvance, {
            employee_id: payslip.employee_id,
            month: month,
            year: year,
            status: { [Op.ne]: 2 }
        });

        // Fetch reimbursements for the month
        const startDate = monthDate.startOf('month').format('YYYY-MM-DD');
        const endDate = monthDate.endOf('month').format('YYYY-MM-DD');
        const reimbursements = await commonQuery.findAllRecords(Reimbursement, {
            employee_id: payslip.employee_id,
            date: { [Op.between]: [startDate, endDate] },
            approval_status: 3, // APPROVED
            status: 0, // Active
            payment_type: 1 // Only include in payroll if payment_type is 1 (salary)
        }, {
            include: [{ model: ExpenseType, as: "expenseType", attributes: ["name"] }]
        });

        // Fetch Employee Leave Balance data
        const rawLeaveBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
            employee_id: payslip.employee_id,
            year: year
        });
        const leaveBalances = rawLeaveBalances.map(lb => ({
            leave_category_id: lb.leave_category_id,
            leave_category_name: lb.leave_category_name,
            used_leaves: lb.used_leaves,
            balance: lb.pending_leaves
        }));

        // Fetch Payment History for the month
        const paymentHistories = await commonQuery.findAllRecords(PaymentHistory, {
            employee_id: payslip.employee_id,
            payment_date: { [Op.between]: [startDate, endDate] },
            status: { [Op.ne]: 2 }
        }, {
            attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'payment_type']
        });
        const totalPaid = paymentHistories.reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0);

        // Fetch Employee Advance records
        const employeeAdvances = await commonQuery.findAllRecords(EmployeeAdvance, {
            employee_id: payslip.employee_id,
            status: 0,
            adjusted_in_payroll: false
        }, {
            attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'notes', 'adjusted_in_payroll']
        });

        // Granular attendance recalculation for UI (since Payslip summary is slightly compressed)
        const lwpDays = parseFloat(payslip.wp_days || payslip.lwp_days || 0);
        const absentDays = parseFloat(payslip.absent_days || 0);
        const halfDays = (lwpDays - absentDays) / 0.5;
        const presentDays = parseFloat(payslip.present_days || 0);
        const leave_details = payslip.leave_details || {};
        const leaveDays = Object.values(leave_details).reduce((sum, val) => sum + parseFloat(val || 0), 0);
        const weeklyOffs = parseFloat(payslip.wo_days || payslip.weekly_offs || 0);
        const holidays = parseFloat(payslip.ph_days || payslip.holidays || 0);

        // Fetch computation basis for calculation
        const template = await commonQuery.findOneRecord(EmployeeSalaryTemplate, { employee_id: payslip.employee_id });
        const basis = template?.lwp_calculation_basis || 'DAYS_IN_MONTH';

        let payableDaysValue = 0;
        if (basis === "WORKING_DAYS") {
            payableDaysValue = presentDays + (halfDays * 0.5) + leaveDays + holidays;
        } else if (basis === "FIXED_30_DAYS") {
            payableDaysValue = 30 - lwpDays;
        } else {
            const daysInMonth = dayjs(`${payslip.year}-${payslip.month}-01`).daysInMonth();
            payableDaysValue = daysInMonth - lwpDays;
        }
        const payableDays = parseFloat(payableDaysValue);

        // Construct breakdown if missing (for imported data)
        let breakdown = payslip.break_down;
        if (!breakdown || (!breakdown.earnings?.length && !breakdown.deductions?.length)) {
            const earning_details = payslip.earning_details || {};
            const deduction_details = payslip.deduction_details || {};

            breakdown = {
                earnings: Object.entries(earning_details).map(([name, val]) => ({ name, actual_amount: val })),
                deductions: [
                    ...Object.entries(deduction_details)
                        .filter(([name]) => {
                            // Filter out statutory items from deductions if they exist in statutory_details
                            const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                            const normName = normalize(name);
                            const statutoryKeys = Object.keys(payslip.statutory_details || {}).map(k => normalize(k));
                            return !statutoryKeys.includes(normName);
                        })
                        .map(([name, val]) => ({ name, amount: val })),
                    ...Object.entries(payslip.statutory_details || {})
                        .filter(([key, value]) => typeof value === 'number' && !key.includes('%'))
                        .map(([name, amount]) => ({ name, amount, is_statutory: true }))
                ],
                statutory: payslip.statutory_details || {},
                employer: payslip.employer_details || {},
                total_earnings: Object.values(earning_details || {}).reduce((sum, val) => sum + parseFloat(val || 0), 0).toFixed(2),
                total_deductions: [
                    ...Object.entries(deduction_details)
                        .filter(([name]) => {
                            const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                            const normName = normalize(name);
                            const statutoryKeys = Object.keys(payslip.statutory_details || {}).map(k => normalize(k));
                            return !statutoryKeys.includes(normName);
                        })
                        .map(([, val]) => parseFloat(val || 0)),
                    ...Object.entries(payslip.statutory_details || {})
                        .filter(([key, value]) => typeof value === 'number' && !key.includes('%'))
                        .map(([, amount]) => amount)
                ].reduce((sum, val) => sum + val, 0).toFixed(2)
            };
        }

        // Final Formatting for UI "Data Pass"
        const formattedData = {
            id: payslip.id,
            employee: {
                id: payslip.employee?.id,
                name: payslip.employee?.first_name,
                code: payslip.employee?.employee_code,
                designation: payslip.employee?.designation?.designation_name,
                joining_date: payslip.employee?.joining_date,
                uan: payslip.employee?.uan_number,
                pan: payslip.employee?.pan_number,
                bankName: payslip.employee?.bank_name,
                accountNo: payslip.employee?.bank_account_number
            },
            period: {
                month: payslip.month,
                year: payslip.year,
                label: `${monthName} ${payslip.year}`,
                payDate: monthDate.endOf('month').format('DD/MM/YYYY')
            },
            attendance: {
                present: presentDays,
                absent: absentDays,
                halfDay: halfDays > 0 ? halfDays : 0,
                leave: leaveDays,
                weekly_off: weeklyOffs,
                holiday: holidays,
                lwp: lwpDays,
                payable_days: payableDays.toFixed(1),
                lunch_count: payslip.lunch_count || 0,
                leave_details: payslip.leave_details || {}
            },
            salary: {
                ctc: payslip.fixed_gross || payslip.ctc_monthly,
                perDay: payslip.per_day_salary || 0,
                netPayable: payslip.net_salary || payslip.net_payable,
                fine: payslip.deduct_misc || payslip.total_fine || 0,
                overtime: payslip.paid_ot_pay || payslip.ot_amount,
                lwpDeduction: payslip.lwp_deduction || 0,
                incentives: (parseFloat(payslip.paid_incentive || 0) + incentives.reduce((sum, i) => sum + parseFloat(i.amount || 0), 0)).toFixed(2),
                advances: (parseFloat(payslip.deduct_advance || 0) + advances.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0)).toFixed(2),
                reimbursements: (payslip.reimbursement_details || []).reduce((sum, r) => sum + parseFloat(r.amount || 0), 0).toFixed(2)
            },
            adjustments: {
                incentives: incentives.map(i => ({ name: i.incentiveType?.name, amount: i.amount })),
                advances: advances.map(a => ({ name: "Advance repayment", amount: a.amount }))
            },
            reimbursements: reimbursements.map(r => ({ name: r.expenseType?.name || "Reimbursement", amount: r.amount, description: r.description, date: r.date, expense_type: r.expense_type?.name, })),
            breakdown: breakdown,
            tds_calculation_data: payslip.tds_calculation_data,
            leave_balances: payslip.leave_balances || leaveBalances,
            payment_history: {
                salary: {
                    history: paymentHistories.filter(ph => ph.payment_type === 'Salary').map(ph => ({
                        id: ph.id,
                        amount: ph.amount,
                        payment_mode: ph.payment_mode,
                        payment_date: ph.payment_date,
                        payment_type: ph.payment_type
                    })),
                    sum: paymentHistories.filter(ph => ph.payment_type === 'Salary').reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0).toFixed(2)
                },
                advance: {
                    history: employeeAdvances.map(ea => ({
                        id: ea.id,
                        amount: ea.amount,
                        payment_mode: ea.payment_mode,
                        payment_date: ea.payment_date,
                        payment_type: 'Advance',
                        adjusted_in_payroll: ea.adjusted_in_payroll
                    })),
                    sum: employeeAdvances.reduce((sum, ea) => sum + parseFloat(ea.amount || 0), 0).toFixed(2)
                },
            },
            status: payslip.status,
            status_text: payslip.status === 0 ? "Draft" : (payslip.status === 1 ? "Finalized" : "Paid")
        };

        return res.ok(formattedData);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getSalaryOverview = async (req, res) => {
    try {
        let { employee_id, month: reqMonth, year: reqYear } = req.body;
        if (!employee_id) {
            employee_id = req.user.employee_id;
        }
        if (!employee_id) {
            return res.error("VALIDATION_ERROR", { message: "Employee ID is required" });
        }

        // 1. Fetch Employee for joining date & Salary Template for computation basis
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            attributes: ['id', 'joining_date', 'branch_id', 'company_id'],
            include: [{
                model: EmployeeSalaryTemplate,
                as: 'employeeSalaryTemplate',
                attributes: ['lwp_calculation_basis']
            }]
        });

        if (!employee) {
            return res.error("NOT_FOUND", { message: "Employee not found" });
        }

        const basis = employee.employeeSalaryTemplate?.lwp_calculation_basis || 'WORKING_DAYS';

        // 2. Generate list of months from current date back to joining date
        const monthList = [];
        let cur = dayjs().startOf('month');
        const joinDate = dayjs(employee.joining_date || dayjs()).startOf('month');

        // Loop until we reach the month before joining date
        while (cur.isAfter(joinDate) || cur.isSame(joinDate, 'month')) {
            monthList.push({ month: cur.month() + 1, year: cur.year() });
            cur = cur.subtract(1, 'month');

            // Safety break to prevent infinite loop (max 20 years history)
            if (monthList.length > 240) break;
        }

        // If no months found (e.g. future joining date), at least show current month
        if (monthList.length === 0) {
            monthList.push({ month: dayjs().month() + 1, year: dayjs().year() });
        }

        const overview = [];
        for (let i = 0; i < monthList.length; i++) {
            const m = monthList[i];
            const monthName = formatDateTime(new Date(m.year, m.month - 1, 1), "MMM");
            const yearShort = m.year.toString().slice(-2);
            const isCurrentMonth = m.month === (dayjs().month() + 1) && m.year === dayjs().year();
            const monthStr = `${m.year}-${m.month.toString().padStart(2, '0')}-01`;

            // Condition to load details: 
            // 1. It is the month requested in req.body (for lazy loading click)
            // 2. It is the current month (initial load)
            // 3. A finalized payslip already exists (very fast, no heavy calc)
            const isRequested = reqMonth == m.month && reqYear == m.year;
            const shouldLoadDetails = isRequested || isCurrentMonth;

            // Fetch Payslip (Fast)
            const payslip = await commonQuery.findOneRecord(Payslip, {
                employee_id,
                month: m.month,
                year: m.year,
                status: { [Op.in]: [1, 2] }
            });
            if (payslip) {
                // Use stored values from payslip database
                const ot = parseFloat(payslip.ot_amount || 0);
                const fine = parseFloat(payslip.total_fine || 0);

                // Use stored earnings from earning_details
                const earningDetails = payslip.earning_details || {};
                const earnList = Object.entries(earningDetails).map(([name, amount]) => ({
                    name: name,
                    amount: parseFloat(amount || 0).toFixed(2),
                    is_benefit: false,
                    is_incentive: false,
                    is_employer: false
                }));

                // Use stored deductions from deduction_details
                const deductionDetails = payslip.deduction_details || {};
                const dedList = Object.entries(deductionDetails).map(([name, amount]) => ({
                    name,
                    amount: parseFloat(amount || 0).toFixed(2),
                    is_food: name.toLowerCase().includes('food'),
                    is_statutory: false
                }));

                // Use stored attendance values
                const lwpDays = parseFloat(payslip.wp_days || 0);
                const presentDays = parseFloat(payslip.present_days || 0);
                const absentDays = parseFloat(payslip.absent_days || 0);
                const halfDays = (lwpDays - absentDays) / 0.5;
                const leave_details = payslip.leave_details || {};
                const leaveDays = Object.values(leave_details).reduce((sum, val) => sum + parseFloat(val || 0), 0);
                const weeklyOffs = parseFloat(payslip.wo_days || 0);
                const holidays = parseFloat(payslip.ph_days || 0);
                const daysInMonth = dayjs(`${m.year}-${m.month}-01`).daysInMonth();

                // Use stored payable days or calculate if not available
                const payableDays = parseFloat(payslip.pd_days || 0);

                // Fetch Lunch History for finalized payslip
                const startDate = dayjs(`${m.year}-${m.month}-01`).startOf('month').format('YYYY-MM-DD');
                const endDate = dayjs(`${m.year}-${m.month}-01`).endOf('month').format('YYYY-MM-DD');
                const lunchRecords = await commonQuery.findAllRecords(
                    CanteenAttendance,
                    { employee_id, date: { [Op.between]: [startDate, endDate] } },
                    { attributes: ['date', 'created_at'] }
                );
                const lunchHistory = lunchRecords.map(r => ({
                    date: dayjs(r.getDataValue('date')).format('YYYY-MM-DD'),
                    time: formatDateTime(r.getDataValue('created_at'), 'hh:mm A')
                }));

                // Fetch employee incentive history
                const incentives = await commonQuery.findAllRecords(EmployeeIncentive, {
                    employee_id,
                    month: m.month,
                    year: m.year,
                    status: { [Op.ne]: 2 }
                });
                const employeeIncentiveHistory = incentives.map(inc => ({
                    type: "incentive",
                    id: inc.id,
                    amount: inc.amount,
                    incentive_date: inc.incentive_date
                }));

                // Fetch Payment History for the month
                const paymentHistories = await commonQuery.findAllRecords(PaymentHistory, {
                    employee_id,
                    payment_date: { [Op.between]: [startDate, endDate] },
                    status: { [Op.ne]: 2 }
                }, {
                    attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'payment_type']
                });

                // Use advances_adjusted from payslip payment_history
                const advancesAdjusted = payslip.payment_history?.advances_adjusted || [];

                // Create payment history structure
                const salaryPayments = paymentHistories.filter(ph => ph.payment_type === 'Salary');
                const salarySum = salaryPayments.reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0);
                const advanceSum = advancesAdjusted.reduce((sum, aa) => sum + parseFloat(aa.amount || 0), 0);

                const paymentHistory = {
                    salary: {
                        history: salaryPayments.map(ph => ({
                            id: ph.id,
                            amount: ph.amount,
                            payment_mode: ph.payment_mode,
                            payment_date: ph.payment_date,
                            payment_type: ph.payment_type
                        })),
                        sum: salarySum.toFixed(2)
                    },
                    advance: {
                        history: advancesAdjusted.map(aa => ({
                            id: aa.advance_id,
                            amount: aa.amount,
                            payment_mode: aa.payment_mode,
                            payment_date: aa.payment_date,
                            payment_type: 'Advance',
                            notes: aa.notes
                        })),
                        sum: advanceSum.toFixed(2)
                    },
                    grand_total: (salarySum + advanceSum).toFixed(2)
                };

                // Use stored totals - calculate from actual details
                const totalEarn = Object.values(earningDetails).reduce((sum, val) => sum + parseFloat(val || 0), 0);
                const totalDed = dedList.reduce((sum, d) => sum + parseFloat(d.amount), 0);
                const netPayable = parseFloat(payslip.net_salary || 0);

                overview.push({
                    id: payslip.id,
                    month: m.month,
                    year: m.year,
                    month_label: `${monthName}, ${yearShort}`,
                    due_amount: netPayable.toFixed(2),
                    date_range: `01 ${monthName}'${yearShort} - ${isCurrentMonth ? formatDateTime(new Date(), "DD MMM'YY") : formatDateTime(dayjs(`${m.year}-${m.month}-01`).endOf('month').toDate(), "DD MMM'YY")}`,
                    net_receivable: netPayable.toFixed(2),
                    payable_days: payableDays % 1 === 0 ? payableDays.toString() : payableDays.toFixed(1),
                    actualDaysValue: daysInMonth,
                    lwp_days: lwpDays || 0,
                    lunch_count: payslip.lunch_count || 0,
                    lunch_history: lunchHistory,
                    employee_incentive_history: employeeIncentiveHistory,
                    reimbursement_history: payslip.reimbursement_details || [],
                    encashment_history: payslip.encashment_details || {},
                    statutory: payslip.statutory_details || {},
                    employer: payslip.employer_details || {},
                    breakdown: {
                        earnings: earnList,
                        deductions: dedList,
                        statutory: payslip.statutory_details || {},
                        employer: payslip.employer_details || {},
                        total_earnings: totalEarn.toFixed(2),
                        total_deductions: totalDed.toFixed(2)
                    },
                    payment_history: paymentHistory,
                    ot_amount: ot.toFixed(2),
                    total_fine: fine.toFixed(2),
                    fine_amount: fine.toFixed(2),
                    ctc_monthly: payslip.fixed_gross || 0,
                    tds_calculation_data: payslip.tds_calculation_data,
                    roundOffAmount: payslip.round_off_amount,
                    is_loaded: true,
                    is_finalized: true
                });

            } else if (shouldLoadDetails) {
                // Perform dynamic calculation
                try {
                    const summary = await performSalaryCalculation(employee_id, m.month, m.year, null, { skipStatutory: false });
                    const payableDays = parseFloat(summary.attendance.payableDays);
                    // const totalEarn = earnList.reduce((sum, e) => sum + (e.is_employer ? 0 : parseFloat(e.amount)), 0);
                    // const totalDed = dedList.reduce((sum, d) => sum + parseFloat(d.amount), 0);
                    const netPayable = (summary.breakdown.total_earnings - summary.breakdown.total_deductions) + parseFloat(summary.salary.reimbursementAmount || 0);

                    // Fetch company settings for rounding configuration
                    const companySettings = await commonQuery.findOneRecord(CompanySettings, {
                        settings_name: 'round_off_salary',
                        status: 0
                    });
                    const roundOffType = companySettings?.settings_value || 0;
                    const { roundedAmount: roundedNetPayable, roundOffAmount } = applyRounding(netPayable, roundOffType);

                    overview.push({
                        month: m.month,
                        year: m.year,
                        month_label: `${monthName}, ${yearShort}`,
                        due_amount: roundedNetPayable < 0 ? "0" : roundedNetPayable.toFixed(2),
                        date_range: `01 ${monthName}'${yearShort} - ${isCurrentMonth ? formatDateTime(new Date(), "DD MMM'YY") : formatDateTime(dayjs(`${m.year}-${m.month}-01`).endOf('month').toDate(), "DD MMM'YY")}`,
                        roundOffAmount: roundOffAmount.toFixed(2),
                        net_receivable: roundedNetPayable < 0 ? "0" : roundedNetPayable.toFixed(2),
                        payable_days: payableDays % 1 === 0 ? payableDays.toString() : payableDays.toFixed(1),
                        actualDaysValue: summary.attendance.actualDaysValue || 0,
                        lwp_days: summary.attendance.totalLWP,
                        lunch_count: summary.attendance.lunchCount || 0,
                        lunch_history: summary.attendance.lunchHistory || [],
                        employee_incentive_history: (summary.employee_incentive_history || []).map(inc => ({
                            type: "incentive",
                            id: inc.id,
                            amount: inc.amount,
                            incentive_date: inc.incentive_date
                        })),
                        reimbursement_history: summary.reimbursement_history || [],
                        statutory: summary.breakdown.statutory || {},
                        employer: summary.breakdown.employer || {},
                        breakdown: summary.breakdown,
                        // payment_history: summary.payment_history,
                        ot_amount: summary.salary.overtimeAmount,
                        total_fine: summary.salary.totalFine,
                        fine_amount: summary.salary.totalFine,
                        ctc_monthly: summary.salary.ctc_monthly,
                        tds_calculation_data: summary.tds_calculation_data,
                        is_loaded: true,
                        is_finalized: false
                    });
                } catch (e) {
                    console.error(`Calculation failed for overview ${m.month}/${m.year}:`, e.message);
                    overview.push({ month: m.month, year: m.year, month_label: `${monthName}, ${yearShort}`, is_loaded: false, error: e.message });
                }
            } else {
                // Shell for later loading
                overview.push({
                    month: m.month,
                    year: m.year,
                    month_label: `${monthName}, ${yearShort}`,
                    date_range: `01 ${monthName}'${yearShort} - ${formatDateTime(dayjs(`${m.year}-${m.month}-01`).endOf('month').toDate(), "DD MMM'YY")}`,
                    is_loaded: false,
                    is_finalized: false
                });
            }

            // Fill Incentives/Advances if details were loaded or payslip was found
            if (overview[i].is_loaded) {
                const incentives = await commonQuery.findAllRecords(EmployeeIncentive, { employee_id, month: m.month, year: m.year, status: { [Op.ne]: 2 } });
                const advances = await commonQuery.findAllRecords(EmployeeAdvance, { employee_id, month: m.month, year: m.year, status: { [Op.ne]: 2 } });
                overview[i].adjustments = incentives.reduce((sum, inc) => sum + parseFloat(inc.amount || 0), 0).toFixed(2);
                overview[i].payments = advances.reduce((sum, adv) => sum + parseFloat(adv.amount || 0), 0).toFixed(2);
            }
        }

        return res.ok(overview);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Helper to prepare data for payslip PDF
 */
const preparePayslipPdfData = async (payslipId, companyId) => {
    // Fetch Payslip with Employee and Designation details
    const payslip = await commonQuery.findOneRecord(Payslip, payslipId, {
        include: [{
            model: Employee,
            as: "employee",
            attributes: ['id', 'first_name', 'employee_code', 'department_id', 'joining_date', 'uan_number', 'pan_number', 'bank_name', 'bank_account_number', 'company_id', 'branch_id'],
            include: [{ model: DesignationMaster, as: "designation", attributes: ['designation_name'] }]
        }]
    });

    if (!payslip) return null;

    // Fetch company details
    const { StateMaster, CountryMaster } = require("../../models");
    const resolvedBranchId = payslip.branch_id || payslip.employee?.branch_id;
    let branch = null;
    if (resolvedBranchId) {
        branch = await commonQuery.findOneRecord(
            BranchMaster,
            resolvedBranchId,
            {},
            null,
            false,
            {}
        );
    }

    const candidateCompanyIds = [
        branch?.company_id,
        payslip.employee?.company_id,
        payslip.company_id,
        companyId
    ].filter(Boolean);
    const companyQueryOptions = {
        include: [
            { model: StateMaster, as: "state", attributes: ["state_name"] },
            { model: CountryMaster, as: "country", attributes: ["country_name"] }
        ]
    };

    let company = null;
    for (const candidateCompanyId of candidateCompanyIds) {
        company = await commonQuery.findOneRecord(
            CompanyMaster,
            candidateCompanyId,
            companyQueryOptions,
            null, // transaction
            false, // forceReload
            {} // requireTenantFields
        );

        if (company?.company_name) {
            break;
        }
    }

    // Final fallback for older records where only company_master.branch_id matches.
    if ((!company || !company.company_name) && resolvedBranchId) {
        company = await commonQuery.findOneRecord(
            CompanyMaster,
            {
                branch_id: resolvedBranchId,
                status: 0
            },
            {
                ...companyQueryOptions,
                order: [["is_default", "ASC"], ["id", "DESC"]]
            },
            null,
            false,
            {}
        );
    }

    let fullAddressParts = [];
    if (company?.address) fullAddressParts.push(company.address);
    if (company?.address2) fullAddressParts.push(company.address2);
    if (company?.city) fullAddressParts.push(company.city);
    if (company?.state?.state_name) fullAddressParts.push(company.state.state_name);
    if (company?.country?.country_name) fullAddressParts.push(company.country.country_name);

    let formattedAddress = fullAddressParts.length > 0 ? fullAddressParts.join(', ') : 'Gujarat, India';
    if (company?.pincode) {
        formattedAddress += ` - ${company.pincode}`;
    }

    const monthName = dayjs().month(parseInt(payslip.month) - 1).format('MMMM');

    // Granular attendance calculation
    const lwpDays = parseFloat(payslip.wp_days || payslip.lwp_days || 0);
    const absentDays = parseFloat(payslip.absent_days || 0);
    const presentDays = parseFloat(payslip.present_days || 0);
    const leave_details = payslip.leave_details || {};

    // Construct breakdown if it's missing or compressed
    let breakdown = payslip.break_down;
    if (!breakdown || (!breakdown.earnings?.length && !breakdown.deductions?.length)) {
        const earning_details = payslip.earning_details || {};
        const deduction_details = payslip.deduction_details || {};

        breakdown = {
            earnings: Object.entries(earning_details).map(([name, val]) => ({ name, amount: val })),
            deductions: [
                ...Object.entries(deduction_details).map(([name, val]) => ({ name, amount: val })),
                ...Object.entries(payslip.statutory_details || {})
                    .filter(([key, value]) => typeof value === 'number' && !key.includes('%'))
                    .map(([name, amount]) => ({ name, amount, is_statutory: true }))
            ],
            statutory: payslip.statutory_details || {},
            employer: payslip.employer_details || {},
            total_earnings: Object.values(earning_details || {}).reduce((sum, val) => sum + parseFloat(val || 0), 0).toFixed(2),
            total_deductions: [
                ...Object.entries(deduction_details).map(([, val]) => parseFloat(val || 0)),
                ...Object.entries(payslip.statutory_details || {})
                    .filter(([key, value]) => typeof value === 'number' && !key.includes('%'))
                    .map(([, amount]) => amount)
            ].reduce((sum, val) => sum + val, 0).toFixed(2)
        };
    }

    // Add Statutory deductions into the deductions list for the PDF display
    const statutoryDeductions = Object.entries(breakdown.statutory || {}).map(([name, amount]) => ({
        name,
        amount: parseFloat(amount || 0),
        is_statutory: true
    })).filter(d => d.amount > 0);

    const fullDeductionList = [
        ...(breakdown.deductions || []).map(d => ({ name: d.name, amount: parseFloat(d.amount || 0) })),
        ...statutoryDeductions
    ];

    // Recalculate totals for display
    const totalEarnings = (breakdown.earnings || []).reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
    const totalDeductions = fullDeductionList.reduce((sum, d) => sum + d.amount, 0);

    return {
        meta: {
            payslip_id: payslip.id,
            employee_id: payslip.employee_id,
            month: payslip.month,
            year: payslip.year,
            company_id: payslip.employee?.company_id || payslip.company_id,
            branch_id: resolvedBranchId
        },
        payslipData: {
            employee: {
                name: payslip.employee?.first_name,
                code: payslip.employee?.employee_code,
                designation: payslip.employee?.designation?.designation_name,
                joining_date: payslip.employee?.joining_date ? dayjs(payslip.employee.joining_date).format('DD/MM/YYYY') : 'N/A'
            },
            period: {
                label: `${monthName} ${payslip.year}`,
                payDate: payslip.payment_date ? dayjs(payslip.payment_date).format('DD/MM/YYYY') : dayjs(payslip.createdAt || payslip.created_at).format('DD/MM/YYYY')
            },
            attendance: {
                present: presentDays,
                lwp: lwpDays,
                lunch_count: payslip.lunch_count || 0,
                leave_details: leave_details
            },
            salary: {
                netPayable: payslip.net_salary || payslip.net_payable
            },
            breakdown: {
                earnings: (breakdown.earnings || []).map(e => ({ name: e.name, actual_amount: e.actual_amount, amount: e.amount })),
                deductions: fullDeductionList,
                statutory: breakdown.statutory || payslip.statutory_details || {},
                total_earnings: totalEarnings.toFixed(2),
                total_deductions: totalDeductions.toFixed(2)
            },
            leave_balances: payslip.leave_balances || [],
            reimbursements: payslip.reimbursement_details || [],
            payment_history: payslip.payment_history || {}
        },
        companyData: {
            company_name: company?.company_name || 'Airwix HRMS',
            address: formattedAddress
        },
        totalEarnings,
        totalDeductions
    };
};

exports.generatePayslipPdf = async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) {
            return res.error("VALIDATION_ERROR", { message: "Payslip ID is required" });
        }

        const data = await preparePayslipPdfData(id, req.user.company_id);
        if (!data) {
            return res.error("NOT_FOUND", { message: "Payslip not found" });
        }

        const templatePath = path.join(process.cwd(), 'views', 'payslip', 'slip.ejs');
        const filename = `payslip_${id}_${Date.now()}.pdf`;
        const outputDir = path.join(process.cwd(), 'uploads', 'payslips');

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, filename);
        await pdfService.generatePdfFromTemplate(templatePath, data, outputPath);

        const downloadLink = `${process.env.FILE_SERVER_URL}payslips/${filename}`;

        //Send Notification to Employee
        try {
            if (data.meta) {
                const targetUser = await commonQuery.findOneRecord(User, { employee_id: data.meta.employee_id }, {});
                if (targetUser) {
                    const monthName = dayjs().month(data.meta.month - 1).format('MMMM');
                    await createNotification({
                        user_id: targetUser.id,
                        title: "Payslip Generated",
                        message: `Your payslip for ${monthName} ${data.meta.year} has been generated. You can now view and download it.`,
                        type: "PAYROLL",
                        reference_id: data.meta.payslip_id,
                        status_code: 0,
                        company_id: req.user?.company_id || data.meta.company_id,
                        branch_id: data.meta.branch_id
                    });
                }
            }
        } catch (notifyErr) {
            console.error("Payslip Notification Error in PDF Gen:", notifyErr.message);
        }

        return res.ok({
            download_link: downloadLink,
            filename: filename
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.generateBulkPayslipPdf = async (req, res) => {
    try {
        const { ids } = req.body; // Array of Payslip IDs
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.error("VALIDATION_ERROR", { message: "List of Payslip IDs is required" });
        }

        const slips = [];
        for (const id of ids) {
            try {
                const data = await preparePayslipPdfData(id, req.user.company_id);
                if (data) {
                    slips.push(data);
                }
            } catch (pErr) {
                console.error(`Error preparing data for payslip ${id}:`, pErr.message);
            }
        }

        if (slips.length === 0) {
            return res.error("NOT_FOUND", { message: "No valid payslips found to generate" });
        }

        const templatePath = path.join(process.cwd(), 'views', 'payslip', 'bulk_slip.ejs');
        const filename = `bulk_payslip_${Date.now()}.pdf`;
        const outputDir = path.join(process.cwd(), 'uploads', 'payslips');

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, filename);
        await pdfService.generatePdfFromTemplate(templatePath, { slips }, outputPath);

        const downloadLink = `${process.env.FILE_SERVER_URL}payslips/${filename}`;

        //  Send Notification to Employees
        try {
            for (const data of slips) {
                if (!data.meta) continue;
                const targetUser = await commonQuery.findOneRecord(User, { employee_id: data.meta.employee_id }, {});
                if (targetUser) {
                    const monthName = dayjs().month(data.meta.month - 1).format('MMMM');
                    await createNotification({
                        user_id: targetUser.id,
                        title: "Payslip Generated",
                        message: `Your payslip for ${monthName} ${data.meta.year} has been generated. You can now view and download it.`,
                        type: "PAYROLL",
                        reference_id: data.meta.payslip_id,
                        status_code: 0,
                        company_id: req.user?.company_id || data.meta.company_id,
                        branch_id: data.meta.branch_id
                    });
                }
            }
        } catch (notifyErr) {
            console.error("Bulk Payslip Notification Error:", notifyErr.message);
        }

        return res.ok({
            download_link: downloadLink,
            filename: filename,
            count: slips.length
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getEmployeesByMonthYear = async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        // 1. Get unique employee_ids from AttendanceDay for the given month/year
        const attendanceEmployees = await commonQuery.findAllRecords(AttendanceDay, {
            [Op.and]: [
                sequelize.where(sequelize.fn('EXTRACT', sequelize.literal('MONTH FROM attendance_date')), month),
                sequelize.where(sequelize.fn('EXTRACT', sequelize.literal('YEAR FROM attendance_date')), year),
                { status: { [Op.ne]: 2 } }
            ]
        }, {
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('employee_id')), 'employee_id']],
            raw: true
        }, null, { company_id: true });

        // 2. Get unique employee_ids from Payslip for the given month/year
        const payslipEmployees = await commonQuery.findAllRecords(Payslip, {
            month, year
        }, {
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('employee_id')), 'employee_id']],
            raw: true
        });

        // 3. Combine unique employee IDs
        const employeeIds = new Set();
        attendanceEmployees.forEach(ae => employeeIds.add(ae.employee_id));
        payslipEmployees.forEach(pe => employeeIds.add(pe.employee_id));

        if (employeeIds.size === 0) {
            return res.ok({
                items: [],
                total: 0,
                currentPage: 1,
                pageSize: req.body.limit === 'all' ? 0 : (parseInt(req.body.limit) || 10),
                totalPages: 0,
                hasNextPage: false,
                hasPreviousPage: false,
                appliedFilters: req.body
            });
        }

        // 4. Fetch employee details using fetchPaginatedData
        const fieldConfig = [
            ["first_name", true, true],
            ["employee_code", true, true],
        ];

        const paginatedData = await commonQuery.fetchPaginatedData(
            Employee,
            req.body,
            fieldConfig,
            {
                include: [
                    { model: EmployeeSalaryTemplate, as: 'employeeSalaryTemplate', attributes: ['ctc_monthly'] },
                    { model: SalaryTemplate, as: 'salaryTemplate', attributes: ['ctc_monthly'] }
                ],
                attributes: ['id', 'first_name', 'employee_code', 'joining_date'],
                order: [["first_name", "ASC"]]

            },
            true,
            "joining_date",
            { id: { [Op.in]: Array.from(employeeIds) } }
        );

        // 5. Fetch existing Payslips for ALL employees matching this month/year
        const allExistingPayslips = await commonQuery.findAllRecords(Payslip, {
            month, year, employee_id: { [Op.in]: Array.from(employeeIds) }
        });
        const allPayslipMap = new Map(allExistingPayslips.map(p => [p.employee_id, p]));

        // 6. Format Result items for the current page
        const items = [];
        for (const emp of paginatedData.items) {
            const existing = allPayslipMap.get(emp.id);
            let ctc = "0.00";
            let net_payable = "0.00";
            let payslip_id = null;
            let status = null;
            let paid_amount = 0;
            let pending_amount = 0;

            if (existing) {
                ctc = existing.fixed_gross || existing.ctc_monthly || 0;
                net_payable = existing.net_salary || existing.net_payable || 0;
                payslip_id = existing.id;
                status = existing.status;
                paid_amount = parseFloat(existing.paid_amount || 0);
                pending_amount = parseFloat(existing.pending_amount || 0);
            } else {
                try {
                    const sim = await performSalaryCalculation(emp.id, month, year, null, { skipStatutory: false });
                    if (sim && sim.salary) {
                        ctc = sim.salary.ctc_monthly;
                        net_payable = sim.salary.netPayable;
                        paid_amount = parseFloat(sim.payment_history?.grand_total || 0);
                        pending_amount = Math.max(0, parseFloat(net_payable) - paid_amount);
                    }
                } catch (e) {
                    console.error(`Simulation failed for employee ${emp.id}:`, e.message);
                }
            }

            items.push({
                id: emp.id,
                name: emp.first_name,
                employee_code: emp.employee_code,
                ctc,
                net_payable,
                amount: paid_amount,
                pending_amount,
                payslip_id,
                status
            });
        }

        // 7. Calculate grand totals globally for all employees (not just the current page)
        const allTotals = await Promise.all(Array.from(employeeIds).map(async (empId) => {
            const existing = allPayslipMap.get(empId);
            let net_payable = 0;
            let paid_amount = 0;

            if (existing) {
                net_payable = Math.max(parseFloat(existing.net_salary || existing.net_payable || 0), 0);
                paid_amount = parseFloat(existing.paid_amount || 0);
            } else {
                try {
                    const sim = await performSalaryCalculation(empId, month, year, null, { skipStatutory: false });
                    if (sim && sim.salary) {
                        net_payable = Math.max(parseFloat(sim.salary.netPayable || 0), 0);
                        paid_amount = parseFloat(sim.payment_history?.grand_total || 0);
                    }
                } catch (e) {
                    // Ignore and keep as 0
                }
            }
            return { net_payable, paid_amount };
        }));

        let total_net_payable = 0;
        let total_paid_amount = 0;
        let total_pending_amount = 0;

        for (const t of allTotals) {
            total_net_payable += t.net_payable;
            total_paid_amount += t.paid_amount;
            total_pending_amount += Math.max(0, t.net_payable - t.paid_amount);
        }

        paginatedData.items = items;
        paginatedData.grand_totals = {
            total_net_payable: parseFloat(total_net_payable.toFixed(2)),
            total_paid_amount: parseFloat(total_paid_amount.toFixed(2)),
            total_pending_amount: parseFloat(total_pending_amount.toFixed(2))
        };

        return res.ok(paginatedData);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Enterprise Listing for "Run Payroll" View
 * Optimized for displaying many employees with real-time simulations
 */
exports.getMonthlyPayrollListing = async (req, res) => {
    try {
        const { month, year, branch_id, department_id, search, staff_type, show_inactive } = req.body;
        const company_id = req.user.company_id;

        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        const startOfMonth = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
        const endOfMonth = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

        // 1. Fetch All Applicable Employees
        const employeeWhere = { company_id, status: 1 };
        if (branch_id) employeeWhere.branch_id = branch_id;
        if (department_id) employeeWhere.department_id = department_id;
        if (staff_type) employeeWhere.staff_type = staff_type;
        if (show_inactive === true || show_inactive === 'true') delete employeeWhere.status;

        if (search) {
            employeeWhere[Op.or] = [
                { first_name: { [Op.iLike]: `%${search}%` } },
                { employee_code: { [Op.iLike]: `%${search}%` } }
            ];
        }

        const employees = await commonQuery.findAllRecords(Employee, employeeWhere, {
            attributes: ['id', 'first_name', 'employee_code', 'joining_date'],
            include: [
                { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                {
                    model: EmployeeSalaryTemplate,
                    as: 'employeeSalaryTemplate',
                    attributes: ['ctc_monthly', 'salary_type']
                }
            ],
            order: [['first_name', 'ASC']]
        });

        // 2. Fetch Existing Payslips (Finalized/Paid)
        const payslips = await commonQuery.findAllRecords(Payslip, {
            month, year, company_id,
            status: { [Op.in]: [1, 3] }
        });
        const payslipMap = new Map(payslips.map(p => [p.employee_id, p]));

        // 3. Fetch Payment History (Sum by Employee)
        const payments = await PaymentHistory.findAll({
            where: {
                company_id,
                payment_type: 'Salary',
                month,
                year
            },
            attributes: [
                'employee_id',
                [sequelize.fn('SUM', sequelize.col('amount')), 'total_paid']
            ],
            group: ['employee_id']
        });
        const paymentMap = new Map(payments.map(p => [p.employee_id, parseFloat(p.getDataValue('total_paid') || 0)]));

        // 4. Build Result Set
        const report = [];
        for (const emp of employees) {
            const existing = payslipMap.get(emp.id);
            const paidAmount = paymentMap.get(emp.id) || 0;

            let row = {
                id: emp.id,
                name: emp.first_name,
                employee_code: emp.employee_code,
                job_title: emp.designation?.designation_name || "N/A",
                joining_date: emp.joining_date,
                finalized: !!existing,
                status: existing ? (existing.status === 3 ? 'Paid' : 'Finalized') : 'No',
                ctc: emp.employeeSalaryTemplate?.ctc_monthly || 0,
                salary_type: emp.employeeSalaryTemplate?.salary_type || "Monthly",
                payslip_id: existing?.id || null,
                bank_verified: true, // Mock logic - could be from KYC
                slip_shared: false,   // Mock logic - could be from email logs
            };

            if (existing) {
                row.total_salary = parseFloat(existing.net_salary || 0).toFixed(2);
                row.payable_days = parseFloat(existing.pd_days || 0).toFixed(1);
            } else {
                // RUN SIMULATION
                try {
                    const sim = await performSalaryCalculation(emp.id, month, year, null, { skipStatutory: false });
                    row.total_salary = parseFloat(sim.salary.netPayable || 0).toFixed(2);
                    row.payable_days = parseFloat(sim.attendance.payableDays || 0).toFixed(1);
                } catch (e) {
                    row.total_salary = "0.00";
                    row.payable_days = "0";
                    row.error = e.message;
                }
            }

            row.paid = paidAmount.toFixed(2);
            row.pending = (parseFloat(row.total_salary) - paidAmount).toFixed(2);
            report.push(row);
        }

        return res.ok({
            month,
            year,
            total_count: report.length,
            grand_totals: {
                ctc: report.reduce((sum, r) => sum + parseFloat(r.ctc || 0), 0).toFixed(2),
                salary: report.reduce((sum, r) => sum + parseFloat(r.total_salary || 0), 0).toFixed(2),
                paid: report.reduce((sum, r) => sum + parseFloat(r.paid || 0), 0).toFixed(2),
                pending: report.reduce((sum, r) => sum + parseFloat(r.pending || 0), 0).toFixed(2)
            },
            data: report
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Bulk Finalize Payroll for multiple employees
 */
exports.bulkFinalizePayroll = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { employee_ids, month, year } = req.body;
        if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
            return res.error("VALIDATION_ERROR", { message: "List of employee IDs is required" });
        }

        for (const emp_id of employee_ids) {
            // Direct call without internal try-catch.
            // Any failure will trigger the outer catch and ROLLBACK the entire transaction.
            await internalFinalizePayroll(emp_id, month, year, false, transaction, req, []);
        }

        await transaction.commit();
        return res.success(`${employee_ids.length} payroll records finalized successfully`);
    } catch (err) {
        if (transaction && !transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Bulk Pay Payroll (Bulk Payment Entry)
 */
exports.bulkPayPayroll = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { payments, month, year } = req.body; // Array of {employee_id, amount, payment_mode}
        if (!Array.isArray(payments) || payments.length === 0) {
            return res.error("VALIDATION_ERROR", { message: "Payment list is required" });
        }

        for (const p of payments) {
            const payslip = await commonQuery.findOneRecord(Payslip, {
                employee_id: p.employee_id, month, year, status: 1
            }, {}, transaction);

            if (!payslip) {
                await transaction.rollback();
                return res.error("NOT_FOUND", { message: `No finalized payslip found for employee ID: ${p.employee_id}` });
            }

            const netPayable = parseFloat(payslip.net_salary || 0);
            const paymentAmount = parseFloat(p.amount || 0);

            // Validate payment amount (not exceeding net payable)
            const totalPaidResult = await commonQuery.findAllRecords(PaymentHistory, {
                ref_id: payslip.id,
                payment_type: 'Salary'
            }, {
                attributes: [[sequelize.fn('SUM', sequelize.col('amount')), 'total_paid']],
                raw: true
            }, transaction);

            const existingPaid = parseFloat(totalPaidResult[0]?.total_paid || 0);
            const totalPaid = paymentAmount + existingPaid;

            if (totalPaid > netPayable) {
                await transaction.rollback();
                return res.error("VALIDATION_ERROR", {
                    message: `Payment amount (${paymentAmount}) for employee ${p.employee_id} exceeds remaining payable (${(netPayable - existingPaid).toFixed(2)})`
                });
            }

            // Record history
            const createdPayment = await commonQuery.createRecord(PaymentHistory, {
                employee_id: p.employee_id,
                ref_id: payslip.id,
                payment_date: dayjs().format('YYYY-MM-DD'),
                month,
                year,
                amount: p.amount,
                payment_type: 'Salary',
                payment_mode: p.payment_mode || 'Bank',
                status: 1,
                user_id: req.user.id,
                company_id: req.user.company_id,
                branch_id: payslip.branch_id
            }, transaction);

            // Update payslip payment_history JSON (Mirroring paymentHistoryController logic)
            const currentPaymentHistory = payslip.payment_history || { advances_adjusted: [] };
            const salaryPayment = {
                id: createdPayment.id,
                amount: p.amount,
                payment_mode: p.payment_mode || 'Bank',
                payment_date: dayjs().format('YYYY-MM-DD'),
                payment_type: 'Salary'
            };

            if (!currentPaymentHistory.salary_payments) {
                currentPaymentHistory.salary_payments = [];
            }
            currentPaymentHistory.salary_payments.push(salaryPayment);

            const payslipUpdatePayload = {
                payment_history: currentPaymentHistory,
                paid_amount: totalPaid,
                pending_amount: netPayable - totalPaid
            };

            // Check if fully paid
            if (totalPaid >= netPayable) {
                payslipUpdatePayload.status = 3;
            }

            await commonQuery.updateRecordById(Payslip, payslip.id, payslipUpdatePayload, transaction);

            //  Send Paid Notification
            if (payslipUpdatePayload.status === 3) {
                try {
                    const targetUser = await commonQuery.findOneRecord(User, { employee_id: p.employee_id }, {}, transaction);
                    if (targetUser) {
                        const monthName = dayjs().month(payslip.month - 1).format('MMMM');
                        await createNotification({
                            user_id: targetUser.id,
                            title: "Salary Paid",
                            message: `Your salary for ${monthName} ${payslip.year} has been marked as paid.`,
                            type: "PAYROLL",
                            reference_id: payslip.id,
                            status_code: 0,
                            company_id: req.user.company_id,
                            branch_id: payslip.branch_id
                        }, transaction);
                    }
                } catch (notifyErr) {
                    console.error("Paid Notification Error:", notifyErr.message);
                }
            }
        }

        await transaction.commit();
        return res.success("All bulk payments recorded successfully");
    } catch (err) {
        if (transaction && !transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.getPaymentHistory = async (req, res) => {
    try {
        const { employee_id, month, year } = req.body;

        const paymentHistories = await commonQuery.findAllRecords(PaymentHistory,
            {
                employee_id,
                month,
                year
            },
            {
                attributes: [
                    "id",
                    "employee_id",
                    "amount",
                    "payment_type",
                    "payment_mode",
                    "payment_date",
                    "status"
                ]
            }
        );

        // Calculate sum of amounts
        const totalAmount = paymentHistories.reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0);

        return res.ok({
            paymentHistories,
            totalAmount: parseFloat(totalAmount.toFixed(2))
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPayrollSummary = async (req, res) => {
    const POST = req.body;
    try {
        const { month, year, ...employeeFilter } = POST;

        // Validate month and year
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        // 1. Get unique employee_ids from AttendanceDay for the given month/year
        const attendanceEmployees = await commonQuery.findAllRecords(AttendanceDay, {
            [Op.and]: [
                sequelize.where(sequelize.fn('EXTRACT', sequelize.literal('MONTH FROM attendance_date')), month),
                sequelize.where(sequelize.fn('EXTRACT', sequelize.literal('YEAR FROM attendance_date')), year),
                { status: { [Op.ne]: 2 } }
            ]
        }, {
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('employee_id')), 'employee_id']],
            raw: true
        }, null, { company_id: true });

        // 2. Get unique employee_ids from Payslip for the given month/year
        const payslipEmployees = await commonQuery.findAllRecords(Payslip, {
            month, year
        }, {
            attributes: [[sequelize.fn('DISTINCT', sequelize.col('employee_id')), 'employee_id']],
            raw: true
        });

        // 3. Combine unique employee IDs
        const employeeIds = new Set();
        attendanceEmployees.forEach(ae => employeeIds.add(ae.employee_id));
        payslipEmployees.forEach(pe => employeeIds.add(pe.employee_id));

        if (employeeIds.size === 0) {
            return res.ok({
                total_employees: 0,
                total_payable_amount: 0,
                total_paid_amount: 0,
                total_pending_amount: 0,
                total_earnings: {},
                total_deductions_breakdown: {},
                total_statutory: {}
            });
        }

        // Fetch all employees matching filter and who have active attendance/payslips
        const employees = await commonQuery.findAllRecords(
            Employee,
            {
                ...employeeFilter,
                id: { [Op.in]: Array.from(employeeIds) }
            },
            {
                attributes: ['id']
            }
        );

        // Fetch salary summary (existing payslip or fresh calculation) for all employees
        const summaries = await Promise.all(employees.map(async (emp) => {
            try {
                return await fetchSalarySummary(emp.id, month, year, { skipStatutory: false });
            } catch (err) {
                console.error(`[PAYROLL-SUMMARY] Error calculating salary for employee ${emp.id}:`, err.message);
                return {
                    failed: true,
                    salary: { netPayable: 0 },
                    breakdown: { earnings: [], deductions: [], statutory: {} }
                };
            }
        }));

        // Initialize summary object
        const summary = {
            total_employees: 0,
            total_payable_amount: 0,
            total_paid_amount: 0,
            total_pending_amount: 0,
            total_earnings: {},
            total_deductions_breakdown: {},
            total_statutory: {}
        };

        summaries.forEach(empSummary => {
            if (!empSummary) return;

            summary.total_employees += 1;

            const netPayable = Math.max(parseFloat(empSummary.salary?.netPayable || 0), 0);
            const paidSum = parseFloat(empSummary.payment_history?.grand_total || empSummary.payment_history?.salary?.sum || 0);

            summary.total_payable_amount += netPayable;
            summary.total_paid_amount += paidSum;

            // Process earnings breakdown
            if (empSummary.breakdown && empSummary.breakdown.earnings) {
                empSummary.breakdown.earnings.forEach(earning => {
                    const name = (earning.name || "").trim();
                    const amount = parseFloat(earning.actual_amount ?? earning.amount ?? 0);

                    if (!summary.total_earnings[name]) {
                        summary.total_earnings[name] = { amount: 0, count: 0 };
                    }
                    summary.total_earnings[name].amount += amount;
                    summary.total_earnings[name].count += 1;
                });
            }

            // Process deductions breakdown
            if (empSummary.breakdown && empSummary.breakdown.deductions) {
                empSummary.breakdown.deductions.forEach(deduction => {
                    const name = (deduction.name || "").trim();
                    const amount = parseFloat(deduction.actual_amount ?? deduction.amount ?? 0);

                    if (!summary.total_deductions_breakdown[name]) {
                        summary.total_deductions_breakdown[name] = { amount: 0, count: 0 };
                    }
                    summary.total_deductions_breakdown[name].amount += amount;
                    summary.total_deductions_breakdown[name].count += 1;
                });
            }

            // Process statutory deductions
            if (empSummary.breakdown && empSummary.breakdown.statutory) {
                Object.entries(empSummary.breakdown.statutory).forEach(([key, value]) => {
                    const name = key.trim();
                    const amount = parseFloat(value || 0);

                    if (amount > 0) {
                        if (!summary.total_statutory[name]) {
                            summary.total_statutory[name] = { amount: 0, count: 0 };
                        }
                        summary.total_statutory[name].amount += amount;
                        summary.total_statutory[name].count += 1;
                    }
                });
            }
        });

        summary.total_pending_amount = Math.max(summary.total_payable_amount - summary.total_paid_amount, 0);

        // Round all monetary values to 2 decimal places
        Object.keys(summary).forEach(key => {
            if (typeof summary[key] === 'number') {
                summary[key] = Math.round(summary[key] * 100) / 100;
            } else if (typeof summary[key] === 'object' && summary[key] !== null) {
                Object.keys(summary[key]).forEach(subKey => {
                    if (typeof summary[key][subKey] === 'object' && summary[key][subKey] !== null) {
                        if (typeof summary[key][subKey].amount === 'number') {
                            summary[key][subKey].amount = Math.round(summary[key][subKey].amount * 100) / 100;
                        }
                    }
                });
            }
        });

        return res.ok(summary);
    } catch (err) {
        return handleError(err, res, req);
    }
};