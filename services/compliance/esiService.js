class ESIService {
    static calculateESI(grossAmount, config) {
        const ESI_CEILING = 21000;
        const employeeRate = 0.0075;
        const employerRate = 0.0325;

        // Check eligibility
        if (config.check_ceiling && grossAmount > ESI_CEILING) {
            return {
                employee_esi: 0,
                employer_esi: 0,
                is_eligible: false
            };
        }

        return {
            employee_esi: Math.ceil(grossAmount * employeeRate),
            employer_esi: Math.ceil(grossAmount * employerRate),
            is_eligible: true
        };
    }
}

module.exports = ESIService;
