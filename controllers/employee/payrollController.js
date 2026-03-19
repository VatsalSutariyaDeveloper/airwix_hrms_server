const { AttendanceDay, Employee, SalaryTemplate, SalaryTemplateTransaction, SalaryComponent, Payslip, EmployeeIncentive, EmployeeAdvance, EmployeeSalaryTemplate, EmployeeSalaryTemplateTransaction, sequelize, IncentiveType, DesignationMaster, CanteenAttendance, CompanyMaster, LeaveRequest, PaymentHistory, EmployeeWeeklyOff, EmployeeHoliday, ShiftTemplate, EmployeeLeaveBalance, LeaveTemplateCategory, LeaveTemplate, AttendanceTemplate, EmployeeAttendanceTemplate, Department, BranchMaster } = require("../../models");
const { commonQuery, handleError, fail } = require("../../helpers");
const { Op, QueryTypes, where } = require("sequelize");
const dayjs = require("dayjs");
const pdfService = require("../../helpers/functions/pdfService");
const path = require("path");
const fs = require("fs");
const { calculateTDS } = require("../../helpers/functions/salaryTaxCalculator");
const { handleExport } = require("../../helpers/functions/excelService");


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
    let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, weeklyOffs = 0, holidays = 0, totalFine = 0, totalOTMins = 0, totalWorkedMins = 0, totalOTAmount = 0;
    let unpaidLeaveDays = 0, compoffLeaveDays = 0;

    // Prefetch leave configurations to identify Unpaid or CompOff status
    const leaveBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
        employee_id,
        year
    }, {}, transaction, { company_id: true });

    // Also fetch categories from the employee's assigned leave template for name fallback
    let templateCategories = [];
    if (employee.leave_template) {
        templateCategories = await commonQuery.findAllRecords(LeaveTemplateCategory, {
            leave_template_id: employee.leave_template
        }, {}, transaction, { company_id: true });
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
    }, {}, transaction);
    
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
                if (catInfo) {
                    presentDays += 0.5; // Count as 0.5 present since they worked the other half
                    if (!catInfo.is_paid) unpaidLeaveDays += 0.5;
                    else if (catInfo.is_compoff) compoffLeaveDays += 0.5;
                    else leaveDays += 0.5;
                } else {
                    halfDays++; 
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
    const totalLWP = absentDays + (halfDays * 0.5) + unpaidLeaveDays;

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

    const payableDaysValue = presentDays + (halfDays * 0.5) + leaveDays + holidays;
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
        shift = await commonQuery.findOneRecord(ShiftTemplate, employee.shift_template, {}, transaction, false, { company_id: true });
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
        const totalPayableDays = presentDays + (halfDays * 0.5) + leaveDays + holidays + weeklyOffs;
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
    const includeOTInTotal = activeAttendanceTemplate ? activeAttendanceTemplate.include_overtime_in_total : true;
    
    const otAmount = includeOTInTotal ? totalOTAmount : 0;

    // Step E: Use advances and incentives from employee include (already fetched)
    const incentives = employee.employeeIncentive || [];
    const advances = employee.employeeAdvances || [];
    const totalIncentive = incentives.reduce((sum, i) => sum + parseFloat(i.amount || 0), 0);
    const totalAdvance = advances.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);

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
        PRESENT_DAYS: presentDays,
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
        if (calcType === 'ATTENDANCE_BASED') {
            actualAmount = parseFloat(((amount / daysInCalculation) * payableDaysValue).toFixed(2));
        } else if (comp.is_lwp_impacted || plain.is_lwp_impacted) {
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
        attendance: { presentDays, halfDays, absentDays, leaveDays, unpaidLeaveDays, compoffLeaveDays, weeklyOffs, holidays, totalLWP, lunchCount, lunchHistory, payableDays: parseFloat(payableDaysValue).toFixed(2), actualDaysValue, leave_category_details: leaveCategoryDetails },
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
    // Reconstruct attendance stats
    const lwpDays = parseFloat(payslip.wp_days || 0);
    const absentDays = parseFloat(payslip.absent_days || 0);
    const halfDays = (lwpDays - absentDays) / 0.5;
    const presentDays = parseFloat(payslip.present_days || 0);
    const leave_details = payslip.leave_details || {};
    const leaveDays = Object.values(leave_details).reduce((sum, val) => sum + parseFloat(val || 0), 0);
    const weeklyOffs = parseFloat(payslip.wo_days || 0);
    const holidays = parseFloat(payslip.ph_days || 0);

    // Fetch computation basis for calculation
    const employee = await commonQuery.findOneRecord(Employee, payslip.employee_id, {
        include: [{ model: EmployeeSalaryTemplate, as: 'employeeSalaryTemplate', attributes: ['lwp_calculation_basis'] }]
    });
    const basis = employee?.employeeSalaryTemplate?.lwp_calculation_basis || 'DAYS_IN_MONTH';

    let payableDaysValue = 0;
    if (basis === "WORKING_DAYS") {
        payableDaysValue = presentDays + (halfDays * 0.5) + leaveDays + holidays;
    } else if (basis === "FIXED_30_DAYS") {
        payableDaysValue = 30 - lwpDays;
    } else {
        const daysInMonth = dayjs(`${payslip.year}-${payslip.month}-01`).daysInMonth();
        payableDaysValue = daysInMonth - lwpDays;
    }
    const payableDays = parseFloat(payableDaysValue).toFixed(2);

    // Recalculate dynamic totals if needed, but primarily use stored values
    const monthName = dayjs().month(parseInt(payslip.month) - 1).format('MMMM');

    // Use dynamic JSON fields for earnings and deductions
    const earningDetails = payslip.earning_details || {};
    const deductionDetails = payslip.deduction_details || {};

    // For summary view, extract fine/misc from deduction_details
    let totalFine = Object.entries(deductionDetails)
        .filter(([name]) => {
            const n = name.toLowerCase();
            return n.includes('fine') || n.includes('misc') || n.includes('food') || n.includes('others') || n.includes('adjustment');
        })
        .reduce((sum, [, val]) => sum + parseFloat(val || 0), 0);

    // Similar for Incentives from earning_details
    let totalIncentive = Object.entries(earningDetails)
        .filter(([name]) => {
            const n = name.toLowerCase();
            return n.includes('incentive') || n.includes('bonus');
        })
        .reduce((sum, [, val]) => sum + parseFloat(val || 0), 0);

    // Fetch Payment History for the month
    const paymentHistories = await commonQuery.findAllRecords(PaymentHistory, {
        employee_id: payslip.employee_id,
        month: payslip.month,
        year: payslip.year,
        status: { [Op.ne]: 2 }
    }, {
        attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'payment_type']
    });
    const totalPaid = paymentHistories.reduce((sum, ph) => sum + parseFloat(ph.amount || 0), 0);

    let leaveBalances = payslip.leave_balances;
    if (!leaveBalances) {
        const rawLeaveBalances = await commonQuery.findAllRecords(EmployeeLeaveBalance, {
            employee_id: payslip.employee_id,
            year: payslip.year
        });
        leaveBalances = rawLeaveBalances.map(lb => ({
            leave_category_id: lb.leave_category_id,
            leave_category_name: lb.leave_category_name,
            used_leaves: lb.used_leaves,
            balance: lb.pending_leaves
        }));
    }

    return {
        id: payslip.id,
        is_finalized: true,
        employee: {
            id: payslip.employee?.id || payslip.employee_id,
            name: payslip.employee?.first_name || "Employee",
            code: payslip.employee?.employee_code || "N/A",
            designation: payslip.employee?.designation?.designation_name || "N/A"
        },
        period: {
            month: payslip.month,
            year: payslip.year,
            daysInMonth: dayjs(`${payslip.year}-${payslip.month}-01`).daysInMonth(),
            monthName
        },
        attendance: {
            presentDays,
            halfDays: halfDays > 0 ? halfDays : 0,
            absentDays,
            leaveDays,
            weeklyOffs,
            holidays,
            totalLWP: lwpDays,
            payableDays,
            lunch_count: payslip.lunch_count || 0,
            leave_details: payslip.leave_details || {}
        },
        salary: {
            ctc_monthly: payslip.fixed_gross || 0,
            perDaySalary: payslip.per_day_salary || 0,
            lwpDeduction: payslip.lwp_deduction || 0,
            totalFine: totalFine.toFixed(2),
            overtimeAmount: earningDetails['Overtime'] || earningDetails['OT Pay'] || 0,
            incentiveAmount: totalIncentive.toFixed(2),
            advanceAmount: deductionDetails['Advance'] || deductionDetails['Loan'] || 0,
            netPayable: payslip.net_salary || 0
        },
        leave_balances: leaveBalances,
        breakdown: {
            earnings: (payslip.break_down?.earnings || Object.entries(earningDetails).map(([name, val]) => ({ name, actual_amount: val }))),
            deductions: [
                ...Object.entries(deductionDetails)
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
            employer: payslip.break_down?.employer || payslip.employer_details || {},
            total_earnings: parseFloat(payslip.break_down?.total_earnings || Object.values(earningDetails).reduce((sum, val) => sum + parseFloat(val || 0), 0)).toFixed(2),
            total_deductions: [
                ...Object.entries(deductionDetails)
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
        },
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
        // tds_calculation_data: payslip.tds_calculation_data,
        // tdsDetails: payslip.tds_calculation_data
    };
};

exports.calculateMonthlySalary = async (req, res) => {
    try {
        const { employee_id, month, year } = req.body;
        if (!employee_id || !month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee, Month, and Year are required" });
        }

        // 1. Check if a finalized/paid payslip already exists.
        // If it does, we show the stored data instead of recalculating (important for Excel imports)
        const existingPayslip = await commonQuery.findOneRecord(Payslip, {
            employee_id,
            month,
            year,
            status: { [Op.in]: [1, 2] } // Finalized or Paid
        }, {
            include: [{
                model: Employee,
                as: "employee",
                attributes: ['id', 'first_name', 'employee_code'],
                include: [{ model: DesignationMaster, as: "designation", attributes: ['designation_name'] }]
            }]
        });

        if (existingPayslip) {            
            const summary = await formatPayslipToSummary(existingPayslip);
            return res.ok(summary);
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
        const { employee_id, month, year } = req.body;
        if (!employee_id || !month || !year) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { message: "Employee, Month, and Year are required" });
        }

        const summary = await performSalaryCalculation(employee_id, month, year, transaction);

        // Check if already finalized
        const existing = await commonQuery.findOneRecord(Payslip, {
            employee_id, month, year, status: { [Op.in]: [1, 2] }
        }, {}, transaction);

        if (existing) {
            await transaction.rollback();
            return res.error("ALREADY_FINALIZED", { message: "Payroll for this month is already finalized or paid." });
        }

        // Create or Update Draft
        const payslipPayload = {
            employee_id,
            month,
            year,
            // Attendance
            present_days: summary.attendance.presentDays,
            absent_days: summary.attendance.absentDays,
            pd_days: summary.attendance.payableDays,
            wp_days: summary.attendance.totalLWP, // Using wp_days for LWP
            wo_days: summary.attendance.weeklyOffs,
            ph_days: summary.attendance.holidays,
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

            // Summary Totals
            fixed_gross: summary.salary.ctc_monthly,
            paid_gross: summary.salary.takeHomeEarnings, // Total Earnings before deductions
            total_deduction: summary.salary.totalDeductions,
            net_salary: summary.salary.netPayable,

            break_down: summary.breakdown,
            tds_calculation_data: summary.tds_calculation_data,
            leave_balances: summary.leave_balances,
            status: 1, // Finalized
            user_id: req.user.id || 0,
            branch_id: summary.meta.branch_id,
            company_id: summary.meta.company_id
        };

        let finalizedPayslip;
        const draft = await commonQuery.findOneRecord(Payslip, { employee_id, month, year, status: 0 }, {}, transaction);
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
                
                // Use stored earnings and deductions from break_down
                const earnList = (breakdown.earnings || []).map(e => ({
                    name: e.name,
                    amount: parseFloat(e.amount || 0).toFixed(2),
                    is_benefit: e.is_benefit,
                    is_incentive: e.is_incentive,
                    is_employer: e.is_employer || false
                }));
                
                const dedList = (breakdown.deductions || []).map(d => ({
                    name: d.name,
                    amount: parseFloat(d.amount || 0).toFixed(2),
                    is_food: d.is_food,
                    meal_count: d.meal_count,
                    rate: d.rate,
                    is_statutory: d.is_statutory
                }));

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

                // Use stored totals from payslip breakdown
                const totalEarn = parseFloat(breakdown.total_earnings || 0);
                const totalDed = parseFloat(breakdown.total_deductions || 0);
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
/**
 * Get detailed TDS Deduction report across employees for a specific period
 */
exports.getTDSDeductionReport = async (req, res) => {
    return res.ok([]);
    /*
    try {
        const { month, year, branch_id } = req.body;
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        const where = {
            month: parseInt(month),
            year: parseInt(year),
            status: { [Op.in]: [1, 2] } // Finalized or Paid
        };

        if (branch_id) {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [{
                model: Employee,
                as: "employee",
                attributes: ['id', 'first_name', 'employee_code', 'pan_number'],
                include: [{ model: DesignationMaster, as: 'designation', attributes: ['designation_name'] }]
            }],
            order: [['employee_id', 'ASC']]
        });

        const reportData = [];

        payslips.forEach(payslip => {
            const tdsData = payslip.tds_calculation_data || {};
            const actualTds = parseFloat(payslip.statutory_details?.['Income Tax (TDS)'] || 0);

            reportData.push({
                    id: payslip.id,
                    employee_id: payslip.employee_id,
                    employee_name: payslip.employee?.first_name,
                    employee_code: payslip.employee?.employee_code,
                    pan_number: payslip.employee?.pan_number,
                    designation: payslip.employee?.designation?.designation_name,

                    // Detailed tax data from stored snapshot
                    annual_gross: tdsData.annualGross || 0,
                    standard_deduction: tdsData.standardDeduction || 0,
                    taxable_income: tdsData.taxableIncome || 0,
                    regime: tdsData.regime || 'new_regime',
                    annual_tax: tdsData.annualTax || 0,
                    tax_paid_already: tdsData.taxPaidAlready || 0,
                    monthly_tds: tdsData.monthlyTDS || 0,
                    percentage: tdsData.percentage || 0,
                    exemption_amount: parseFloat(tdsData.exemptions || 0),
                    total_deduction: payslip.total_deduction || 0,

                    // What was actually deducted in the finalized payslip
                    actual_tds_deducted: actualTds,
                    status: payslip.status
                });
        });

        return res.ok(reportData);
    } catch (err) {
        return handleError(err, res, req);
    }
    */
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
        });

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
                    await commonQuery.createRecord(Payslip, payslipPayload, transaction);
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
        
        const paymentHistories = await commonQuery.findAllRecords(PaymentHistory, {
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

exports.getEmployerContributionReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        const where = {
            month,
            year,
            status: { [Op.in]: [1, 3] } // Finalized or Paid
        };

        if (branch_id) {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['id', 'first_name', 'employee_code'],
                    include: [
                        {
                            model: DesignationMaster,
                            as: 'designation',
                            attributes: ['designation_name']
                        }
                    ]
                }
            ]
        });

        const report = payslips.map(ps => {
            const employerDetails = ps.employer_details || {};
            let totalContribution = 0;
            const contributionMap = {};

            // Extract values and calculate total
            Object.entries(employerDetails).forEach(([key, value]) => {
                const val = parseFloat(value || 0);
                contributionMap[key] = val;
                totalContribution += val;
            });

            return {
                id: ps.id,
                employee_id: ps.employee?.id,
                employee_name: ps.employee?.first_name,
                employee_code: ps.employee?.employee_code,
                designation: ps.employee?.designation?.designation_name,
                contribution: contributionMap,
                total_contribution: parseFloat(totalContribution.toFixed(2))
            };
        });

        return res.ok({
            report,
            month,
            year
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getCTCBreakdownReport = async (req, res) => {
    try {
        const { branch_id } = req.body;
        
        let where = { status: 0, company_id: req.user.company_id };
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const employees = await commonQuery.findAllRecords(Employee, where, {
            attributes: ['id', 'first_name', 'employee_code', 'branch_id'],
            include: [
                { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                { model: Department, as: 'department', attributes: ['name'] },
                { 
                    model: EmployeeSalaryTemplate, 
                    as: 'employeeSalaryTemplate',
                    include: [{
                        separate: true,
                        model: EmployeeSalaryTemplateTransaction,
                        as: 'employeeSalaryTemplateTransactions',
                        include: [{ model: SalaryComponent, as: 'component', attributes: ['component_name'] }]
                    }]
                }
            ]
        }, null, { company_id: true });

        const branches = await commonQuery.findAllRecords(BranchMaster, { company_id: req.user.company_id }, {}, null, { company_id: true });
        const branchMap = {};
        branches.forEach(b => branchMap[b.id] = b.branch_name);

        let allComponentNames = new Set();
        let reportData = [];

        employees.forEach(emp => {
            const template = emp.employeeSalaryTemplate;
            if (!template) return;

            let row = {
                employee_name: emp.first_name || '-',
                designation: emp.designation?.designation_name || '-',
                employee_code: emp.employee_code || '-',
                branch: branchMap[emp.branch_id] || '-',
                department: emp.department?.name || '-',
                ctc: parseFloat(template.ctc_monthly || 0),
                salary_type: template.salary_type || 'Monthly',
                components: {}
            };

            const sc = template.statutory_config || {};
            if (sc.employee_pf?.enabled) { row.components['Employee PF Contribution'] = sc.employee_pf.amount; allComponentNames.add('Employee PF Contribution'); }
            if (sc.employee_esi?.enabled) { row.components['Employee ESI Contribution'] = sc.employee_esi.amount; allComponentNames.add('Employee ESI Contribution'); }
            if (sc.pt?.enabled) { row.components['Professional Tax'] = sc.pt.amount; allComponentNames.add('Professional Tax'); }
            if (sc.employee_lwf?.enabled) { row.components['Employee LWF Contribution'] = sc.employee_lwf.amount; allComponentNames.add('Employee LWF Contribution'); }
            if (sc.employer_pf?.enabled) { row.components['Employer PF Contribution'] = sc.employer_pf.amount; allComponentNames.add('Employer PF Contribution'); }
            if (sc.employer_esi?.enabled) { row.components['Employer ESI Contribution'] = sc.employer_esi.amount; allComponentNames.add('Employer ESI Contribution'); }
            if (sc.employer_lwf?.enabled) { row.components['Employer LWF Contribution'] = sc.employer_lwf.amount; allComponentNames.add('Employer LWF Contribution'); }
            if (sc.pf_edli_admin?.enabled) { row.components['PF EDLI & Admin Charges'] = sc.pf_edli_admin.amount; allComponentNames.add('PF EDLI & Admin Charges'); }

            const trans = template.employeeSalaryTemplateTransactions || [];
            trans.forEach(tr => {
                if (tr.component?.component_name) {
                    const name = tr.component.component_name;
                    row.components[name] = parseFloat(tr.monthly_amount || 0);
                    allComponentNames.add(name);
                }
            });

            reportData.push(row);
        });

        // make sure basic salary is always first if it exists
        let cols = Array.from(allComponentNames);
        const basicIndex = cols.findIndex(c => c.toLowerCase() === 'basic salary' || c.toLowerCase() === 'basic');
        if (basicIndex > 0) {
            const b = cols.splice(basicIndex, 1)[0];
            cols.unshift(b);
        }

        return res.ok({
            categories: cols,
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getGeneratedPayslipReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        let where = { month, year, company_id: req.user.company_id, status: { [Op.ne]: 2 } }; // not deleted
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['first_name', 'employee_code', 'joining_date', 'pan_number', 'uan_number', 'pf_number', 'branch_id'],
                    include: [
                        { model: DesignationMaster, as: 'designation', attributes: ['designation_name'] },
                        { model: Department, as: 'department', attributes: ['name'] }
                    ]
                }
            ]
        }, null, { company_id: true });

        const branches = await commonQuery.findAllRecords(BranchMaster, { company_id: req.user.company_id }, {}, null, { company_id: true });
        const branchMap = {};
        branches.forEach(b => branchMap[b.id] = b.branch_name);

        let dynamicEarnings = new Set();
        let dynamicDeductions = new Set();
        let dynamicStatutory = new Set();

        let reportData = [];

        payslips.forEach(ps => {
            const emp = ps.employee || {};
            const bd = ps.break_down || {};
            const att = bd.attendance || {};
            const sal = bd.salary || {};

            let row = {
                employee_name: emp.first_name || '-',
                employee_code: emp.employee_code || '-',
                branch_name: branchMap[emp.branch_id] || '-',
                department: emp.department?.name || '-',
                designation: emp.designation?.designation_name || '-',
                joining_date: emp.joining_date || '-',
                pan_number: emp.pan_number || '-',
                uan_number: emp.uan_number || '-',
                pf_number: emp.pf_number || '-',
                
                salary_amount: parseFloat(sal.ctc_monthly || ps.fixed_gross || 0),
                salary_type: 'Monthly',
                
                days_in_month: ps.total_days || att.daysInMonth || 0,
                payable_days: ps.wp_days || att.payableDays || 0,
                present_days: ps.present_days || att.presentDays || 0,
                // double_present: 0,
                half_days: att.halfDays || 0,
                absent_days: ps.absent_days || att.absentDays || 0,
                holidays: ps.ph_days || att.holidays || 0,
                week_offs: ps.wo_days || att.weeklyOffs || 0,
                paid_leaves: att.leaveDays || 0,
                unpaid_leaves: att.unpaidLeaveDays || 0,
                
                total_payable_days: ps.wp_days || att.payableDays || 0,
                total_paid_days: ps.wp_days || att.payableDays || 0,
                actual_payable_days: ps.wp_days || att.payableDays || 0,
                paid_leave_amount: 0, 

                base_salary: 0,
                overtime: att.totalOTMins ? (att.totalOTMins/60).toFixed(2) : 0,
                overtime_amount: parseFloat(sal.overtimeAmount || 0),
                overtime_mins: att.totalOTMins || 0,
                
                earnings: {},
                deductions: {},
                statutory: {},
                
                net_salary: parseFloat(ps.net_salary || 0)
            };

            let earningsArr = ps.earning_details || (bd.breakdown?.earnings || []);
            if (!Array.isArray(earningsArr)) {
                earningsArr = Object.entries(earningsArr).map(([name, amount]) => ({ name, amount }));
            }
            
            earningsArr.forEach(e => {
                const name = e.name;
                const amt = parseFloat(e.amount || 0);
                if (name.toLowerCase().includes('basic') || name.toLowerCase().includes('base')) {
                    row.base_salary += amt;
                } else if (!name.toLowerCase().includes('overtime')) {
                    dynamicEarnings.add(name);
                    row.earnings[name] = (row.earnings[name] || 0) + amt;
                }
            });

            let dedArr = ps.deduction_details || (bd.breakdown?.deductions || []);
            if (!Array.isArray(dedArr)) {
                // If it's an object from DB, check against statutory_details keys for is_statutory flag
                const statObj = ps.statutory_details || (bd.breakdown?.statutory || {});
                dedArr = Object.entries(dedArr).map(([name, amount]) => ({ 
                    name, 
                    amount,
                    is_statutory: statObj.hasOwnProperty(name)
                }));
            }

            dedArr.forEach(d => {
                const name = d.name;
                const amt = parseFloat(d.amount || 0);
                // Exclude statutory items duplicated in deductions
                if (!d.is_statutory) {
                     dynamicDeductions.add(name);
                     row.deductions[name] = (row.deductions[name] || 0) + amt;
                }
            });

            // Fallback for statutory if it's stored in statutory_details directly
            const statObj = ps.statutory_details || (bd.breakdown?.statutory || {});
            Object.keys(statObj).forEach(k => {
                const amt = parseFloat(statObj[k] || 0);
                dynamicStatutory.add(k);
                row.statutory[k] = amt;
            });

            // Extract statutory from deductions array if it has is_statutory flag
            dedArr.forEach(d => {
                if (d.is_statutory) {
                    const name = d.name;
                    const amt = parseFloat(d.amount || 0);
                    dynamicStatutory.add(name);
                    row.statutory[name] = amt;
                }
            });

            reportData.push(row);
        });

        // Convert sets to arrays
        const earningColumns = Array.from(dynamicEarnings);
        const deductionColumns = Array.from(dynamicDeductions);
        const statutoryColumns = Array.from(dynamicStatutory);

        return res.ok({
            earningColumns,
            deductionColumns,
            statutoryColumns,
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getPFReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        let where = { month, year, company_id: req.user.company_id, status: { [Op.ne]: 2 } }; 
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['first_name', 'employee_code', 'uan_number', 'pf_number', 'branch_id', 'employee_type', 'worker_type']
                }
            ]
        }, null, { company_id: true });
        // payslips = payslips.get({ plain: true });
        // Filter out employees without PF
        // We consider someone in PF if they have UAN/PF OR if there's any PF amount in statutory/employer details.
        
        let reportData = [];
        payslips.forEach(ps => {
            const emp = ps.employee || {};
            const bd = ps.break_down || {};
            
            // Extraction helper to handle both Array and Object formats in JSON fields
            // It normalizes key names (trim + case-insensitive) since legacy data sometimes includes extra spaces
            const getValueFromJSON = (data, keys) => {
                // eslint-disable-next-line no-console
                console.log("Extracting PF value from data:", data, "with keys:", keys);
                if (!data) return 0;

                const normalizedKeys = (keys || []).map(k => (typeof k === 'string' ? k.trim().toLowerCase() : k));

                if (Array.isArray(data)) {
                    const found = data.find(item => {
                        const name = typeof item?.name === 'string' ? item.name.trim().toLowerCase() : '';
                        return normalizedKeys.includes(name);
                    });
                    return found ? parseFloat(found.amount || 0) : 0;
                }

                // Normalize object keys to allow matching keys with extra spaces/case differences
                const normalizedData = {};
                Object.entries(data).forEach(([k, v]) => {
                    if (typeof k === 'string') {
                        normalizedData[k.trim().toLowerCase()] = v;
                    }
                });

                for (const nk of normalizedKeys) {
                    if (normalizedData[nk] !== undefined) return parseFloat(normalizedData[nk] || 0);
                }

                return 0;
            };

            // 1. Extract Employee PF (from statutory or deductions)
            const statData = ps.statutory_details || (bd.breakdown?.statutory || {});
            const dedData = ps.deduction_details || (bd.breakdown?.deductions || {});
            const pfKeys = ['Employee PF', 'PF', 'EPF', 'Provident Fund'];
            let employee_pf = getValueFromJSON(statData, pfKeys);
            if (employee_pf === 0) {
                employee_pf = getValueFromJSON(dedData, pfKeys);
            }

            // 2. Extract Employer PF
            const employerData = ps.employer_details || (bd.breakdown?.employer || {});
            const empPfKeys = ['Employer PF', 'EPF Employer', 'Employer Contribution PF'];
            let employer_pf = getValueFromJSON(employerData, empPfKeys);
            
            // 3. Extract Basic Salary (often used as base for PF)
            const earnData = ps.earning_details || (bd.breakdown?.earnings || {});
            const basicKeys = ['Basic Salary', 'Basic', 'BASIC', 'Basic Pay'];
            let basic_salary = getValueFromJSON(earnData, basicKeys);

            let pf_edli_admin = getValueFromJSON(employerData, ['PF EDLI/Admin', 'EDLI', 'Admin Charges']);
            
            // If they have no PF deduction or contribution, skip them (unless they have pf config active)
            // Or just include all for now to let admin see zeroes if unconfigured
            
            // Indian PF logic rough calculation for PF wages if not saved explicitly
            // PF Wages is usually the base (Basic+DA) capped at 15000 or the actual base
            let pf_wages = 0;
            if (employee_pf > 0) {
                pf_wages = Math.round(employee_pf / 0.12);
            } else if (basic_salary > 0 && (emp.pf_number || emp.uan_number)) {
                // If PF is configured but deduction was 0 (maybe skipped or lwp), we might still want to show base
                pf_wages = basic_salary;
            }
            
            // In ECR, EPS (Pension) is 8.33% of PF Wages (Capped at 15000 usually)
            // EPF Diff is 3.67% of PF Wages
            let eps_wages = pf_wages > 15000 ? 15000 : pf_wages;
            let eps_contribution = Math.round(eps_wages * 0.0833);
            let epf_eps_diff = Math.round(employee_pf - eps_contribution);
            
            // If EPS is not enabled or different, rely on whatever data we have, but usually we just calculate ECR standard here
            
            // NCP Days (Non-contributing period) is basically LWP days
            const lwp_days = parseFloat(ps.wp_days || 0) < parseFloat(ps.total_days || 0) 
                             ? parseFloat(ps.total_days || 0) - parseFloat(ps.wp_days || 0) 
                             : 0;

            let row = {
                uan: emp.uan_number || '-',
                member_name: emp.first_name || '-',
                gross_wages: parseFloat((ps.fixed_gross || bd.salary?.ctc_monthly || 0)).toFixed(2),
                epf_wages: pf_wages,
                eps_wages: eps_wages,
                edli_wages: eps_wages, 
                epf_contri_remitted: Math.round(employee_pf), // 12%
                eps_contri_remitted: eps_contribution, // 8.33%
                epf_eps_diff_remitted: epf_eps_diff, // 3.67%
                ncp_days: lwp_days,
                refund_of_advances: 0,
                employee_code: emp.employee_code || '-',
                employee_type_label: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
                worker_type_label: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || 'N/A',
                pf_number: emp.pf_number || '-'
            };

            // Only include employees who actually have PF configured or deducted
            if (row.epf_contri_remitted > 0 || row.uan !== '-') {
                reportData.push(row);
            }
            
        });

        return res.ok({
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getESIReport = async (req, res) => {
    try {
        const { month, year, branch_id } = req.body;
        
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        let where = { month, year, company_id: req.user.company_id, status: { [Op.ne]: 2 } }; 
        if (branch_id && branch_id !== 'All' && branch_id !== 0 && branch_id !== '0') {
            where.branch_id = branch_id;
        }

        const payslips = await commonQuery.findAllRecords(Payslip, where, {
            include: [
                {
                    model: Employee,
                    as: 'employee',
                    attributes: ['first_name', 'employee_code', 'esi_number', 'branch_id', 'employee_type', 'worker_type']
                }
            ]
        }, null, { company_id: true });

        let reportData = [];

        payslips.forEach(ps => {
            const emp = ps.employee || {};
            const bd = ps.break_down || {};
            
            // Extraction helper to handle both Array and Object formats in JSON fields
            // It normalizes key names (trim + case-insensitive) since legacy data sometimes includes extra spaces
            const getValueFromJSON = (data, keys) => {
                if (!data) return 0;

                const normalizedKeys = (keys || []).map(k => (typeof k === 'string' ? k.trim().toLowerCase() : k));

                if (Array.isArray(data)) {
                    const found = data.find(item => {
                        const name = typeof item?.name === 'string' ? item.name.trim().toLowerCase() : '';
                        return normalizedKeys.includes(name);
                    });
                    return found ? parseFloat(found.amount || 0) : 0;
                }

                const normalizedData = {};
                Object.entries(data).forEach(([k, v]) => {
                    if (typeof k === 'string') {
                        normalizedData[k.trim().toLowerCase()] = v;
                    }
                });

                for (const nk of normalizedKeys) {
                    if (normalizedData[nk] !== undefined) return parseFloat(normalizedData[nk] || 0);
                }

                return 0;
            };

            // 1. Extract Employee ESI
            const statData = ps.statutory_details || (bd.breakdown?.statutory || {});
            const dedData = ps.deduction_details || (bd.breakdown?.deductions || {});
            const esiKeys = ['Employee ESI', 'ESI', 'ESIC'];

            let employee_esi = getValueFromJSON(statData, esiKeys);
            if (employee_esi === 0) {
                employee_esi = getValueFromJSON(dedData, esiKeys);
            }

            // 2. Extract Employer ESI
            const employerData = ps.employer_details || (bd.breakdown?.employer || {});
            let employer_esi = getValueFromJSON(employerData, ['Employer ESI', 'ESI Employer', 'Employer Contribution ESI']);
            
            // ESI calculation logic rough deduction check
            // Employee pays 0.75%, Employer pays 3.25% of gross wages usually.
            // Let's rely on actual total_earnings to determine ESI wages (which it usually is, capped or not depending on settings but normally ESIC requires actual Gross during return)
            const gross_earnings = parseFloat(ps.paid_gross || bd.salary?.takeHomeEarnings || 0).toFixed(2);
            
            const total_worked_days = parseFloat(ps.present_days || 0);

            let row = {
                ip_number: emp.esi_number || '-',
                ip_name: emp.first_name || '-',
                no_of_days_worked: total_worked_days,
                total_monthly_wages: gross_earnings,
                employee_share: employee_esi,
                employer_share: employer_esi,
                total_contribution: parseFloat((employee_esi + employer_esi).toFixed(2)),
                // reason_code_for_zero_working_days: total_worked_days === 0 ? 'LWD' : '-', // Provide a generic dummy reason e.g., Leave Without Pay if 0 days
                // last_working_day: '-',
                employee_code: emp.employee_code || '-',
                employee_type_label: { 1: "Staff", 2: "Worker", 3: "Contractor" }[emp.employee_type] || 'N/A',
                worker_type_label: { 1: "On-role", 2: "Off-role" }[emp.worker_type] || 'N/A',
            };

            // Only include employees who actually have ESI configured or deducted
            if (row.employee_share > 0 || row.employer_share > 0 || (row.ip_number && row.ip_number !== '-')) {
                reportData.push(row);
            }
            
        });

        return res.ok({
            reportData
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};
