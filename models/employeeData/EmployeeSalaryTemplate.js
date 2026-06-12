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
    ctc_monthly: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    ctc_yearly: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    daily_rate: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    hourly_rate: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    currency: { type: DataTypes.STRING(10), defaultValue: "INR" },
    lwp_calculation_basis: {
      type: DataTypes.ENUM("DAYS_IN_MONTH", "FIXED_30_DAYS", "WORKING_DAYS"),
      defaultValue: "WORKING_DAYS"
    },
    statutory_config: {
      type: DataTypes.JSONB,
      allowNull: true
    },
    effective_date: { type: DataTypes.DATEONLY, allowNull: true },
    revision_number: { type: DataTypes.INTEGER, defaultValue: 1 },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: "employee_salary_templates",
    timestamps: true,
    underscored: true
  });

  EmployeeSalaryTemplate.associate = models => {
    EmployeeSalaryTemplate.hasMany(models.EmployeeSalaryTemplateTransaction, {
      foreignKey: "employee_salary_template_id",
      as: "employeeSalaryTemplateTransactions"
    });
    EmployeeSalaryTemplate.belongsTo(models.Employee, {
      foreignKey: "employee_id",
    });
  };

  return EmployeeSalaryTemplate;
};
