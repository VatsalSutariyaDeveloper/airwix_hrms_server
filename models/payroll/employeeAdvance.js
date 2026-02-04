module.exports = (sequelize, DataTypes) => {
  const EmployeeAdvance = sequelize.define(
    "EmployeeAdvance",
    {
      employee_id: { type: DataTypes.BIGINT, allowNull: false },
      payroll_month: { type: DataTypes.STRING(7), allowNull: false, comment: "Month for which advance is applicable" },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      payment_date: { type: DataTypes.DATEONLY, allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
      adjusted_in_payroll: { type: DataTypes.BOOLEAN, defaultValue: false },
      status: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0, 
        comment: "0: Pending, 1: Adjusted, 2: Cancelled", 
      },
      user_id: { type: DataTypes.BIGINT, allowNull: false },
      branch_id: { type: DataTypes.BIGINT, allowNull: false },
      company_id: { type: DataTypes.BIGINT, allowNull: false },
    },
    {
      tableName: "employee_advances",
      timestamps: true,
      underscored: true,
    }
  );

  EmployeeAdvance.associate = (models) => {
    EmployeeAdvance.belongsTo(models.Employee, {
      foreignKey: "employee_id",
      as: "employee",
    });

    EmployeeAdvance.belongsTo(models.CompanyMaster, {
      foreignKey: "company_id",
      as: "company",
    });

    EmployeeAdvance.belongsTo(models.BranchMaster, {
      foreignKey: "branch_id",
      as: "branch",
    });
  };

  return EmployeeAdvance;
};
