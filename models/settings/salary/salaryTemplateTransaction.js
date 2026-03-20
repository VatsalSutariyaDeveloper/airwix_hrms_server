module.exports = (sequelize, DataTypes) => {
  const SalaryTemplateTransaction = sequelize.define("SalaryTemplateTransaction", {
    salary_template_id: { type: DataTypes.INTEGER, allowNull: false },
    component_id: { type: DataTypes.INTEGER, allowNull: true },
    component_category: {
      type: DataTypes.ENUM("FIXED", "VARIABLE", "STATUTORY", "EMPLOYER_CONTRIBUTION", "VARIABLE_EARNING", "BENEFIT", "ANNUAL_COMPONENT"),
      allowNull: true
    },
    monthly_amount: { type: DataTypes.DECIMAL(12, 2) },
    yearly_amount: { type: DataTypes.DECIMAL(12, 2) },
    included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: true },
    is_employer_contribution: { type: DataTypes.BOOLEAN, defaultValue: false },
    calculation_type: {
      type: DataTypes.ENUM("FIXED", "PERCENTAGE", "FORMULA", "ATTENDANCE_BASED", "CANTEEN_BASED"),
      allowNull: true
    },
    percentage_of: {
      type: DataTypes.ENUM("BASIC", "GROSS", "CTC"),
      allowNull: true
    },
    percentage_value: { type: DataTypes.DECIMAL(10,2) },
    formula: { type: DataTypes.TEXT },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "salary_template_transactions", // Changed table name
    timestamps: true
  });

  SalaryTemplateTransaction.associate = models => {
    SalaryTemplateTransaction.belongsTo(models.SalaryTemplate, {
      foreignKey: "salary_template_id",
      as: "salaryTemplate"
    });

    SalaryTemplateTransaction.belongsTo(models.SalaryComponent, {
      foreignKey: "component_id",
      as: "component"
    });
  };

  return SalaryTemplateTransaction;
};