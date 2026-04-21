
/**
 * Salary Tax (TDS) Calculator Helper
 * Calculates Income Tax based on Indian Tax Regimes for FY 2024-25
 */

/**
 * Salary Tax (TDS) Calculator Helper
 * Calculates Income Tax based on Indian Tax Regimes for FY 2024-25 (Post-Budget)
 */

const calculateTDS = (annualGross, regime = 'new_regime', exemptions = 0, taxPaidAlready = 0, monthsLeft = 12) => {
    // 1. Determine Standard Deduction
    // Post-Budget 2024: New Regime = 75,000, Old Regime = 50,000
    const standardDeduction = regime === 'new_regime' ? 75000 : 50000;
    
    // 2. Net Taxable Income
    // Exemptions (80C, HRA, etc.) are generally only applicable in the Old Regime
    const applicableExemptions = regime === 'old_regime' ? exemptions : 0;
    const taxableIncome = Math.max(0, annualGross - standardDeduction - applicableExemptions);
    
    let tax = 0;

    if (regime === 'new_regime' || regime === 'smart') {
        // New Tax Regime Slabs (FY 2024-25 Post-Budget)
        // 0 - 3L: Nil
        // 3 - 7L: 5%
        // 7 - 10L: 10%
        // 10 - 12L: 15%
        // 12 - 15L: 20%
        // > 15L: 30%

        if (taxableIncome > 1500000) {
            tax += (taxableIncome - 1500000) * 0.30;
            tax += 300000 * 0.20; // 12L to 15L
            tax += 200000 * 0.15; // 10L to 12L
            tax += 300000 * 0.10; // 7L to 10L
            tax += 400000 * 0.05; // 3L to 7L
        } else if (taxableIncome > 1200000) {
            tax += (taxableIncome - 1200000) * 0.20;
            tax += 200000 * 0.15;
            tax += 300000 * 0.10;
            tax += 400000 * 0.05;
        } else if (taxableIncome > 1000000) {
            tax += (taxableIncome - 1000000) * 0.15;
            tax += 300000 * 0.10;
            tax += 400000 * 0.05;
        } else if (taxableIncome > 700000) {
            tax += (taxableIncome - 700000) * 0.10;
            tax += 400000 * 0.05;
        } else if (taxableIncome > 300000) {
            tax += (taxableIncome - 300000) * 0.05;
        }
    } else if (regime === 'old_regime') {
        // Old Tax Regime Slabs (FY 2024-25)
        // 0 - 2.5L: Nil
        // 2.5 - 5L: 5%
        // 5 - 10L: 20%
        // > 10L: 30%
        
        if (taxableIncome <= 500000) {
            tax = 0; // Section 87A Rebate
        } else {
            if (taxableIncome > 1000000) {
                tax += (taxableIncome - 1000000) * 0.30;
                tax += 500000 * 0.20; // 5L to 10L
                tax += 250000 * 0.05; // 2.5L to 5L
            } else if (taxableIncome > 500000) {
                tax += (taxableIncome - 500000) * 0.20;
                tax += 250000 * 0.05;
            } else if (taxableIncome > 250000) {
                tax += (taxableIncome - 250000) * 0.05;
            }
        }
    }

    // 3. Add 4% Health and Education Cess
    let totalAnnualTax = tax;
    if (tax > 0) {
        const cess = tax * 0.04;
        totalAnnualTax += cess;
    }

    // 4. Calculate Remaining Tax to be deducted
    const remainingTax = Math.max(0, totalAnnualTax - taxPaidAlready);
    const monthlyTDS = monthsLeft > 0 ? Math.round(remainingTax / monthsLeft) : 0;

    const effectivePercentage = taxableIncome > 0 ? (totalAnnualTax / taxableIncome) * 100 : 0;

    return {
        annualGross,
        exemptions: applicableExemptions,
        standardDeduction,
        taxableIncome,
        regime,
        annualTax: Math.round(totalAnnualTax),
        taxPaidAlready: Math.round(taxPaidAlready),
        remainingTax: Math.round(remainingTax),
        monthsLeft,
        monthlyTDS,
        percentage: parseFloat(effectivePercentage.toFixed(2))
    };
};

module.exports = {
    calculateTDS
};
