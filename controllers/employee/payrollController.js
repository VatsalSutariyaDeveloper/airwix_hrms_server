const { AttendanceDay, Employee, SalaryTemplate, SalaryTemplateTransaction, SalaryComponent, Payslip, EmployeeIncentive, EmployeeAdvance, EmployeeSalaryTemplate, EmployeeSalaryTemplateTransaction, sequelize, IncentiveType, DesignationMaster, CanteenAttendance, CompanyMaster, LeaveRequest, PaymentHistory, EmployeeWeeklyOff, EmployeeHoliday, ShiftTemplate, EmployeeLeaveBalance, LeaveTemplateCategory, LeaveTemplate, AttendanceTemplate, EmployeeAttendanceTemplate, Department, BranchMaster } = require("../../models");
const { commonQuery, handleError, fail } = require("../../helpers");
const { Op } = require("sequelize");
const dayjs = require("dayjs");
const pdfService = require("../../helpers/functions/pdfService");
const path = require("path");
const fs = require("fs");
const { handleExport } = require("../../helpers/functions/excelService");
const { ensureLatestPayslip } = require("../../services/payrollService");
const { calculateTDS } = require("../../helpers/functions/salaryTaxCalculator");
const employee = require("../../models/employee");


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
const performSalaryCalculation = async (employee_id, month, year, transaction = null) => {
    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    const endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    // 1. Fetch Employee with Salary Mapping & Overrides using ORM for automatic nesting
    const employee = await commonQuery.findOneRecord(Employee, employee_id, {
        include: [
            {
                model: SalaryTemplate,
                as: "salaryTemplate",
                include: [{
                    model: SalaryTemplateTransaction,
                    as: "salaryTemplateTransactions",
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
                attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'month', 'year'],
                where: {
                    month: month,
                    year: year
                }
            },
            {
                model: EmployeeIncentive,
                as: "employeeIncentive",
                attributes: ['id', 'amount', 'incentive_date', 'month', 'year'],
                where: {
                    month: month,
                    year: year
                }
            },
            {
                model: EmployeeWeeklyOff,
                as: "employeeWeeklyOffs",
                where: { is_off: true, status: 0 },
                required: false
            },
            {
                model: EmployeeHoliday,
                as: "employeeHolidays",
                where: { 
                    date: { [Op.between]: [startDate, endDate] },
                    status: 0 
                },
                required: false
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
    const rawComponents = employeeSalaryTemplate
        ? (employeeSalaryTemplate.employeeSalaryTemplateTransactions || [])
        : (baseSalaryTemplate.salaryTemplateTransactions || []);

    // Step A: Aggregate Counts
    let presentDays = 0, halfDays = 0, uncategorizedHalfDays = 0, absentDays = 0, leaveDays = 0, weeklyOffs = 0, holidays = 0, totalFine = 0, totalOTMins = 0, totalWorkedMins = 0, totalOTAmount = 0;
    let unpaidLeaveDays = 0, compoffLeaveDays = 0;

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

    // A.1 Calculate Weekly Offs from EmployeeWeeklyOff
    const empWeeklyOffs = employee.employeeWeeklyOffs || [];
    const monthDaysCount = dayjs(startDate).daysInMonth();
    for (let d = 1; d <= monthDaysCount; d++) {
        const dateObj = dayjs(startDate).date(d);
        const dayOfWeek = dateObj.day();
        const weekNo = Math.ceil(d / 7);

        const isOff = empWeeklyOffs.find(wo => 
            wo.day_of_week === dayOfWeek && 
            (wo.week_no === 0 || wo.week_no === weekNo)
        );
        if (isOff) weeklyOffs++;
    }

    // A.2 Calculate Holidays from EmployeeHoliday
    // holidays = (employee.employeeHolidays || []).length;

    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
        employee_id,
        attendance_date: { [Op.between]: [startDate, endDate] },
        status: { [Op.ne]: 2 }
    }, {}, transaction, { company_id: true });
    
    const monthLeaveUsage = {}; // Track usage per category ID for the current month
    const leaveCategoryDetails = {}; // Track usage per category name for leave_details
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
                presentDays++; 
                break;
            case 1: case 13: 
                halfDays++; // Always track total half days for UI
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
                break;
            case 5: 
                absentDays++; 
                break;
            case 6: 
                if (catInfo) {
console.log(day)

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
        date: dayjs(r.getDataValue('date')).format('YYYY-MM-DD'),
        time: dayjs(r.getDataValue('created_at')).format('hh:mm A')
    }));
    const lunchCount = lunchHistory.length;

    // Logic for LWP
    const totalLWP = absentDays + (uncategorizedHalfDays * 0.5) + unpaidLeaveDays;
    
    // Total mathematically worked days
    const totalPresentDays = presentDays + (halfDays * 0.5);

    // Step B: Calculate Gross
    let monthlyGross = parseFloat(template.ctc_monthly || 0);
    const dailyRate = parseFloat(template.daily_rate || 0);
    const hourlyRate = parseFloat(template.hourly_rate || 0);
    const salaryType = template.salary_type || "Monthly";

    const daysInMonth = dayjs(startDate).daysInMonth();
    let daysInCalculation = daysInMonth;

    if (template.lwp_calculation_basis === "FIXED_30_DAYS") {
        daysInCalculation = 30;
    } else if (template.lwp_calculation_basis === "WORKING_DAYS") {
        daysInCalculation = daysInMonth - weeklyOffs;
    }

    const payableDaysValue = totalPresentDays + leaveDays + holidays;
    let actualDaysValue = 0;
    if (template.lwp_calculation_basis === "WORKING_DAYS") {
        actualDaysValue = daysInMonth - weeklyOffs;
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

    const lwpDeductionTotal = salaryType === "Monthly" ? (totalLWP * perDaySalary) : 0;
    
    // Check if Overtime should be included in total earnings based on attendance configuration
    const activeAttendanceTemplate = employee.employeeAttendanceTemplate || employee.attendanceTemplate;
    const includeOTInTotal = activeAttendanceTemplate ? (activeAttendanceTemplate.include_overtime_in_total === true || activeAttendanceTemplate.include_overtime_in_total === 'true') : false;
    console.log("includeOTInTotal", includeOTInTotal);
    const otAmount = includeOTInTotal ? totalOTAmount : 0;

    // Step E: Use advances and incentives from employee include (already fetched)
    const incentives = employee.employeeIncentive || [];
    const advances = employee.employeeAdvances || [];
    const totalIncentive = incentives.reduce((sum, i) => sum + parseFloat(i.amount || 0), 0);
    const totalAdvance = advances.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);

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

    // Fetch Payment History for the month
    const paymentHistories = await commonQuery.findAllRecords(PaymentHistory, {
        employee_id,
        month,
        year,
        status: { [Op.ne]: 2 }
    }, {
        attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'payment_type']
    }, transaction);
    const totalPaid = paymentHistories.reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0);

    // Step E.1: Fetch Approved Encashment Requests
    const encashments = await commonQuery.findAllRecords(LeaveRequest, {
        employee_id,
        approval_status: 3, // APPROVED
        is_encashment: true,
        start_date: { [Op.between]: [startDate, endDate] },
        status: 0
    }, {}, transaction);

    const totalEncashedDays = encashments.reduce((sum, e) => sum + parseFloat(e.total_days || 0), 0);
    const encashmentAmount = totalEncashedDays * perDaySalary;

    // Step F: Prepare Detailed Breakdown
    const earnings = [], deductions = [], statutory = {}, employer = {};
    let takeHomeEarnings = 0, totalDeductions = 0;

    // Add Encashment to earnings if any
    if (encashmentAmount > 0) {
        earnings.push({
            name: "Leave Encashment",
            // base_amount: encashmentAmount,
            amount: parseFloat(encashmentAmount.toFixed(2)),
            actual_amount: parseFloat(encashmentAmount.toFixed(2)),
            days: totalEncashedDays,
            is_encashment: true
        });
        takeHomeEarnings += encashmentAmount;
    }

    // Values map for formula evaluation - initialize with globals
    const valuesMap = {
        BASIC: 0,
        GROSS: monthlyGross,
        CTC: monthlyGross,
        CANTEEN_ATTENDANCE: lunchCount,
        DAYS_IN_MONTH: daysInMonth,
        PRESENT_DAYS: totalPresentDays,
        ABSENT_DAYS: absentDays,
        PAYABLE_DAYS: daysInMonth - totalLWP
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
            if (calcType === 'ATTENDANCE_BASED') {
                actualAmount = parseFloat(((amount / daysInCalculation) * payableDaysValue).toFixed(2));
            } else if (comp.is_lwp_impacted || plain.is_lwp_impacted) {
                actualAmount = parseFloat((amount - (totalLWP * (amount / daysInCalculation))).toFixed(2));
            }

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
        
        if (calcType === 'ATTENDANCE_BASED') {
            actualAmount = parseFloat(((amount / daysInCalculation) * payableDaysValue).toFixed(2));
        } else if ((comp.is_lwp_impacted || plain.is_lwp_impacted) && !isFoodComp) {
            actualAmount = parseFloat((amount - (totalLWP * (amount / daysInCalculation))).toFixed(2));
        }

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
            employer[comp.component_name] = (employer[comp.component_name] || 0) + amount;
            return;
        }
        if (comp.is_statutory) {
            statutory[comp.component_name] = (statutory[comp.component_name] || 0) + amount;
            if (comp.component_type === "DEDUCTION") {
                totalDeductions += amount;
                deductions.push({ name: comp.component_name, amount: amount, is_statutory: true });
            } else {
                takeHomeEarnings += amount;
                earnings.push({ name: comp.component_name, amount: amount, actual_amount: amount, is_statutory: true });
            }
            return;
        }        
        if (comp.component_type === "EARNING" || comp.component_type === "VARIABLE_EARNING") {
            let finalAmount = actualAmount;
            
            earnings.push({
                name: comp.component_name,
                amount: finalAmount,
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
                amount: actualAmount,
                is_food: isFoodComp,
                meal_count: lunchCount,
                rate: rateValue
            });
            totalDeductions += actualAmount;
        } else if (comp.component_type === "BENEFIT") {
            earnings.push({
                name: comp.component_name,
                amount: actualAmount,
                actual_amount: actualAmount,
                is_benefit: true
            });
            takeHomeEarnings += actualAmount;
        }
    });


    // Add OT and Incentives
    if (otAmount > 0) {
        earnings.push({ name: "Overtime", amount: parseFloat(otAmount.toFixed(2)), actual_amount: parseFloat(otAmount.toFixed(2)), is_ot: true });
        takeHomeEarnings += otAmount;
    }

    

    // Add single Incentive earning with total amount
    if (totalIncentive > 0) {
        earnings.push({ name: "Incentive", amount: parseFloat(totalIncentive.toFixed(2)), actual_amount: parseFloat(totalIncentive.toFixed(2)), is_incentive: true });
        takeHomeEarnings += totalIncentive;
    }

    // Remove individual incentive additions from the loop below
    // incentives.forEach(inc => {
    //     const amt = parseFloat(inc.amount || 0);
    //     earnings.push({ name: inc.incentiveType?.name || "Incentive", base_amount: amt, actual_amount: amt, is_adjustment: true });
    //     takeHomeEarnings += amt;
    // });

    if (totalFine > 0) {
        deductions.push({ name: "Fines", amount: parseFloat(totalFine.toFixed(2)), is_fine: true });
        totalDeductions += totalFine;
    }

    // Add advances to deductions
    // if (totalAdvance > 0) {
    //     deductions.push({ name: "Advance", amount: parseFloat(totalAdvance.toFixed(2)), is_advance: true });
    //     totalDeductions += totalAdvance;
    // }

    // Step G: Process Statutory Config (PF, ESI, PT, LWF)
    if (template.statutory_config) {
        const sc = template.statutory_config;

        const addStatRecord = (name, amount, isEmployer = false) => {
            if (!amount || amount <= 0) return;
            if (isEmployer) {
                if (!employer[name]) employer[name] = parseFloat(amount);
            } else {
                if (!statutory[name]) {
                    statutory[name] = parseFloat(amount);
                    if (!deductions.find(d => d.name === name)) {
                        deductions.push({ name, amount: parseFloat(amount), is_statutory: true });
                        totalDeductions += parseFloat(amount);
                    }
                }
            }
        };

        // Employee Shares
        if (sc.employee_pf?.enabled) addStatRecord("Employee PF", sc.employee_pf.amount, false);
        if (sc.employee_esi?.enabled) addStatRecord("Employee ESI", sc.employee_esi.amount, false);
        if (sc.pt?.enabled) addStatRecord("Professional Tax", sc.pt.amount, false);
        if (sc.employee_lwf?.enabled) addStatRecord("Employee LWF", sc.employee_lwf.amount, false);

        // Employer Shares
        if (sc.employer_pf?.enabled) addStatRecord("Employer PF", sc.employer_pf.amount, true);
        if (sc.employer_esi?.enabled) addStatRecord("Employer ESI", sc.employer_esi.amount, true);
        if (sc.employer_lwf?.enabled) addStatRecord("Employer LWF", sc.employer_lwf.amount, true);
        if (sc.pf_edli_admin?.enabled) addStatRecord("PF EDLI/Admin", sc.pf_edli_admin.amount, true);
    }

    /*
    // Step H: Calculate Statutory TDS (Tax Deducted at Source)
    let tdsAmount = 0;
    let tdsPercentage = 0;
    let tdsCalculationData = null;
    if (template.statutory_config && template.statutory_config.tds && template.statutory_config.tds.enabled) {
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

        if (tdsConfig.calculation_type === 'Fixed') {
            tdsAmount = parseFloat(tdsConfig.amount || 0);
            tdsCalculationData = { calculation_type: 'Manual', amount: tdsAmount, monthlyTDS: tdsAmount };
        } else if (tdsConfig.calculation_type !== 'None') {
            // Advanced Projection Approach: 
            // Estimated Annual Gross = Actual YTD (from prev months) + Current Month Actual + Projected Remaining Months
            const currentMonthActual = takeHomeEarnings;
            const projectedRemaining = parseFloat(template.ctc_monthly || 0) * (monthsRemaining - 1);
            
            const annualGross = actualYTD + currentMonthActual + projectedRemaining;
            
            // Map NEW/OLD to new_regime/old_regime
            const regime = tdsConfig.regime === 'OLD' ? 'old_regime' : 'new_regime';
            
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
        // statutory["Income Tax (TDS) %"] = tdsPercentage;
        deductions.push({ name: "Income Tax (TDS)", amount: tdsAmount, is_statutory: true });
        totalDeductions += tdsAmount;
    }
    */
    // let tdsCalculationData = null;

    // if (tdsAmount > 0) {
    //     statutory["Income Tax (TDS)"] = tdsAmount;
    //     statutory["Income Tax (TDS) %"] = tdsPercentage;
    //     deductions.push({ name: "Income Tax (TDS)", amount: tdsAmount, is_statutory: true });
    //     totalDeductions += tdsAmount;
    // }    
    const netPayable = takeHomeEarnings - totalDeductions;

    // Calculate totals for breakdown arrays
    const totalEarningsBreakdown = earnings.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
    const totalDeductionsBreakdown = deductions.reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);

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
        period: { month, year, daysInMonth, daysInCalculation, monthName: dayjs(startDate).format('MMMM') },
        attendance: { presentDays, halfDays, totalPresentDays, absentDays, leaveDays, unpaidLeaveDays, compoffLeaveDays, weeklyOffs, holidays, totalLWP, lunchCount, lunchHistory, payableDays: parseFloat(payableDaysValue).toFixed(1), actualDaysValue, leave_category_details: leaveCategoryDetails },
        salary: {
            ctc_monthly: monthlyGross,
            perDaySalary: perDaySalary.toFixed(2),
            lwpDeduction: lwpDeductionTotal.toFixed(2),
            totalFine: totalFine.toFixed(2),
            overtimeAmount: otAmount.toFixed(2),
            incentiveAmount: totalIncentive.toFixed(2),
            // advanceAmount: totalAdvance.toFixed(2),
            encashmentAmount: encashmentAmount.toFixed(2),
            // tdsPercentage: tdsPercentage.toFixed(2),
            netPayable: netPayable < 0 ? "0.00" : netPayable.toFixed(2),
            takeHomeEarnings: takeHomeEarnings.toFixed(2),
            totalDeductions: totalDeductions.toFixed(2)
        },
        breakdown: {
            earnings,
            deductions,
            statutory,
            employer,
            total_earnings: totalEarningsBreakdown.toFixed(2),
            total_deductions: totalDeductionsBreakdown.toFixed(2)
        },
        overtime_history: overtimeHistory,
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
                history: paymentHistories.filter(ph => ph.payment_type === 'Advance').map(ph => ({
                    id: ph.id,
                    amount: ph.amount,
                    payment_mode: ph.payment_mode,
                    payment_date: ph.payment_date,
                    payment_type: ph.payment_type
                })),
                sum: paymentHistories.filter(ph => ph.payment_type === 'Advance').reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0).toFixed(2)
            },
            grand_total: totalPaid.toFixed(2)
        },
        employee_incentive_history: (employee.employeeIncentive || []).map(advance => advance.get({ plain: true })),
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
    const monthName = dayjs().month(parseInt(payslip.month) - 1).format('MMMM');

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
    const encashmentAmount = getSum(earningDetails, ['encashment']);
    const advanceAmount = getSum(deductionDetails, ['advance', 'loan']);

    // 6. Payment History
    const paymentHistories = payslip.payment_history?.advances_adjusted || [];

    console.log("payslip.payment_history-------------------------------",payslip.payment_history);
    

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
            encashmentAmount: encashmentAmount.toFixed(2),
            advanceAmount: advanceAmount,
            netPayable: parseFloat(payslip.net_salary || 0).toFixed(2),
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
        employee_incentive_history: employeeIncentiveHistory,
        leave_balances: payslip.leave_balances || [],
    };
};

exports.calculateMonthlySalary = async (req, res) => {
    try {
        const { employee_id, month, year } = req.body;
        if (!employee_id || !month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee, Month, and Year are required" });
        }

        // 1. Check if a finalized/paid payslip already exists.
        // For multiple payslips, we might return an array or the first one.
        const existingPayslips = await commonQuery.findAllRecords(Payslip, {
            employee_id,
            month,
            year,
            status: { [Op.in]: [1, 3] } // Finalized or Paid
        }, {
            order: [['sequence', 'ASC']],
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
            return res.ok(summaries.length === 1 ? summaries[0] : { multiple: true, payslips: summaries });
        }

        // 2. Otherwise perform fresh calculation based on attendance and template
        const summary = await performSalaryCalculation(employee_id, month, year);
        
        return res.ok(summary);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.finalizeMonthlySalary = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { employee_id, month, year, generate_additional = false } = req.body;
        if (!employee_id || !month || !year) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { message: "Employee, Month, and Year are required" });
        }

        const summary = await performSalaryCalculation(employee_id, month, year, transaction);  
              
        // Check if already finalized (Main sequence)
        const existingMain = await commonQuery.findOneRecord(Payslip, {
            employee_id, month, year, sequence: 1, status: { [Op.in]: [1, 3] }
        }, {}, transaction);

        if (existingMain && !generate_additional) {
            await transaction.rollback();
            return res.error("ALREADY_FINALIZED", { message: "Main payroll for this month is already finalized. Use 'generate_additional' to create a supplementary payslip." });
        }

        // Logic for setting sequence
        let targetSequence = 1;
        if (generate_additional) {
            const lastPayslip = await commonQuery.findOneRecord(Payslip, {
                employee_id, month, year
            }, { order: [['sequence', 'DESC']] }, transaction);
            targetSequence = (lastPayslip?.sequence || 0) + 1;
        }

        // Create or Update Draft
        const payslipPayload = {
            employee_id,
            month,
            year,
            // Attendance
            days_in_calculation:summary.period.daysInCalculation,
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
            payment_history: {
                advances_adjusted: []
            },

            // Summary Totals
            fixed_gross: summary.salary.ctc_monthly,
            paid_gross: summary.salary.takeHomeEarnings, // Total Earnings before deductions
            total_deduction: summary.salary.totalDeductions,
            net_salary: summary.salary.netPayable,

            break_down: summary.breakdown,
            tds_calculation_data: summary.tds_calculation_data,
            leave_balances: summary.leave_balances,
            sequence: targetSequence,
            status: 1,
        };

        let finalizedPayslip;
        const draft = await commonQuery.findOneRecord(Payslip, { employee_id, month, year, status: 0, sequence: targetSequence }, {}, transaction);
        if (draft) {
            finalizedPayslip = await commonQuery.updateRecordById(Payslip, draft.id, payslipPayload, transaction);
        } else {
            finalizedPayslip = await commonQuery.createRecord(Payslip, payslipPayload, transaction);
        }

        // Find and update employee advances for this month/year
        const employeeAdvances = await commonQuery.findAllRecords(EmployeeAdvance, {
            employee_id,
            month,
            year,
            status: 0, // Only pending advances
            adjusted_in_payroll: false
        }, {}, transaction);

        const advances_adjusted = [];
        if (employeeAdvances.length > 0) {
            // Update all advances to mark them as adjusted in payroll
            await EmployeeAdvance.update(
                { adjusted_in_payroll: true, status: 1 }, // status 1 = Adjusted
                {
                    where: {
                        employee_id,
                        month,
                        year,
                        status: 0,
                        adjusted_in_payroll: false
                    },
                    transaction
                }
            );

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

        // Update payslip payment history with adjusted advances
        if (advances_adjusted.length > 0) {
            await commonQuery.updateRecordById(Payslip, finalizedPayslip.id, {
                payment_history: {
                    advances_adjusted: advances_adjusted
                }
            }, transaction);
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

        await transaction.commit();
        return res.success("PAYROLL_FINALIZED", {
            message: "Payroll finalized and attendance locked successfully",
            id: finalizedPayslip.id,
            netPayable: summary.salary.netPayable
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
                const summary = await performSalaryCalculation(emp.id, month, year);
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
            status: { [Op.in]: [1, 2] } // Finalized or Paid
        }, {
            order: [['year', 'DESC'], ['month', 'DESC']]
        });

        const formattedList = payslips.map(p => {
            const monthName = dayjs().month(p.month - 1).format('MMM');
            return {
                id: p.id,
                month: p.month,
                year: p.year,
                month_year_string: `${monthName} ${p.year}`,
                ctc: p.paid_gross || p.fixed_gross,
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
        const { year } = req.body;
        if (!year) {
            return res.error("VALIDATION_ERROR", { message: "Year is required" });
        }

       const data = await commonQuery.fetchPaginatedData(
        Payslip,
        {filter: {year}},
        [],
        {
            include:[
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
        {employee_id, year},
        {
            include:[
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

        return res.ok({items: processedData});
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
            {employee_id, year},
            {
                include:[
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
            const monthName = dayjs().month(p.month - 1).format('MMM');
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
        let { employee_id } = req.body;
        if (!employee_id){
            employee_id = req.user.employee_id;
        }
        const company_id = req.user.company_id;

        // If no employee_id provided, we assume we want the overall company-wide payroll cycles
        if (!employee_id) {
            // 1. Get unique months/years from AttendanceDay for the entire company
            const attendanceMonths = await sequelize.query(`
                SELECT DISTINCT 
                    EXTRACT(MONTH FROM attendance_date)::INTEGER as month,
                    EXTRACT(YEAR FROM attendance_date)::INTEGER as year
                FROM attendance_day ad
                JOIN employees e ON ad.employee_id = e.id
                WHERE e.company_id = :company_id AND ad.status != 2
                ORDER BY year DESC, month DESC
                LIMIT 24
            `, {
                replacements: { company_id },
                type: sequelize.QueryTypes.SELECT
            });

            // 2. Get existing payslip summaries by month/year
            const payslipSummaries = await Payslip.findAll({
                where: { company_id },
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
            attendanceMonths.forEach(am => monthSet.add(`${am.month}-${am.year}`));
            payslipSummaries.forEach(ps => monthSet.add(`${ps.month}-${ps.year}`));

            const sortedPeriods = Array.from(monthSet).map(key => {
                const [month, year] = key.split('-').map(Number);
                return { month, year };
            }).sort((a, b) => b.year - a.year || b.month - a.month);

            const result = sortedPeriods.map(period => {
                const summary = payslipSummaries.find(ps => parseInt(ps.month) === period.month && parseInt(ps.year) === period.year);
                const monthName = dayjs().month(period.month - 1).format('MMM');

                const statusValue = summary ? parseInt(summary.getDataValue('status')) : 0;

                return {
                    month: period.month,
                    year: period.year,
                    label: `${monthName} ${period.year}`,
                    ctc: summary ? parseFloat(summary.getDataValue('total_ctc') || 0).toFixed(2) : "0.00",
                    net_payable: summary ? parseFloat(summary.getDataValue('total_net_payable') || 0).toFixed(2) : "0.00",
                    employee_count: summary ? summary.getDataValue('employee_count') : 0,
                    status: statusValue === 0 ? "Draft" : (statusValue === 1 ? "Finalized" : (statusValue === 2 ? "Paid" : "Running"))
                };
            });

            return res.ok(result);
        }

        // If employee_id is provided, maintain original logic for individual employee history
        // 1. Get unique months/years from AttendanceDay
        const attendanceMonths = await sequelize.query(`
            SELECT DISTINCT 
                EXTRACT(MONTH FROM attendance_date)::INTEGER as month,
                EXTRACT(YEAR FROM attendance_date)::INTEGER as year
            FROM attendance_day
            WHERE employee_id = :employee_id AND status != 2
            ORDER BY year DESC, month DESC
        `, {
            replacements: { employee_id },
            type: sequelize.QueryTypes.SELECT
        });

        // 2. Get existing payslips
        const existingPayslips = await commonQuery.findAllRecords(Payslip, {
            employee_id,
        });

        // 3. Combine unique months
        const allPeriodKeys = new Set();
        attendanceMonths.forEach(am => allPeriodKeys.add(`${am.month}-${am.year}`));
        existingPayslips.forEach(ep => allPeriodKeys.add(`${ep.month}-${ep.year}`));

        const sortedPeriods = Array.from(allPeriodKeys).map(key => {
            const [month, year] = key.split('-').map(Number);
            return { month, year };
        }).sort((a, b) => b.year - a.year || b.month - a.month);

        // 4. Format Result
        const result = [];
        for (const am of sortedPeriods) {
            const existing = existingPayslips.find(p => p.month === am.month && p.year === am.year);
            const monthName = dayjs().month(am.month - 1).format('MMM');

            let ctc = "0.00";
            let net_payable = "0.00";
            let payslip_id = null;

            if (existing) {
                ctc = existing.fixed_gross || existing.ctc_monthly || 0;
                net_payable = existing.net_salary || existing.net_payable || 0;
                payslip_id = existing.id;
            } else {
                try {
                    const summary = await performSalaryCalculation(employee_id, am.month, am.year);
                    if (summary && summary.salary) {
                        ctc = summary.salary.ctc_monthly;
                        net_payable = summary.salary.netPayable;
                    }
                } catch (e) {
                    console.error(`Calculation failed for ${monthName} ${am.year}:`, e.message);
                }
            }

            result.push({
                month: am.month,
                year: am.year,
                label: `${monthName} ${am.year}`,
                is_calculated: !!existing,
                ctc,
                net_payable,
                payslip_id,
                status: existing ? (existing.status === 0 ? "Draft" : (existing.status === 1 ? "Finalized" : "Paid")) : "No Calculation"
            });
        }

        return res.ok(result);
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

        const monthName = dayjs().month(parseInt(payslip.month) - 1).format('MMMM');

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
            month: month,
            year: year,
            status: { [Op.ne]: 2 }
        }, {
            attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'payment_type']
        });
        const totalPaid = paymentHistories.reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0);

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
                advances: (parseFloat(payslip.deduct_advance || 0) + advances.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0)).toFixed(2)
            },
            adjustments: {
                incentives: incentives.map(i => ({ name: i.incentiveType?.name, amount: i.amount })),
                advances: advances.map(a => ({ name: "Advance repayment", amount: a.amount }))
            },
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
                    history: paymentHistories.filter(ph => ph.payment_type === 'Advance').map(ph => ({
                        id: ph.id,
                        amount: ph.amount,
                        payment_mode: ph.payment_mode,
                        payment_date: ph.payment_date,
                        payment_type: ph.payment_type
                    })),
                    sum: paymentHistories.filter(ph => ph.payment_type === 'Advance').reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0).toFixed(2)
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
            const monthName = dayjs().month(m.month - 1).format('MMM');
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
                const breakdown = payslip.break_down || { earnings: [], deductions: [] };
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
                
                const dedList = (breakdown.deductions || []).map(d => ({
                    name: d.name,
                    amount: parseFloat(d.amount || 0).toFixed(2),
                    is_food: d.is_food,
                    meal_count: d.meal_count,
                    rate: d.rate,
                    is_statutory: d.is_statutory
                }));

                // Also include deductions from deduction_details if not already covered
                const deductionDetails = payslip.deduction_details || {};
                Object.entries(deductionDetails).forEach(([name, amount]) => {
                    const amt = parseFloat(amount || 0);
                    if (amt > 0 && !dedList.find(d => d.name === name)) {
                        dedList.push({
                            name,
                            amount: amt.toFixed(2),
                            is_food: name.toLowerCase().includes('food'),
                            is_statutory: false
                        });
                    }
                });

                // Include Statutory Employee Deductions from stored statutory_details
                const statDetails = payslip.statutory_details || {};
                Object.entries(statDetails).forEach(([name, amount]) => {
                    const amt = parseFloat(amount || 0);
                    if (amt > 0 && name !== "Income Tax (TDS) %") {
                        dedList.push({
                            name,
                            amount: amt.toFixed(2),
                            is_statutory: true
                        });
                    }
                });

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
                    time: dayjs(r.getDataValue('created_at')).format('hh:mm A')
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

                // Create payment history structure
                const paymentHistory = {
                    salary: { history: [], sum: "0.00" },
                    advance: { history: [], sum: "0.00" },
                    grand_total: "0.00"
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
                    date_range: `01 ${monthName}'${yearShort} - ${isCurrentMonth ? dayjs().format("DD MMM'YY") : dayjs(`${m.year}-${m.month}-01`).endOf('month').format("DD MMM'YY")}`,
                    net_receivable: netPayable.toFixed(2),
                    payable_days: payableDays % 1 === 0 ? payableDays.toString() : payableDays.toFixed(1),
                    actualDaysValue: daysInMonth,
                    lwp_days: lwpDays || 0,
                    lunch_count: payslip.lunch_count || 0,
                    lunch_history: lunchHistory,
                    employee_incentive_history: employeeIncentiveHistory,
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
                    is_loaded: true,
                    is_finalized: true
                });
            } else if (shouldLoadDetails) {
                // Perform dynamic calculation
                try {
                    const summary = await performSalaryCalculation(employee_id, m.month, m.year);                      
                    const payableDays = parseFloat(summary.attendance.payableDays);
                    // const totalEarn = earnList.reduce((sum, e) => sum + (e.is_employer ? 0 : parseFloat(e.amount)), 0);
                    // const totalDed = dedList.reduce((sum, d) => sum + parseFloat(d.amount), 0);
                    const netPayable = summary.breakdown.total_earnings - summary.breakdown.total_deductions;

                    overview.push({
                        month: m.month,
                        year: m.year,
                        month_label: `${monthName}, ${yearShort}`,
                        due_amount: netPayable.toFixed(2),
                        date_range: `01 ${monthName}'${yearShort} - ${isCurrentMonth ? dayjs().format("DD MMM'YY") : dayjs(`${m.year}-${m.month}-01`).endOf('month').format("DD MMM'YY")}`,
                        net_receivable: netPayable.toFixed(2),
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
                        statutory: summary.breakdown.statutory || {},
                        employer: summary.breakdown.employer || {},
                        breakdown: summary.breakdown,
                        payment_history: summary.payment_history,
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
                    date_range: `01 ${monthName}'${yearShort} - ${dayjs(`${m.year}-${m.month}-01`).endOf('month').format("DD MMM'YY")}`,
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

exports.generatePayslipPdf = async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) {
            return res.error("VALIDATION_ERROR", { message: "Payslip ID is required" });
        }

        // Fetch Payslip with Employee and Designation details
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

        // Fetch company details
        const company = await commonQuery.findOneRecord(CompanyMaster, req.user.company_id, {
            attributes: ['company_name', 'address', 'logo_image']
        });

        const monthName = dayjs().month(parseInt(payslip.month) - 1).format('MMMM');

        // Granular attendance calculation
        const lwpDays = parseFloat(payslip.wp_days || payslip.lwp_days || 0);
        const absentDays = parseFloat(payslip.absent_days || 0);
        const halfDays = (lwpDays - absentDays) / 0.5;
        const presentDays = parseFloat(payslip.present_days || 0);
        const leave_details = payslip.leave_details || {};
        const weeklyOffs = parseFloat(payslip.wo_days || payslip.weekly_offs || 0);
        const holidays = parseFloat(payslip.ph_days || payslip.holidays || 0);

        // Construct breakdown if it's missing or compressed
        let breakdown = payslip.break_down;
        if (!breakdown || (!breakdown.earnings?.length && !breakdown.deductions?.length)) {
            const earning_details = payslip.earning_details || {};
            const deduction_details = payslip.deduction_details || {};

            breakdown = {
                earnings: Object.entries(earning_details).map(([name, val]) => ({ name, actual_amount: val })),
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
        const totalEarnings = (breakdown.earnings || []).reduce((sum, e) => sum + parseFloat(e.actual_amount || 0), 0);
        const totalDeductions = fullDeductionList.reduce((sum, d) => sum + d.amount, 0);

        const data = {
            payslipData: {
                employee: {
                    name: payslip.employee?.first_name,
                    code: payslip.employee?.employee_code,
                    designation: payslip.employee?.designation?.designation_name,
                    joining_date: payslip.employee?.joining_date ? dayjs(payslip.employee.joining_date).format('DD/MM/YYYY') : 'N/A'
                },
                period: {
                    label: `${monthName} ${payslip.year}`,
                    payDate: dayjs(payslip.created_at).format('DD/MM/YYYY')
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
                    earnings: (breakdown.earnings || []).map(e => ({ name: e.name, actual_amount: e.actual_amount })),
                    deductions: fullDeductionList,
                    total_earnings: totalEarnings.toFixed(2),
                    total_deductions: totalDeductions.toFixed(2)
                }
            },
            companyData: {
                company_name: company?.company_name || 'Airwix HRMS',
                address: company?.address || 'Gujarat, India'
            },
            totalEarnings,
            totalDeductions
        };

        const templatePath = path.join(process.cwd(), 'views', 'payslip', 'slip.ejs');
        const filename = `payslip_${id}_${Date.now()}.pdf`;
        const outputDir = path.join(process.cwd(), 'uploads', 'payslips');

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, filename);

        await pdfService.generatePdfFromTemplate(templatePath, data, outputPath);

        // Construct download link
        const downloadLink = `${process.env.FILE_SERVER_URL}payslips/${filename}`;

        return res.ok({
            download_link: downloadLink,
            filename: filename
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
            },
            true,
            "joining_date",
            { id: { [Op.in]: Array.from(employeeIds) } }
        );

        // 5. Fetch existing Payslips for current page's employees
        const filteredEmployeeIds = paginatedData.items.map(emp => emp.id);
        const existingPayslips = await commonQuery.findAllRecords(Payslip, {
            month, year, employee_id: { [Op.in]: filteredEmployeeIds }
        });
        const payslipMap = new Map(existingPayslips.map(p => [p.employee_id, p]));

        // 6. Fetch PaymentHistory for current page's employees for the given month/year
        const paymentHistories = await commonQuery.findAllRecords(PaymentHistory, {
            employee_id: { [Op.in]: filteredEmployeeIds },
            month,
            year
        });
        
        const paymentMap = new Map();
        paymentHistories.forEach(ph => {
            const currentAmount = paymentMap.get(ph.employee_id) || 0;
            paymentMap.set(ph.employee_id, currentAmount + parseFloat(ph.amount || 0));
        });

        // 7. Format Result items
        const items = [];
        for (const emp of paginatedData.items) {
            const existing = payslipMap.get(emp.id);
            let ctc = "0.00";
            let net_payable = "0.00";
            let payslip_id = null;
            let status = null;

            if (existing) {
                ctc = existing.fixed_gross || existing.ctc_monthly || 0;
                net_payable = existing.net_salary || existing.net_payable || 0;
                payslip_id = existing.id;
                status = existing.status;
            } else {
                try {
                    const sim = await performSalaryCalculation(emp.id, month, year);
                    if (sim && sim.salary) {
                        ctc = sim.salary.ctc_monthly;
                        net_payable = sim.salary.netPayable;
                    }
                } catch (e) {
                    console.error(`Simulation failed for employee ${emp.id}:`, e.message);
                }
            }

            // Get amount from PaymentHistory
            const amount = paymentMap.get(emp.id) || 0;
            const pending_amount = parseFloat(net_payable) - amount;
            items.push({
                id: emp.id,
                name: emp.first_name,
                employee_code: emp.employee_code,
                ctc,
                net_payable,
                amount,
                pending_amount,
                payslip_id,
                status
            });
        }

        paginatedData.items = items;
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
            status: { [Op.in]: [1, 2] }
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
                status: existing ? (existing.status === 2 ? 'Paid' : 'Finalized') : 'No',
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
                    const sim = await performSalaryCalculation(emp.id, month, year);
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

        const results = [];
        for (const emp_id of employee_ids) {
            try {
                // Individual finalizing logic (re-using existing logic)
                const summary = await performSalaryCalculation(emp_id, month, year, transaction);

                const payslipPayload = {
                    employee_id: emp_id,
                    month, year,
                    present_days: summary.attendance.presentDays,
                    absent_days: summary.attendance.absentDays,
                    pd_days: summary.attendance.payableDays,
                    wp_days: summary.attendance.totalLWP,
                    wo_days: summary.attendance.weeklyOffs,
                    ph_days: summary.attendance.holidays,
                    total_days: summary.period.daysInMonth,
                    leave_details: { 
                        "Paid Leave": summary.attendance.leaveDays || 0,
                        "Unpaid Leave": summary.attendance.unpaidLeaveDays || 0,
                        "Compoff": summary.attendance.compoffLeaveDays || 0
                    },
                    lunch_count: summary.attendance.lunchCount || 0,
                    salary_template_id: summary.employee.template_id,
                    earning_details: (summary.breakdown.earnings || []).reduce((acc, e) => { acc[e.name] = e.actual_amount; return acc; }, {}),
                    deduction_details: (summary.breakdown.deductions || []).reduce((acc, d) => { acc[d.name] = d.amount; return acc; }, {}),
                    statutory_details: summary.breakdown.statutory || {},
                    employer_details: summary.breakdown.employer || {},
                    fixed_gross: summary.salary.ctc_monthly,
                    paid_gross: summary.salary.takeHomeEarnings,
                    total_deduction: summary.salary.totalDeductions,
                    net_salary: summary.salary.netPayable,
                    break_down: summary.breakdown,
                    tds_calculation_data: summary.tds_calculation_data,
                    status: 1, // Finalized
                    user_id: req.user.id || 0,
                    company_id: req.user.company_id
                };

                // Check for existing to override
                const existing = await commonQuery.findOneRecord(Payslip, { employee_id: emp_id, month, year, status: { [Op.in]: [1, 2] } }, {}, transaction);
                if (!existing) {
                    const newPayslip = await commonQuery.createRecord(Payslip, payslipPayload, transaction);
                    
                    // 💸 Send Notification to Employee
                    try {
                        const { User: UserModel } = require("../../models");
                        const targetUser = await commonQuery.findOneRecord(UserModel, { employee_id: emp_id }, {}, transaction);
                        if (targetUser) {
                            const monthName = dayjs().month(month - 1).format('MMMM');
                            const { createNotification } = require("../../services/notificationService");
                            await createNotification({
                                user_id: targetUser.id,
                                title: "Payslip Generated",
                                message: `Your payslip for ${monthName} ${year} has been generated. You can now view and download it.`,
                                type: "PAYROLL",
                                reference_id: newPayslip.id,
                                status_code: 0,
                                company_id: req.user.company_id,
                                branch_id: payslipPayload.branch_id
                            }, transaction);
                        }
                    } catch (notifyErr) {
                        console.error("Payslip Notification Error:", notifyErr.message);
                    }

                    results.push({ id: emp_id, success: true });
                } else {
                    results.push({ id: emp_id, success: false, message: "Already finalized" });
                }
            } catch (e) {
                results.push({ id: emp_id, success: false, message: e.message });
            }
        }

        await transaction.commit();
        return res.success(`${results.filter(r => r.success).length} payroll records finalized successfully`, results);
    } catch (err) {
        if (transaction) await transaction.rollback();
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

        const stats = { success: 0, failed: 0 };
        for (const p of payments) {
            const payslip = await commonQuery.findOneRecord(Payslip, {
                employee_id: p.employee_id, month, year, status: 1
            }, {}, transaction);

            if (payslip) {
                // Record history
                await commonQuery.createRecord(PaymentHistory, {
                    employee_id: p.employee_id,
                    ref_id: payslip.id,
                    payment_date: dayjs().format('YYYY-MM-DD'),
                    amount: p.amount,
                    payment_type: 'Salary',
                    payment_mode: p.payment_mode || 'Bank',
                    status: 1,
                    user_id: req.user.id,
                    company_id: req.user.company_id,
                    branch_id: payslip.branch_id
                }, transaction);

                // Check if fully paid
                const totalPaidRes = await PaymentHistory.findOne({
                    where: { employee_id: p.employee_id, ref_id: payslip.id, payment_type: 'Salary' },
                    attributes: [[sequelize.fn('SUM', sequelize.col('amount')), 'paid']],
                    transaction
                });
                const totalPaid = parseFloat(totalPaidRes.getDataValue('paid') || 0);

                if (totalPaid >= parseFloat(payslip.net_salary)) {
                    await commonQuery.updateRecordById(Payslip, payslip.id, { status: 2 }, transaction);

                    // 💸 Send Paid Notification
                    try {
                        const { User: UserModel } = require("../../models");
                        const targetUser = await commonQuery.findOneRecord(UserModel, { employee_id: p.employee_id }, {}, transaction);
                        if (targetUser) {
                            const { createNotification } = require("../../services/notificationService");
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
                stats.success++;
            } else {
                stats.failed++;
            }
        }

        await transaction.commit();
        return res.success(`Generated ${stats.success} payment entries.`, stats);
    } catch (err) {
        if (transaction) await transaction.rollback();
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

       const employee = await commonQuery.findAllRecords(
        Employee,
        employeeFilter,
        {
                include: [
                    {
                        model: Payslip,
                        as: "payslips",
                        where: {
                            month: month,
                            year: year
                        },
                        required: true
                    },
                    {
                        model: PaymentHistory,
                        as: "paymentHistories",
                        where: {
                            month: month,
                            year: year
                        },
                        required: false
                    }
                ]
            }
       )

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

        // Process each employee and accumulate totals
        employee.forEach(emp => {
            const payslips = emp.payslips || [];
            const paymentHistories = emp.paymentHistories || [];
            
            // Count employees
            summary.total_employees += 1;
            
            payslips.forEach(payslip => {
                summary.total_payable_amount += parseFloat(payslip.net_salary || 0);

                // Process earnings breakdown
                if (payslip.break_down && payslip.break_down.earnings) {
                    payslip.break_down.earnings.forEach(earning => {
                        const name = earning.name.trim();
                        const amount = parseFloat(earning.actual_amount || 0);
                        
                        if (!summary.total_earnings[name]) {
                            summary.total_earnings[name] = { amount: 0, count: 0 };
                        }
                        summary.total_earnings[name].amount += amount;
                        summary.total_earnings[name].count += 1;
                    });
                }

                // Process deductions breakdown
                if (payslip.break_down && payslip.break_down.deductions) {
                    payslip.break_down.deductions.forEach(deduction => {
                        const name = deduction.name.trim();
                        const amount = parseFloat(deduction.amount || 0);
                        
                        if (!summary.total_deductions_breakdown[name]) {
                            summary.total_deductions_breakdown[name] = { amount: 0, count: 0 };
                        }
                        summary.total_deductions_breakdown[name].amount += amount;
                        summary.total_deductions_breakdown[name].count += 1;
                    });
                }

                // Process statutory deductions
                if (payslip.break_down && payslip.break_down.statutory) {
                    Object.entries(payslip.break_down.statutory).forEach(([key, value]) => {
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

            // Calculate paid amount from payment histories
            paymentHistories.forEach(ph => {
                summary.total_paid_amount += parseFloat(ph.amount || 0);
            });
        });

        summary.total_pending_amount = summary.total_payable_amount - summary.total_paid_amount;

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

