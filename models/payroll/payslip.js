module.exports = (sequelize, DataTypes) => {
  const Payslip = sequelize.define("Payslip", {
    employee_id: { type: DataTypes.INTEGER, allowNull: false },
    month: { type: DataTypes.INTEGER, allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: false },
    
    // Summary Fields
    ctc_monthly: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    present_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    absent_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    leave_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    weekly_offs: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    holidays: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    lwp_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    
    // Financials
    per_day_salary: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    lwp_deduction: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    total_fine: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    ot_amount: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    net_payable: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    
    // JSON details for breakdown
    breakdown_json: { type: DataTypes.JSON, allowNull: true },
    
    status: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0, 
        comment: "0: Draft, 1: Finalized, 2: Paid, 99: Cancelled" 
    },
    
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "payslips",
    timestamps: true,
    indexes: [
        { unique: true, fields: ['employee_id', 'month', 'year', 'status'], where: { status: [0, 1, 2] } }
    ]
  });

  Payslip.associate = models => {
    Payslip.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
  };

  return Payslip;
};
