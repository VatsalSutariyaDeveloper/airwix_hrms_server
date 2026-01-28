const { AttendanceDay, Employee, SalaryTemplate, SalaryTemplateTransaction, SalaryComponent, sequelize } = require("../../models");
const { commonQuery, handleError } = require("../../helpers");
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
        throw new Error("Employee or Salary Template not found. Please map the employee first.");
    }

    const template = employee.salaryTemplate;
    const components = template.SalaryTemplateTransactions || [];

    // 2. Fetch Attendance Data for the month
    const attendanceRecords = await commonQuery.findAllRecords(AttendanceDay, {
        employee_id,
        attendance_date: { [Op.between]: [startDate, endDate] },
        status: { [Op.ne]: 99 }
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
        
        if (comp.component_type === "EARNING") {
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
            name: `${employee.first_name} ${employee.last_name}`,
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

const { Payslip } = require("../../models");

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
            breakdown_json: summary.breakdown,
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
                errors.push({ employee_id: emp.id, name: `${emp.first_name} ${emp.last_name}`, error: err.message });
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
