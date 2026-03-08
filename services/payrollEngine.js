class PayrollEngine {
    /**
     * Calculates payroll for an employee for a specific period.
     * 
     * @param {Object} employeeData - Employee details
     * @param {Object} attendanceData - Attendance summary (payable days, LWP, etc.)
     * @param {Object} templateData - Salary template details
     */
    static calculateEmployeePayroll(employeeData, attendanceData, templateData) {
        const { payable_days, total_days, lwp_days } = attendanceData;
        const components = templateData.employeeSalaryTemplateTransactions || [];
        
        const results = {
            earnings: [],
            deductions: [],
            employer_contributions: [],
            statutory: [],
            totals: {
                gross_salary: 0,
                net_salary: 0,
                total_deductions: 0,
                ctc: 0,
                take_home: 0
            }
        };

        // 1. Process EARNINGS first
        let totalEarnings = 0;
        components.filter(c => c.component.component_type === 'EARNING').forEach(comp => {
            const master = comp.component;
            let actualAmount = parseFloat(comp.monthly_amount);

            // Apply LWP impact if applicable
            if (master.is_lwp_impacted && lwp_days > 0) {
                actualAmount = (actualAmount / total_days) * payable_days;
            }

            // Rounding
            actualAmount = this.applyRounding(actualAmount, master.rounding_rule);

            results.earnings.push({
                component_id: master.id,
                name: master.component_name,
                basis_amount: comp.monthly_amount,
                actual_amount: actualAmount,
                is_taxable: master.is_taxable
            });

            if (master.is_part_of_gross) results.totals.gross_salary += actualAmount;
            if (master.is_part_of_ctc) results.totals.ctc += actualAmount;
            totalEarnings += actualAmount;
        });

        // 2. Process DEDUCTIONS
        let totalDeductions = 0;
        components.filter(c => c.component.component_type === 'DEDUCTION').forEach(comp => {
            const master = comp.component;
            let actualAmount = parseFloat(comp.monthly_amount);

            // Re-calculate if percentage based
            if (master.calculation_type === 'PERCENTAGE') {
                const basis = master.percentage_of === 'BASIC' ? results.earnings.find(e => e.name === 'Basic')?.actual_amount || 0 : results.totals.gross_salary;
                actualAmount = (basis * master.percentage_value) / 100;
            }

            actualAmount = this.applyRounding(actualAmount, master.rounding_rule);

            results.deductions.push({
                component_id: master.id,
                name: master.component_name,
                actual_amount: actualAmount
            });

            totalDeductions += actualAmount;
        });

        // 3. Process EMPLOYER CONTRIBUTIONS
        components.filter(c => c.component.component_type === 'EMPLOYER_CONTRIBUTION').forEach(comp => {
            const master = comp.component;
            let actualAmount = parseFloat(comp.monthly_amount);
            
            // LWP impact? Usually yes for PF/ESI
            if (master.is_lwp_impacted && lwp_days > 0) {
                actualAmount = (actualAmount / total_days) * payable_days;
            }

            actualAmount = this.applyRounding(actualAmount, master.rounding_rule);

            results.employer_contributions.push({
                component_id: master.id,
                name: master.component_name,
                actual_amount: actualAmount
            });

            if (master.is_part_of_ctc) results.totals.ctc += actualAmount;
        });

        results.totals.total_deductions = totalDeductions;
        results.totals.net_salary = totalEarnings - totalDeductions;
        results.totals.take_home = results.totals.net_salary; // Simplified for now

        return results;
    }

    static applyRounding(amount, rule) {
        if (rule === 'CEIL') return Math.ceil(amount);
        if (rule === 'FLOOR') return Math.floor(amount);
        return Math.round(amount);
    }
}

module.exports = PayrollEngine;
