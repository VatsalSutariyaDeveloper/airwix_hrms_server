module.exports = (sequelize, DataTypes) => {
  const SalaryRevisionHistory = sequelize.define("SalaryRevisionHistory", {
    employee_id: { type: DataTypes.INTEGER, allowNull: false },
    previous_template_id: { type: DataTypes.INTEGER, allowNull: true },
    new_template_id: { type: DataTypes.INTEGER, allowNull: true },
    previous_ctc: { type: DataTypes.DECIMAL(12, 2) },
    new_ctc: { type: DataTypes.DECIMAL(12, 2) },
    effective_date: { type: DataTypes.DATEONLY, allowNull: false },
    revision_date: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
    increment_amount: { type: DataTypes.DECIMAL(12, 2) },
    increment_percentage: { type: DataTypes.DECIMAL(5, 2) },
    remarks: { type: DataTypes.TEXT },
    status: { type: DataTypes.SMALLINT, defaultValue: 0 }, // 0: Pending, 1: Approved, 2: Rejected
    approved_by: { type: DataTypes.INTEGER },
    approved_at: { type: DataTypes.DATE },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "salary_revision_histories",
    timestamps: true,
    underscored: true
  });

  SalaryRevisionHistory.associate = models => {
    SalaryRevisionHistory.belongsTo(models.Employee, { foreignKey: "employee_id" });
    SalaryRevisionHistory.belongsTo(models.SalaryTemplate, { foreignKey: "new_template_id", as: "newTemplate" });
    SalaryRevisionHistory.belongsTo(models.SalaryTemplate, { foreignKey: "previous_template_id", as: "previousTemplate" });
  };

  return SalaryRevisionHistory;
};
