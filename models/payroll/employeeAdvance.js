module.exports = (sequelize, DataTypes) => {
  const EmployeeAdvance = sequelize.define(
    "EmployeeAdvance",
    {
      employee_id: { type: DataTypes.INTEGER, allowNull: false },
      // month: { type: DataTypes.INTEGER, allowNull: true },
      // year: { type: DataTypes.INTEGER, allowNull: true },  
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
      adjusted_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00 },
      status: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0, 
        comment: "0: Pending, 1: Adjusted, 2: Cancelled, 3: Partially Adjusted", 
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

    EmployeeAdvance.hasMany(models.PaymentHistory, {
      foreignKey: "ref_id",
      as: "paymentHistory",
    });
  };

  return EmployeeAdvance;
};
