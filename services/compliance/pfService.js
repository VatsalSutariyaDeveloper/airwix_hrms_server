class PFService {
    static calculatePF(basicAmount, config = {}) {
        const { 
            pf_calculation_type = 'PERCENTAGE', // PERCENTAGE, CAPPED, MANUAL
            pf_manual_amount = 0,
            restrict_to_ceiling = true 
        } = config;

        const PF_WAGE_CEILING = 15000;
        const PF_FIXED_LIMIT = 1800;
        const employeeRate = 0.12;
        const employerRate = 0.12;
        
        let employeePF = 0;
        let pfWages = basicAmount;

        if (pf_calculation_type === 'MANUAL') {
            employeePF = parseFloat(pf_manual_amount) || 0;
            // For manual, we still need pfWages for employer distribution if not restricted
            pfWages = basicAmount;
        } else if (pf_calculation_type === 'CAPPED') {
            // 12% of Basic, max 1800
            employeePF = Math.min(Math.round(basicAmount * employeeRate), PF_FIXED_LIMIT);
            pfWages = employeePF / employeeRate; // Back-calculate wages for EPS/EPF split
        } else {
            // Standard Percentage
            if (restrict_to_ceiling) {
                pfWages = Math.min(basicAmount, PF_WAGE_CEILING);
            }
            employeePF = Math.round(pfWages * employeeRate);
        }

        const employerPF = employeePF; // Usually matches employee contribution
        const epsRate = 0.0833;
        
        // Split employer PF into EPS and EPF
        // EPS is 8.33% of wages (capped at 15k ceiling usually)
        const epsWages = Math.min(pfWages, PF_WAGE_CEILING);
        const epsAmount = Math.round(epsWages * epsRate);
        const epfAmount = employerPF - epsAmount;

        return {
            employee_pf: employeePF,
            employer_pf: employerPF,
            eps_amount: epsAmount,
            epf_amount: epfAmount,
            edli_amount: Math.round(epsWages * 0.005),
            admin_charges: Math.max(500, Math.round(epsWages * 0.005))
        };
    }
}

module.exports = PFService;
