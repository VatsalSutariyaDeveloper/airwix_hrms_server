module.exports = (sequelize, DataTypes) => {
  const PaymentHistory = sequelize.define(
    "PaymentHistory",
    {
      employee_id: { type: DataTypes.INTEGER, allowNull: false },
      ref_id: { type: DataTypes.INTEGER, allowNull: false },
      payment_date: { type: DataTypes.DATEONLY, allowNull: false },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      payment_type: { type: DataTypes.ENUM("Advance", "Salary"),defaultValue: "Advance", allowNull: false },
      payment_mode: {
        type: DataTypes.ENUM("Cash", "Bank"),
        allowNull: false,
        defaultValue: "Cash",
        comment: "Cash or Bank payment",
      },
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
      tableName: "payment_history",
      timestamps: true,
      underscored: true,
    }
  );

  PaymentHistory.associate = (models) => {
    PaymentHistory.belongsTo(models.Employee, {
      foreignKey: "employee_id",
      as: "employee",
    });
    
    PaymentHistory.belongsTo(models.EmployeeAdvance, {
      foreignKey: "ref_id",
      as: "employee-advance",
    });
  };

  return PaymentHistory;
};
