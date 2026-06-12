module.exports = (sequelize, DataTypes) => {
  const CashVoucher = sequelize.define(
    "CashVoucher",
    {
      employee_id: { type: DataTypes.INTEGER, allowNull: false },
      attendance_day_id: { type: DataTypes.INTEGER, allowNull: true },
      attendance_date: { type: DataTypes.DATEONLY, allowNull: true },
      voucher_type: {
        type: DataTypes.ENUM("OVERTIME", "SALARY"),
        allowNull: false,
        defaultValue: "OVERTIME",
      },
      overtime_minutes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      overtime_data: { type: DataTypes.JSONB, allowNull: true },
      note: { type: DataTypes.TEXT, allowNull: true },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Settled, 2: Deleted",
      },
      user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
      
      company_id: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: "cash_vouchers",
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ["employee_id", "attendance_date", "voucher_type"] },
        { fields: ["attendance_day_id", "voucher_type"] },
      ],
    }
  );

  CashVoucher.associate = (models) => {
    CashVoucher.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
    CashVoucher.belongsTo(models.AttendanceDay, { foreignKey: "attendance_day_id", as: "attendanceDay" });
  };

  return CashVoucher;
};
