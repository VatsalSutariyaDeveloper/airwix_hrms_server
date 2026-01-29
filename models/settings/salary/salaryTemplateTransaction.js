module.exports = (sequelize, DataTypes) => {
  const SalaryTemplateTransaction = sequelize.define("SalaryTemplateTransaction", {
    salary_template_id: { type: DataTypes.INTEGER, allowNull: false },
    component_id: { type: DataTypes.INTEGER, allowNull: false },
    component_type: {
      type: DataTypes.ENUM("EARNING", "DEDUCTION"),
      allowNull: false
    },
    component_category: {
      type: DataTypes.ENUM("FIXED", "VARIABLE", "STATUTORY"),
      allowNull: true
    },
    monthly_amount: { type: DataTypes.DECIMAL(12, 2) },
    yearly_amount: { type: DataTypes.DECIMAL(12, 2) },
    included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: true },
    is_employer_contribution: { type: DataTypes.BOOLEAN, defaultValue: false },
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
      foreignKey: "salary_template_id"
    });

    SalaryTemplateTransaction.belongsTo(models.SalaryComponent, {
      foreignKey: "component_id"
    });
  };

  return SalaryTemplateTransaction;
};