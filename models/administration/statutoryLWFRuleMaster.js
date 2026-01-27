module.exports = (sequelize, DataTypes) => {
  const StatutoryLWFRule = sequelize.define("StatutoryLWFRule", {
    state_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
 
    // How much to cut?
    employee_contribution: { type: DataTypes.DECIMAL(8,2), defaultValue: 0 },
    employer_contribution: { type: DataTypes.DECIMAL(8,2), defaultValue: 0 },
 
    // When to cut? (Array of month numbers: 1=Jan, 6=June, 12=Dec)
    // Gujarat Example: [6, 12]
    deduction_months: { 
        type: DataTypes.JSONB, 
        allowNull: false,
        comment: "Array of months to deduct LWF, e.g., [6, 12]" 
    },
 
    active: { type: DataTypes.BOOLEAN, defaultValue: true }
  }, { 
    tableName: "statutory_lwf_rules",
    timestamps: true 
  });
 
  return StatutoryLWFRule;
};