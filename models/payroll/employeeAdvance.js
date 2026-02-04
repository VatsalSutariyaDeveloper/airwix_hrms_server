module.exports = (sequelize, DataTypes) => {
  const EmployeeAdvance = sequelize.define(
    "EmployeeAdvance",
    {
      employee_id: { type: DataTypes.INTEGER, allowNull: false },
      payroll_month: { type: DataTypes.DATEONLY, allowNull: false, comment: "Month for which advance is applicable" },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      payment_date: { type: DataTypes.DATEONLY, allowNull: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
      payment_mode: {
        type: DataTypes.ENUM("Cash", "Bank"),
        allowNull: false,
        defaultValue: "Cash",
        comment: "Cash or Bank payment",
      },
      adjusted_in_payroll: { type: DataTypes.BOOLEAN, defaultValue: false },
      status: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0, 
        comment: "0: Pending, 1: Adjusted, 2: Cancelled", 
      },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      branch_id: { type: DataTypes.INTEGER, allowNull: false },
      company_id: { type: DataTypes.INTEGER, allowNull: false },
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

    EmployeeAdvance.hasMany(models.PaymentHistory, {
      foreignKey: "ref_id",
      as: "paymentHistory",
    });
  };

  return EmployeeAdvance;
};
