class PFService {
    static calculatePF(basicAmount, config) {
        const PF_WAGE_CEILING = 15000;
        const employeeRate = 0.12;
        const employerRate = 0.12;
        
        let pfWages = basicAmount;
        if (config.restrict_to_ceiling) {
            pfWages = Math.min(basicAmount, PF_WAGE_CEILING);
        }

        const employeePF = Math.round(pfWages * employeeRate);
        const epsRate = 0.0833;
        const epfRate = 0.0367;

        const epsAmount = Math.round(pfWages * epsRate);
        const epfAmount = employerPF - epsAmount;

        return {
            employee_pf: employeePF,
            employer_pf: Math.round(pfWages * employerRate),
            eps_amount: epsAmount,
            epf_amount: epfAmount,
            edli_amount: Math.round(pfWages * 0.005),
            admin_charges: Math.max(500, Math.round(pfWages * 0.005))
        };
    }
}

module.exports = PFService;
