module.exports = (sequelize, DataTypes) => {
  const EmployeeSalaryTemplate = sequelize.define("EmployeeSalaryTemplate", {
    employee_id: { type: DataTypes.INTEGER, allowNull: false },
    template_id: { type: DataTypes.INTEGER, allowNull: true },
    template_code: { type: DataTypes.STRING(50) },
    template_name: { type: DataTypes.STRING(150), allowNull: false },
    staff_type: {
      type: DataTypes.ENUM("Regular", "Trainee", "Contract"),
      defaultValue: "Regular"
    },
    salary_type: {
      type: DataTypes.ENUM("Monthly", "Daily", "Hourly"),
      defaultValue: "Monthly"
    },
    ctc_monthly: { type: DataTypes.DECIMAL(12,2), allowNull: false },
    ctc_yearly: { type: DataTypes.DECIMAL(12,2), allowNull: false },
    currency: { type: DataTypes.STRING(10), defaultValue: "INR" },
    lwp_calculation_basis: {
      type: DataTypes.ENUM("DAYS_IN_MONTH", "FIXED_30_DAYS", "WORKING_DAYS"),
      defaultValue: "DAYS_IN_MONTH"
    },
    statutory_config: {
        type: DataTypes.JSONB,
        allowNull: true
    },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "employee_salary_templates",
    timestamps: true
  });

  EmployeeSalaryTemplate.associate = models => {
    EmployeeSalaryTemplate.hasMany(models.EmployeeSalaryTemplateTransaction, {
      foreignKey: "employee_salary_template_id",
    });
    EmployeeSalaryTemplate.belongsTo(models.Employee, {
      foreignKey: "employee_id",
    });
  };

  return EmployeeSalaryTemplate;
};
