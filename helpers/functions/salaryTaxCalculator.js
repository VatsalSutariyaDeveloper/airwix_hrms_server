
/**
 * Salary Tax (TDS) Calculator Helper
 * Calculates Income Tax based on Indian Tax Regimes for FY 2024-25
 */

const calculateTDS = (annualGross, regime = 'new_regime') => {
    console.log("tds called", annualGross, regime);
    const standardDeduction = 50000;
    const taxableIncome = Math.max(0, annualGross - standardDeduction);
    let tax = 0;

    if (regime === 'new_regime' || regime === 'smart') {
        // New Tax Regime Slabs (FY 2024-25)
        if (taxableIncome <= 700000) {
            tax = 0; // Rebate u/s 87A
        } else {
            if (taxableIncome > 1500000) {
                tax += (taxableIncome - 1500000) * 0.30;
                tax += 300000 * 0.20; // 12L to 15L
                tax += 300000 * 0.15; // 9L to 12L
                tax += 300000 * 0.10; // 6L to 9L
                tax += 300000 * 0.05; // 3L to 6L
            } else if (taxableIncome > 1200000) {
                tax += (taxableIncome - 1200000) * 0.20;
                tax += 300000 * 0.15;
                tax += 300000 * 0.10;
                tax += 300000 * 0.05;
            } else if (taxableIncome > 900000) {
                tax += (taxableIncome - 900000) * 0.15;
                tax += 300000 * 0.10;
                tax += 300000 * 0.05;
            } else if (taxableIncome > 600000) {
                tax += (taxableIncome - 600000) * 0.10;
                tax += 300000 * 0.05;
            } else if (taxableIncome > 300000) {
                tax += (taxableIncome - 300000) * 0.05;
            }
        }
    } else if (regime === 'old_regime') {
        // Old Tax Regime Slabs (FY 2024-25)
        if (taxableIncome <= 500000) {
            tax = 0; // Rebate u/s 87A
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

    if (tax > 0) {
        const cess = tax * 0.04;
        tax += cess;
    }

    const effectivePercentage = taxableIncome > 0 ? (tax / taxableIncome) * 100 : 0;

    // Return object with monthly tax and effective percentage
    return {
        monthlyTDS: Math.round(tax / 12),
        percentage: parseFloat(effectivePercentage.toFixed(2))
    };
};

module.exports = {
    calculateTDS
};
