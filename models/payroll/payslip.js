module.exports = (sequelize, DataTypes) => {
  const Payslip = sequelize.define("Payslip", {
    employee_id: { type: DataTypes.INTEGER, allowNull: false },
    month: { type: DataTypes.INTEGER, allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: false },
    
    // Attendance Summary
    pd_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 }, //payable days
    ph_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },// paid holidays
    half_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },// half days
    wo_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },// weekly offs
    wp_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },// weekly offs paid
    present_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    lp_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },// leave without pay
    ul_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },// unpaid leave
    absent_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    total_days: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    days_in_calculation: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
    lunch_count: { type: DataTypes.INTEGER(3), defaultValue: 0 },
    leave_details: { type: DataTypes.JSON, allowNull: true },
    leave_balances: { type: DataTypes.JSON, allowNull: true },

    // Dynamic Components
    earning_details: { type: DataTypes.JSON, allowNull: true },
    deduction_details: { type: DataTypes.JSON, allowNull: true },
    statutory_details: { type: DataTypes.JSON, allowNull: true },
    employer_details: { type: DataTypes.JSON, allowNull: true },
    reimbursement_details: { type: DataTypes.JSON, allowNull: true },
    encashment_details: { type: DataTypes.JSON, allowNull: true },
    payment_history: { type: DataTypes.JSON, allowNull: true },

    // Summary Totals
    fixed_gross: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    paid_gross: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    total_deduction: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    net_salary: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    round_off_amount: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    paid_amount: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    pending_amount: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    // JSON details for legacy or extra breakdown
    break_down: { type: DataTypes.JSON, allowNull: true },
    tds_calculation_data: { type: DataTypes.JSON, allowNull: true },
    payment_date: { type: DataTypes.DATEONLY, allowNull: true },
    
    status: { 
        type: DataTypes.SMALLINT, 
        defaultValue: 0, 
        comment: "0: Draft, 1: Finalized, 2: Delete, 3: Paid, 99: Cancelled" 
    },
    
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: "payslips",
    timestamps: true,
    underscored: true,
    indexes: [
        { unique: true, fields: ['employee_id', 'month', 'year', 'status'], where: { status: [0, 1, 2, 3] } }
    ]
  });

  Payslip.associate = models => {
    Payslip.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
  };

  return Payslip;
};
