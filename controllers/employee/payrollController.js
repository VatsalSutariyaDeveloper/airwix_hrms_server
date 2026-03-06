const { AttendanceDay, Employee, SalaryTemplate, SalaryTemplateTransaction, SalaryComponent, Payslip, EmployeeIncentive, EmployeeAdvance, EmployeeSalaryTemplate, EmployeeSalaryTemplateTransaction, sequelize, IncentiveType, DesignationMaster, CanteenAttendance, CompanyMaster, LeaveRequest } = require("../../models");
const { commonQuery, handleError, fail } = require("../../helpers");
const { Op, QueryTypes, where } = require("sequelize");
const dayjs = require("dayjs");
const pdfService = require("../../helpers/functions/pdfService");
const path = require("path");
const fs = require("fs");
const { calculateTDS } = require("../../helpers/functions/salaryTaxCalculator");


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
        // Replace placeholders like {BASIC}, {GROSS} with actual values
        Object.keys(valuesMap).forEach(key => {
            const regex = new RegExp(`{${key}}`, 'g');
            evalStr = evalStr.replace(regex, valuesMap[key] || 0);
        });

        // Clean up any remaining non-math characters for safety
        evalStr = evalStr.replace(/[^0-9+\-*/().]/g, '');

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
                attributes: ['id', 'amount', 'payment_mode', 'payment_date', 'payroll_month'],
                where: {
                    payroll_month: { [Op.between]: [startDate, endDate] }
                }
            },
            {
                model: EmployeeIncentive,
                as: "employeeIncentive",
                attributes: ['id', 'amount', 'incentive_date', 'payroll_month'],
                where: {
                    payroll_month: { [Op.between]: [startDate, endDate] }
                }
            },

        ]
    }, transaction);
    
    if (!employee) {
        return fail("Employee not found.");
    }

    const employeeSalaryTemplate = employee.employeeSalaryTemplate;
    const baseSalaryTemplate = employee.salaryTemplate;

    if (!employeeSalaryTemplate && !baseSalaryTemplate) {
        return fail("Employee or Salary Template not found. Please map the employee first.");
    }

    // Determine which template to use (Override vs Base)
    const template = employeeSalaryTemplate || baseSalaryTemplate;
    
    // Normalize components list regardless of which template was used
    const rawComponents = employeeSalaryTemplate
        ? (employeeSalaryTemplate.employeeSalaryTemplateTransactions || [])
        : (baseSalaryTemplate.salaryTemplateTransactions || []);

    // Step A: Aggregate Counts
    let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, weeklyOffs = 0, holidays = 0, totalFine = 0, totalOTMins = 0;

    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
        employee_id,
        attendance_date: { [Op.between]: [startDate, endDate] },
        status: { [Op.ne]: 2 }
    }, {}, transaction);

    attendanceRecords.forEach(day => {
        switch (parseInt(day.status)) {
            case 0: case 12: presentDays++; break;
            case 1: case 13: halfDays++; break;
            case 3: weeklyOffs++; break;
            case 4: holidays++; break;
            case 5: absentDays++; break;
            case 6: leaveDays++; break;
        }
        totalFine += parseFloat(day.fine_amount || 0);
        totalOTMins += parseInt(day.overtime_minutes || 0);
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
    const totalLWP = absentDays + (halfDays * 0.5);

    // Step B: Calculate Gross
    const monthlyGross = parseFloat(template.ctc_monthly || 0);
    const daysInMonth = dayjs(startDate).daysInMonth();
    let daysInCalculation = daysInMonth;

    if (template.lwp_calculation_basis === "FIXED_30_DAYS") {
        daysInCalculation = 30;
    } else if (template.lwp_calculation_basis === "WORKING_DAYS") {
        daysInCalculation = daysInMonth - weeklyOffs;
    }
    
    const payableDaysValue = presentDays + (halfDays * 0.5) + leaveDays + holidays;
    // Step B.1: Calculate accurate Payable Days based on Basis
    let actualDaysValue = 0;
    if (template.lwp_calculation_basis === "WORKING_DAYS") {
        // Exclude Weekly Offs from payable days
        actualDaysValue = daysInMonth - weeklyOffs;
    } else if (template.lwp_calculation_basis === "FIXED_30_DAYS") {
        // Standard 30 days basis. Payable days = 30 - (Absent + Half Days)
        actualDaysValue = 30;
    } else {
        // Default: DAYS_IN_MONTH
        actualDaysValue = daysInMonth;
    }

    const perDaySalary = monthlyGross / (daysInCalculation || 1);
    const lwpDeductionTotal = totalLWP * perDaySalary;
    const perHourSalary = perDaySalary / 8;
    const otAmount = (totalOTMins / 60) * perHourSalary * 1.5;

    // Step E: Use advances and incentives from employee include (already fetched)
    const incentives = employee.employeeIncentive || [];
    const advances = employee.employeeAdvances || [];
    
    const totalIncentive = incentives.reduce((sum, i) => sum + parseFloat(i.amount || 0), 0);
    const totalAdvance = advances.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);

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
            base_amount: encashmentAmount,
            actual_amount: parseFloat(encashmentAmount.toFixed(2)),
            days: totalEncashedDays,
            is_encashment: true
        });
        takeHomeEarnings += encashmentAmount;
    }

    // Values map for formula evaluation
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

    // Pre-process components to resolve association issues
    const processedComponents = rawComponents.map(trans => {
        const isModel = typeof trans.get === 'function';
        const plain = isModel ? trans.get({ plain: true }) : trans;
        const comp = plain.component || plain.SalaryComponent || (isModel ? trans.get('component') : null);
        return { plain, comp };
    });
    // First pass to find Basic (many formulas depend on it)
    processedComponents.forEach(({ plain, comp }) => {
        if (comp && (comp.component_name.toLowerCase() === 'basic' || comp.component_name.toLowerCase().includes('system basic'))) {
            valuesMap.BASIC = parseFloat(plain.monthly_amount || 0);
        }
    });

    processedComponents.forEach(({ plain, comp }) => {
        if (!comp) return;

        let amount = parseFloat(plain.monthly_amount || 0);
        if (comp.calculation_type === 'FORMULA' && comp.formula) {
            amount = evaluateComponentFormula(comp.formula, valuesMap);
        }

        const nameKey = comp.component_name.toUpperCase().replace(/\s+/g, '_');
        valuesMap[nameKey] = amount;

        const isEmployer = plain.is_employer_contribution === true || plain.is_employer_contribution === 'true' || comp.component_type === 'EMPLOYER_CONTRIBUTION';

        if (isEmployer) {
            employer[comp.component_name] = (employer[comp.component_name] || 0) + amount;
            return;
        }

        if (comp.is_statutory) {
            statutory[comp.component_name] = (statutory[comp.component_name] || 0) + amount;
            if (comp.component_type === "DEDUCTION") {
                totalDeductions += amount;
            } else {
                takeHomeEarnings += amount;
            }
            return;
        }
        if (comp.component_type === "EARNING" || comp.component_type === "VARIABLE_EARNING") {
            const actualAmount = comp.is_lwp_impacted 
                ? parseFloat((amount - (totalLWP * (amount / daysInCalculation))).toFixed(2)) 
                : amount;
            
            earnings.push({
                name: comp.component_name,
                base_amount: amount,
                actual_amount: actualAmount
            });

            takeHomeEarnings += actualAmount;
        } else if (comp.component_type === "DEDUCTION") {
            const isFoodComp = comp.component_name.toLowerCase().includes('food') || comp.component_name.toLowerCase().includes('canteen');
            deductions.push({
                name: comp.component_name,
                amount: amount,
                is_food: isFoodComp,
                meal_count: lunchCount,
                rate: amount
            });
            totalDeductions += amount;
        } else if (comp.component_type === "BENEFIT") {
            earnings.push({
                name: comp.component_name,
                base_amount: amount,
                actual_amount: amount,
                is_benefit: true
            });
        }
    });

    // Add OT and Incentives
    if (otAmount > 0) {
        earnings.push({ name: "Overtime", base_amount: 0, actual_amount: parseFloat(otAmount.toFixed(2)), is_ot: true });
        takeHomeEarnings += otAmount;
    }

    // Add single Incentive earning with total amount
    if (totalIncentive > 0) {
        earnings.push({ name: "Incentive", base_amount: totalIncentive, actual_amount: parseFloat(totalIncentive.toFixed(2)), is_incentive: true });
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

    advances.forEach(adv => {
        const amt = parseFloat(adv.amount || 0);
        // Don't add individual advance deductions here - will be added as single total below
    });

    // Add single Advance Repayment deduction with total amount
    if (totalAdvance > 0) {
        deductions.push({ name: "Advance Repayment", amount: parseFloat(totalAdvance.toFixed(2)), is_advance: true });
        totalDeductions += totalAdvance;
    }

    // Step G: Calculate Statutory TDS (Tax Deducted at Source)
    let tdsAmount = 0;
    let tdsPercentage = 0;
    if (template.statutory_config && template.statutory_config.tds && template.statutory_config.tds.enabled) {
        const tdsConfig = template.statutory_config.tds;
        if (tdsConfig.calculation_type === 'Manual Amount') {
            tdsAmount = parseFloat(tdsConfig.amount || 0);
        } else if (tdsConfig.calculation_type !== 'None') {
            const annualGross = monthlyGross * 12;
            const regimeMap = {
                'System Calculated': 'new_regime',
                'New Regime': 'new_regime',
                'Old Regime': 'old_regime'
            };
            const regime = regimeMap[tdsConfig.calculation_type] || 'new_regime';
            const { monthlyTDS, percentage } = calculateTDS(annualGross, regime);
            tdsAmount = monthlyTDS;
            tdsPercentage = percentage;
        }
    }

    if (tdsAmount > 0) {
        statutory["Income Tax (TDS)"] = tdsAmount;
        statutory["Income Tax (TDS) %"] = tdsPercentage;
        totalDeductions += tdsAmount;
    }

    const netPayable = takeHomeEarnings - totalDeductions;

    return {
        employee: {
            id: employee.id,
            name: employee.first_name,
            code: employee.employee_code,
            template: template.template_name,
            designation: employee.designation?.designation_name,
            joining_date: employee.joining_date
        },
        period: { month, year, daysInMonth, daysInCalculation, monthName: dayjs(startDate).format('MMMM') },
        attendance: { presentDays, halfDays, absentDays, leaveDays, weeklyOffs, holidays, totalLWP, lunchCount, lunchHistory, payableDays: parseFloat(payableDaysValue).toFixed(2), actualDaysValue },
        salary: {
            ctc_monthly: monthlyGross,
            perDaySalary: perDaySalary.toFixed(2),
            lwpDeduction: lwpDeductionTotal.toFixed(2),
            totalFine: totalFine.toFixed(2),
            overtimeAmount: otAmount.toFixed(2),
            incentiveAmount: totalIncentive.toFixed(2),
            advanceAmount: totalAdvance.toFixed(2),
            encashmentAmount: encashmentAmount.toFixed(2),
            tdsPercentage: tdsPercentage.toFixed(2),
            netPayable: netPayable < 0 ? "0.00" : netPayable.toFixed(2),
            takeHomeEarnings: takeHomeEarnings.toFixed(2),
            totalDeductions: totalDeductions.toFixed(2)
        },
        breakdown: { earnings, deductions, statutory, employer },
        employee_advances_history: (employee.employeeAdvances || []).map(advance => advance.get({ plain: true })),
        employee_incentive_history: (employee.employeeIncentive || []).map(advance => advance.get({ plain: true })),
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
        breakdown: payslip.break_down || { 
            earnings: Object.entries(earningDetails).map(([name, val]) => ({ name, actual_amount: val, base_amount: 0 })),
            deductions: Object.entries(deductionDetails)
                .filter(([name]) => {
                    // Filter out statutory items from deductions if they exist in statutory_details
                    const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                    const normName = normalize(name);
                    const statutoryKeys = Object.keys(payslip.statutory_details || {}).map(k => normalize(k));
                    return !statutoryKeys.includes(normName);
                })
                .map(([name, val]) => ({ name, amount: val })),
            statutory: payslip.statutory_details || {},
            employer: payslip.employer_details || {}
        }
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
            leave_details: { "Leave": summary.attendance.leaveDays },
            lunch_count: summary.attendance.lunchCount || 0,
            
            // Dynamic JSON Components
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

exports.getEmployeePayslipList = async (req, res) => {
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
        if (!employee_id) {
            employee_id = req.user.employee_id;
        }
        if (!employee_id) {
            return res.error("VALIDATION_ERROR", { message: "Employee ID is required" });
        }

        // 1. Get unique months/years from AttendanceDay
        // Using raw query for efficiency on large attendance tables
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

        // 2. Get existing payslips to skip already finalized ones
        const existingPayslips = await commonQuery.findAllRecords(Payslip, {
            employee_id,
        });

        // 3. Combine unique months from attendance and existing payslips
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
                // Use values from existing payslip (Draft/Finalized/Paid)
                ctc = existing.fixed_gross || existing.ctc_monthly || 0;
                net_payable = existing.net_salary || existing.net_payable || 0;
                payslip_id = existing.id;
            } else {
                try {
                    // Dynamically calculate for months without a payslip record
                    const summary = await performSalaryCalculation(employee_id, am.month, am.year);
                    if (summary && summary.salary) {
                        ctc = summary.salary.ctc_monthly;
                        net_payable = summary.salary.netPayable;
                    }
                } catch (e) {
                    // If calculation fails (e.g. template not mapped), fall back to 0
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
            payroll_month: monthStr,
            status: { [Op.ne]: 2 }
        }, {
            include: [{ model: IncentiveType, as: "incentiveType", attributes: ["name"] }]
        });
        const advances = await commonQuery.findAllRecords(EmployeeAdvance, {
            employee_id: payslip.employee_id,
            payroll_month: monthStr,
            status: { [Op.ne]: 2 }
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
                deductions: Object.entries(deduction_details)
                    .filter(([name]) => {
                        // Filter out statutory items from deductions if they exist in statutory_details
                        const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                        const normName = normalize(name);
                        const statutoryKeys = Object.keys(payslip.statutory_details || {}).map(k => normalize(k));
                        return !statutoryKeys.includes(normName);
                    })
                    .map(([name, val]) => ({ name, amount: val })),
                statutory: payslip.statutory_details || {},
                employer: payslip.employer_details || {}
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
                const breakdown = payslip.break_down || { earnings: [], deductions: [] };
                const ot = parseFloat(payslip.ot_amount || 0);
                const fine = parseFloat(payslip.total_fine || 0);

                const earnList = (breakdown.earnings || []).map(e => ({ 
                    name: e.name, 
                    amount: parseFloat(e.actual_amount || 0).toFixed(2),
                    is_employer: e.is_employer || false 
                }));
                const dedList = (breakdown.deductions || []).map(d => ({ 
                    name: d.name, 
                    amount: parseFloat(d.amount || 0).toFixed(2),
                    is_food: d.is_food,
                    meal_count: d.meal_count,
                    rate: d.rate
                }));

                // Include Statutory Employee Deductions in list
                const statDetails = payslip.statutory_details || {};
                const tdsPercent = statDetails["Income Tax (TDS) %"];
                Object.entries(statDetails).forEach(([name, amount]) => {
                    const amt = parseFloat(amount || 0);
                    if (amt > 0 && name !== "Income Tax (TDS) %") {
                        dedList.push({ 
                            name, 
                            amount: amt.toFixed(2), 
                            is_statutory: true,
                            percentage: name === "Income Tax (TDS)" ? tdsPercent : null
                        });
                    }
                });

                if (ot > 0 && !earnList.find(e => e.is_ot || e.name === "Overtime")) earnList.push({ name: "Overtime", amount: ot.toFixed(2) });
                if (fine > 0 && !dedList.find(d => d.is_fine || d.name === "Fines")) dedList.push({ name: "Fines", amount: fine.toFixed(2) });

                const totalEarn = earnList.reduce((sum, e) => sum + (e.is_employer ? 0 : parseFloat(e.amount)), 0);
                const totalDed = dedList.reduce((sum, d) => sum + parseFloat(d.amount), 0);

                const lwpDays = parseFloat(payslip.wp_days || payslip.lwp_days || 0);
                const absentDays = parseFloat(payslip.absent_days || 0);
                const halfDays = (lwpDays - absentDays) / 0.5;
                const presentDays = parseFloat(payslip.present_days || 0);
                const leave_details = payslip.leave_details || {};
                const leaveDays = Object.values(leave_details).reduce((sum, val) => sum + parseFloat(val || 0), 0);
                const weeklyOffs = parseFloat(payslip.wo_days || payslip.weekly_offs || 0);
                const holidays = parseFloat(payslip.ph_days || payslip.holidays || 0);
                let payableDays = 0;
                if (basis === "WORKING_DAYS") {
                    payableDays = presentDays + (halfDays * 0.5) + leaveDays + holidays;
                } else if (basis === "FIXED_30_DAYS") {
                    payableDays = 30 - lwpDays;
                } else {
                    const daysInMonth = dayjs(`${m.year}-${m.month}-01`).daysInMonth();
                    payableDays = daysInMonth - lwpDays;
                }

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

                overview.push({
                    id: payslip.id,
                    month: m.month,
                    year: m.year,
                    month_label: `${monthName}, ${yearShort}`,
                    due_amount: payslip.net_salary || payslip.net_payable || 0,
                    date_range: `01 ${monthName}'${yearShort} - ${dayjs(`${m.year}-${m.month}-01`).endOf('month').format("DD MMM'YY")}`,
                    net_receivable: payslip.net_salary || payslip.net_payable || 0,
                    payable_days: payableDays.toFixed(1),
                    lwp_days: lwpDays || 0,
                    lunch_count: payslip.lunch_count || 0,
                    lunch_history: lunchHistory,
                    earnings: { total: totalEarn.toFixed(2), breakdown: earnList },
                    deductions: { total: totalDed.toFixed(2), breakdown: dedList },
                    statutory: payslip.statutory_details || {},
                    employer: payslip.employer_details || {},
                    breakdown: payslip.break_down || { earnings: [], deductions: [] }, 
                    payments: "0.00", // Will be filled below
                    adjustments: "0.00", // Will be filled below
                    ot_amount: ot.toFixed(2),
                    fine_amount: fine.toFixed(2),
                    ctc_monthly: payslip.ctc_monthly,
                    is_loaded: true,
                    is_finalized: true
                });
            } else if (shouldLoadDetails) {
                // Perform dynamic calculation
                try {
                    const summary = await performSalaryCalculation(employee_id, m.month, m.year);
                    const payableDays = parseFloat(summary.attendance.payableDays);
                    const daysInCalculation = summary.period.daysInCalculation || summary.period.daysInMonth;


                    // Calculate total amount from employeeAdvances
                    const totalAdvances = summary.employeeAdvances.reduce((sum, advance) => {
                        return sum + parseFloat(advance.amount || 0);
                    }, 0);

                    let earnList = [];
                    let dedList = summary.breakdown.deductions.map(d => ({ 
                        name: d.name, 
                        amount: parseFloat(d.amount || 0).toFixed(2),
                        is_food: d.is_food,
                        meal_count: d.meal_count,
                        rate: d.rate
                    }));

                    // Include Statutory Employee Deductions in dynamic list
                    const tdsPercent = (summary.breakdown.statutory || {})["Income Tax (TDS) %"];
                    Object.entries(summary.breakdown.statutory || {}).forEach(([name, amount]) => {
                        const amt = parseFloat(amount || 0);
                        if (amt > 0 && name !== "Income Tax (TDS) %") {
                            dedList.push({ 
                                name, 
                                amount: amt.toFixed(2), 
                                is_statutory: true,
                                percentage: name === "Income Tax (TDS)" ? tdsPercent : null
                            });
                        }
                    });

                    const ot = parseFloat(summary.salary.overtimeAmount || 0);
                    const fine = parseFloat(summary.salary.totalFine || 0);

                    // Include Employee Advances in deductions - single entry with total
                    if (summary.employeeAdvances && summary.employeeAdvances.length > 0) {
                        const totalAdvances = summary.employeeAdvances.reduce((sum, adv) => sum + parseFloat(adv.amount || 0), 0);
                        if (totalAdvances > 0) {
                            dedList.push({ name: "Advance Repayment", amount: totalAdvances.toFixed(2), is_advance: true });
                        }
                    }

                    if (isCurrentMonth) {
                        summary.breakdown.earnings.forEach(e => {
                            if (e.is_adjustment || e.is_ot || e.is_encashment) {
                                earnList.push({ name: e.name, amount: parseFloat(e.actual_amount || 0).toFixed(2), is_employer: e.is_employer });
                            } else {
                                const compPerDay = e.base_amount / daysInCalculation;
                                earnList.push({ name: e.name, amount: (compPerDay * payableDays).toFixed(2), is_employer: e.is_employer });
                            }
                        });
                    } else {
                        earnList = summary.breakdown.earnings.map(e => ({ name: e.name, amount: parseFloat(e.actual_amount || 0).toFixed(2), is_employer: e.is_employer }));
                    }

                    // Include Employee Incentives in earnings - single entry with total
                    let totalIncentives = 0;
                    if (summary.employeeIncentive && summary.employeeIncentive.length > 0) {
                        totalIncentives = summary.employeeIncentive.reduce((sum, inc) => sum + parseFloat(inc.amount || 0), 0);
                        if (totalIncentives > 0) {
                            earnList.push({ name: "Incentive", amount: totalIncentives.toFixed(2), is_incentive: true });
                        }
                    }

                    const totalEarn = earnList.reduce((sum, e) => sum + (e.is_employer ? 0 : parseFloat(e.amount)), 0);
                    const totalDed = dedList.reduce((sum, d) => sum + parseFloat(d.amount), 0);
                    const netPayable = totalEarn - totalDed;

                    overview.push({
                        month: m.month,
                        year: m.year,
                        month_label: `${monthName}, ${yearShort}`,
                        due_amount: netPayable.toFixed(2),
                        date_range: `01 ${monthName}'${yearShort} - ${isCurrentMonth ? dayjs().format("DD MMM'YY") : dayjs(`${m.year}-${m.month}-01`).endOf('month').format("DD MMM'YY")}`,
                        net_receivable: netPayable.toFixed(2),
                        payable_days: payableDays.toFixed(1),
                        actualDaysValue: summary.attendance.actualDaysValue || 0,
                        lwp_days: summary.attendance.totalLWP,
                        lunch_count: summary.attendance.lunchCount || 0,
                        lunch_history: summary.attendance.lunchHistory || [],
                        employee_advances_history: (summary.employeeAdvances || []).map(adv => ({
                            type: "advance",
                            id: adv.id,
                            amount: adv.amount,
                            payment_mode: adv.payment_mode,
                            payment_date: adv.payment_date,
                            payroll_month: adv.payroll_month
                        })),
                        employee_incentive_history: (summary.employeeIncentive || []).map(inc => ({
                            type: "incentive",
                            id: inc.id,
                            amount: inc.amount,
                            incentive_date: inc.incentive_date
                        })),
                        earnings: { total: totalEarn.toFixed(2), breakdown: earnList },
                        deductions: { total: totalDed.toFixed(2), breakdown: dedList },
                        statutory: summary.breakdown.statutory || {}, 
                        employer: summary.breakdown.employer || {},
                        breakdown: summary.breakdown, // Keep full breakdown if needed
                        payments: "0.00", 
                        adjustments: "0.00",
                        ot_amount: ot.toFixed(2),
                        fine_amount: fine.toFixed(2),
                        ctc_monthly: summary.salary.ctc_monthly,
                        total_advances: totalAdvances.toFixed(2),
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
                const incentives = await commonQuery.findAllRecords(EmployeeIncentive, { employee_id, payroll_month: monthStr, status: { [Op.ne]: 2 } });
                const advances = await commonQuery.findAllRecords(EmployeeAdvance, { employee_id, payroll_month: monthStr, status: { [Op.ne]: 2 } });
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
                deductions: Object.entries(deduction_details).map(([name, val]) => ({ name, amount: val })),
                statutory: payslip.statutory_details || {},
                employer: payslip.employer_details || {}
            };
        }

        // Add Statutory deductions into the deductions list for the PDF display
        const statutoryDeductions = Object.entries(breakdown.statutory || {}).map(([name, amount]) => ({
            name,
            amount: parseFloat(amount || 0)
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
                    payDate: dayjs(`${payslip.year}-${payslip.month}-01`).endOf('month').format('DD/MM/YYYY')
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
                    deductions: fullDeductionList
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
        const downloadLink = `${req.protocol}://${req.get('host')}/uploads/payslips/${filename}`;

        return res.ok({
            download_link: downloadLink,
            filename: filename
        });
    } catch (err) {
        return handleError(err, res, req);
    }
};
