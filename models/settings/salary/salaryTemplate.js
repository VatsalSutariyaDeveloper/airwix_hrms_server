module.exports = (sequelize, DataTypes) => {
  const SalaryTemplate = sequelize.define("SalaryTemplate", {
    template_code: { type: DataTypes.STRING(50), unique: true },
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
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "salary_templates",
    timestamps: true
  });

  SalaryTemplate.associate = models => {
    SalaryTemplate.hasMany(models.SalaryTemplateComponent, {
      foreignKey: "salary_template_id"
    });
  };

  return SalaryTemplate;
};
