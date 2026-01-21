const { LeaveBalance, LeaveTemplate, LeaveTemplateCategory, Employee, sequelize } = require("../models");
const { commonQuery, Op } = require("../helpers");
const dayjs = require("dayjs");

/**
 * Service to manage leave balances, including pro-rata calculations,
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
     * Often used for pro-rata joiners.
     */
    static calculateProRata(joiningDate, annualTotal, cycleEndDate, rule = 'THRESHOLD_BASED') {
        const join = dayjs(joiningDate);
        const end = dayjs(cycleEndDate);
        
        const monthlyRate = annualTotal / 12;
        
        // Months between joining and end of cycle (full months)
        let diffMonths = end.diff(join.add(1, 'month').startOf('month'), 'month') + 1;
        
        // Join month logic based on selected rule
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
        
        // Round to nearest 0.5
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
                    // Check if employee joined during this cycle or before
                    const joinDate = dayjs(employee.joining_date);
                    if (joinDate.isAfter(start)) {
                        // Pro-rata for joiners with configurable rule
                        allocated = this.calculateProRata(employee.joining_date, category.leave_count, end, template.join_month_rule);
                    } else {
                        // Full allocation for existing employees
                        allocated = category.leave_count;
                    }
                } else if (template.accrual_type === 'MONTHLY') {
                    // For monthly, they only get the current month's credit initially
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

                // Upsert balance record
                const existingBalance = await commonQuery.findOneRecord(LeaveBalance, {
                    employee_id: employeeId,
                    leave_category_id: category.id,
                    year: start.year() // We use start year as the identifier for the cycle
                }, {}, t);

                let balance;
                if (existingBalance) {
                    balance = await commonQuery.updateRecordById(LeaveBalance, existingBalance.id, {
                        total_allocated: allocated,
                        pending_leaves: allocated - (existingBalance.used_leaves || 0),
                        leave_template_id: templateId,
                        year: start.year()
                    }, t);
                } else {
                    balance = await commonQuery.createRecord(LeaveBalance, {
                        employee_id: employeeId,
                        leave_category_id: category.id,
                        year: start.year(),
                        leave_template_id: templateId,
                        total_allocated: allocated,
                        pending_leaves: allocated,
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
     * Batch job to add monthly credits. Called by Cron.
     */
    static async processMonthlyAccruals() {
        const transaction = await sequelize.transaction();
        try {
            // Find all active templates that use MONTHLY accrual
            const templates = await LeaveTemplate.findAll({
                where: { accrual_type: 'MONTHLY', status: 0 },
                include: [{ model: LeaveTemplateCategory, as: 'categories', where: { status: 0 } }],
                transaction
            });

            for (const template of templates) {
                // Find all employees assigned to this template
                const employees = await Employee.findAll({
                    where: { leave_template: template.id, status: 0 },
                    transaction
                });

                for (const employee of employees) {
                    const { start } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
                    
                    for (const category of template.categories) {
                        const monthlyRate = category.leave_count / 12;

                        const balance = await LeaveBalance.findOne({
                            where: {
                                employee_id: employee.id,
                                leave_category_id: category.id,
                                year: start.year()
                            },
                            transaction
                        });

                        if (balance) {
                            const newTotal = parseFloat(balance.total_allocated) + monthlyRate;
                            const newPending = parseFloat(balance.pending_leaves) + monthlyRate;
                            
                            await balance.update({
                                total_allocated: Math.round(newTotal * 2) / 2, // Keep to 0.5 rounding
                                pending_leaves: Math.round(newPending * 2) / 2
                            }, { transaction });
                        }
                    }
                }
            }

            await transaction.commit();
            console.log("✅ Monthly leave accruals processed successfully.");
        } catch (error) {
            await transaction.rollback();
            console.error("❌ Error processing monthly accruals:", error);
        }
    }

    /**
     * Year-End Reset Logic: Lapses or Carries Forward leaves.
     * Should be run daily at midnight.
     */
    static async processYearEndReset() {
        const transaction = await sequelize.transaction();
        try {
            const today = dayjs();
            
            // 1. Get all employees with active leave templates
            const employees = await Employee.findAll({
                where: { status: 0, leave_template: { [Op.ne]: null } },
                include: [{
                    model: LeaveTemplate,
                    as: 'leaveTemplate',
                    include: [{ model: LeaveTemplateCategory, as: 'categories', where: { status: 0 } }]
                }],
                transaction
            });

            for (const employee of employees) {
                const template = employee.leaveTemplate;
                if (!template) continue;

                // 2. Determine the cycle that JUST ENDED
                // We check if "yesterday" was the end of a cycle.
                const yesterday = today.subtract(1, 'day');
                const { end: lastCycleEnd } = this.getCycleDates(employee.joining_date, template.leave_policy_cycle);
                
                // If yesterday was the end of the calculated cycle, today is the first day of the new one.
                if (!yesterday.isSame(lastCycleEnd, 'day')) continue;

                console.log(`🔄 Processing Year-End Reset for Employee: ${employee.first_name} (${employee.employee_code})`);

                const lastYear = lastCycleEnd.year();
                
                for (const category of template.categories) {
                    // 3. Find current balance for the cycle that just ended
                    const lastBalance = await LeaveBalance.findOne({
                        where: {
                            employee_id: employee.id,
                            leave_category_id: category.id,
                            year: lastYear
                        },
                        transaction
                    });

                    if (!lastBalance) continue;

                    let carryForwardAmount = 0;

                    // 4. Apply Carry Forward Rules
                    if (category.unused_leave_rule === 'CARRY_FORWARD') {
                        const limit = parseFloat(category.carry_forward_limit || 0);
                        const remaining = parseFloat(lastBalance.pending_leaves || 0);
                        carryForwardAmount = Math.min(remaining, limit);
                    }

                    // 5. Initialize New Year Balance
                    // This will handle the base allocation (Upfront or first month of Monthly)
                    await this.initializeBalance(employee.id, template.id, transaction);

                    // 6. Update new balance with carry forward
                    const newYear = today.year();
                    const newBalance = await LeaveBalance.findOne({
                        where: {
                            employee_id: employee.id,
                            leave_category_id: category.id,
                            year: newYear
                        },
                        transaction
                    });

                    if (newBalance) {
                        newBalance.carry_forward_leaves = carryForwardAmount;
                        newBalance.pending_leaves = parseFloat(newBalance.pending_leaves) + carryForwardAmount;
                        await newBalance.save({ transaction });
                    }
                }
            }

            await transaction.commit();
            console.log("✅ Year-End leave reset processed successfully.");
        } catch (error) {
            await transaction.rollback();
            console.error("❌ Error processing year-end reset:", error);
        }
    }
}

module.exports = LeaveBalanceService;
