const { AttendanceDay, Employee, SalaryTemplate, SalaryTemplateTransaction, SalaryComponent,  Payslip, sequelize } = require("../../models");
const { commonQuery, handleError, fail } = require("../../helpers");
const { Op } = require("sequelize");
const dayjs = require("dayjs");

/**
 * Payroll Controller - Phase 5 Conclusion
 * Handles the "consumption" of attendance data to generate salary summaries.
 */

/**
 * Internal helper to calculate salary for an employee
 */
const performSalaryCalculation = async (employee_id, month, year, transaction = null) => {
    const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
    const endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

    // 1. Fetch Employee with Salary Mapping
    const employee = await commonQuery.findOneRecord(Employee, employee_id, {
        include: [
            {
                model: SalaryTemplate,
                as: "salaryTemplate",
                include: [{ 
                    model: SalaryTemplateTransaction, 
                    include: [{ model: SalaryComponent }]
                }]
            }
        ]
    }, transaction);

    if (!employee || !employee.salaryTemplate) {
        return fail("Employee or Salary Template not found. Please map the employee first.");
    }

    const template = employee.salaryTemplate;
    const components = template.SalaryTemplateTransactions || [];

    // 2. Fetch Attendance Data for the month
    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
        employee_id,
        attendance_date: { [Op.between]: [startDate, endDate] }
    }, {}, transaction);

    // Step A: Aggregate Counts
    let presentDays = 0;
    let halfDays = 0;
    let absentDays = 0;
    let leaveDays = 0; // Approved Leaves
    let weeklyOffs = 0;
    let holidays = 0;
    let totalFine = 0;
    let totalOTMins = 0;

    attendanceRecords.forEach(day => {
        switch (day.status) {
            case 0: presentDays++; break;
            case 1: halfDays++; break;
            case 3: weeklyOffs++; break;
            case 4: holidays++; break;
            case 5: absentDays++; break;
            case 6: leaveDays++; break;
        }
        totalFine += parseFloat(day.fine_amount || 0);
        totalOTMins += parseInt(day.overtime_minutes || 0);
    });

    // Logic for LWP (Loss of Pay)
    const totalLWP = absentDays + (halfDays * 0.5);

    // Step B: Use Salary Template to calculate Gross
    const monthlyGross = parseFloat(template.ctc_monthly || 0);
    
    // Per Day Salary Calculation
    let daysInCalculation = 30; // Default
    const daysInMonth = dayjs(startDate).daysInMonth();

    if (template.lwp_calculation_basis === "DAYS_IN_MONTH") {
        daysInCalculation = daysInMonth;
    } else if (template.lwp_calculation_basis === "FIXED_30_DAYS") {
        daysInCalculation = 30;
    } else if (template.lwp_calculation_basis === "WORKING_DAYS") {
        daysInCalculation = daysInMonth - weeklyOffs;
    }

    const perDaySalary = monthlyGross / daysInCalculation;

    // Step C: DEDUCTIONS (LWP)
    const lwpDeduction = totalLWP * perDaySalary;

    // Step D: Apply Fines & OT
    const perHourSalary = perDaySalary / 8;
    const otAmount = (totalOTMins / 60) * perHourSalary * 1.5;

    // FINAL PAYABLE
    const netPayable = (monthlyGross - lwpDeduction - totalFine) + otAmount;

    // Prepare Detailed Breakdown
    const earnings = [];
    const deductions = [];

    components.forEach(trans => {
        const comp = trans.SalaryComponent;
        const amount = parseFloat(trans.monthly_amount || 0);
        
        if (comp?.component_type === "EARNING") {
            earnings.push({
                name: comp.component_name,
                base_amount: amount,
                actual_amount: comp.is_lwp_impacted ? (amount - (totalLWP * (amount / daysInCalculation))) : amount
            });
        } else {
            deductions.push({
                name: comp.component_name,
                amount: amount
            });
        }
    });

    return {
        employee: {
            id: employee.id,
            name: employee.first_name,
            code: employee.employee_code,
            template: template.template_name
        },
        period: { month, year, daysInMonth },
        attendance: { presentDays, halfDays, absentDays, leaveDays, weeklyOffs, holidays, totalLWP },
        salary: {
            ctc_monthly: monthlyGross,
            perDaySalary: perDaySalary.toFixed(2),
            lwpDeduction: lwpDeduction.toFixed(2),
            totalFine: totalFine.toFixed(2),
            overtimeAmount: otAmount.toFixed(2),
            netPayable: netPayable < 0 ? "0.00" : netPayable.toFixed(2)
        },
        breakdown: { earnings, deductions },
        meta: {
            branch_id: employee.branch_id,
            company_id: employee.company_id
        }
    };
};

exports.calculateMonthlySalary = async (req, res) => {
    try {
        const { employee_id, month, year } = req.body;
        if (!employee_id || !month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee, Month, and Year are required" });
        }
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
            ctc_monthly: summary.salary.ctc_monthly,
            present_days: summary.attendance.presentDays,
            absent_days: summary.attendance.absentDays,
            leave_days: summary.attendance.leaveDays,
            weekly_offs: summary.attendance.weeklyOffs,
            holidays: summary.attendance.holidays,
            lwp_days: summary.attendance.totalLWP,
            per_day_salary: summary.salary.perDaySalary,
            lwp_deduction: summary.salary.lwpDeduction,
            total_fine: summary.salary.totalFine,
            ot_amount: summary.salary.overtimeAmount,
            net_payable: summary.salary.netPayable,
            break_down_json: summary.breakdown,
            status: 1, // Finalized
            user_id: req.user.id || 0,
            branch_id: summary.meta.branch_id,
            company_id: summary.meta.company_id
        };

        const draft = await commonQuery.findOneRecord(Payslip, { employee_id, month, year, status: 0 }, {}, transaction);
        if (draft) {
            await commonQuery.updateRecordById(Payslip, draft.id, payslipPayload, transaction);
        } else {
            await commonQuery.createRecord(Payslip, payslipPayload, transaction);
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
        return res.success("PAYROLL_FINALIZED", { message: "Payroll finalized and attendance locked successfully", netPayable: summary.salary.netPayable });

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
                ctc: p.ctc_monthly,
                net_payable: p.net_payable,
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
                ctc: p.ctc_monthly,
                net_payable: p.net_payable,
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
        const { employee_id } = req.body;
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

        // 3. Combine and Format
        const result = [];
        for (const am of attendanceMonths) {
            const existing = existingPayslips.find(p => p.month === am.month && p.year === am.year);
            const monthName = dayjs().month(am.month - 1).format('MMM');
            
            let ctc = "0.00";
            let net_payable = "0.00";
            
            if (existing) {
                // Use values from existing payslip (Draft/Finalized/Paid)
                ctc = existing.ctc_monthly;
                net_payable = existing.net_payable;
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
                attributes: ['id', 'first_name', 'employee_code', 'designation', 'department_id', 'joining_date', 'uan_number', 'pan_number', 'bank_name', 'bank_account_number'],
                // Optional: include department name if needed
            }]
        });

        if (!payslip) {
            return res.error("NOT_FOUND", { message: "Payslip not found" });
        }

        const monthName = dayjs().month(payslip.month - 1).format('MMMM');
        
        // Final Formatting for UI "Data Pass"
        const formattedData = {
            id: payslip.id,
            employee: {
                id: payslip.employee?.id,
                name: payslip.employee?.first_name,
                code: payslip.employee?.employee_code,
                designation: payslip.employee?.designation,
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
                payDate: dayjs(`${payslip.year}-${payslip.month}-01`).endOf('month').format('DD/MM/YYYY')
            },
            attendance: {
                present: payslip.present_days,
                absent: payslip.absent_days,
                leave: payslip.leave_days,
                weekly_off: payslip.weekly_offs,
                holiday: payslip.holidays,
                lwp: payslip.lwp_days
            },
            salary: {
                ctc: payslip.ctc_monthly,
                perDay: payslip.per_day_salary,
                netPayable: payslip.net_payable,
                fine: payslip.total_fine,
                overtime: payslip.ot_amount,
                lwpDeduction: payslip.lwp_deduction
            },
            breakdown: payslip.break_down_json,
            status: payslip.status,
            status_text: payslip.status === 0 ? "Draft" : (payslip.status === 1 ? "Finalized" : "Paid")
        };

        return res.ok(formattedData);
    } catch (err) {
        return handleError(err, res, req);
    }
};
