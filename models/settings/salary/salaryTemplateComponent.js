module.exports = (sequelize, DataTypes) => {
  const SalaryTemplateComponent = sequelize.define("SalaryTemplateComponent", {
    salary_template_id: { type: DataTypes.INTEGER, allowNull: false },
    component_id: { type: DataTypes.INTEGER, allowNull: false },
    monthly_amount: { type: DataTypes.DECIMAL(12,2) },
    yearly_amount: { type: DataTypes.DECIMAL(12,2) },
    included_in_ctc: { type: DataTypes.BOOLEAN, defaultValue: true },
    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "salary_template_components",
    timestamps: true
  });

  SalaryTemplateComponent.associate = models => {
    SalaryTemplateComponent.belongsTo(models.SalaryTemplate, {
      foreignKey: "salary_template_id"
    });

    SalaryTemplateComponent.belongsTo(models.SalaryComponent, {
      foreignKey: "component_id"
    });
  };

  return SalaryTemplateComponent;
};