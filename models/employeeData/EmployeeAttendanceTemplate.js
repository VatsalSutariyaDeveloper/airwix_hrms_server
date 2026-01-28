module.exports = (sequelize, DataTypes) => {
  const EmployeeAttendanceTemplate = sequelize.define("EmployeeAttendanceTemplate", {
    employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
    template_id: { type: DataTypes.INTEGER, allowNull: true, references: { model: 'attendance_templates', key: 'id' } },
    
    // Copied from AttendanceTemplate
    mode: { type: DataTypes.ENUM('AUTO_PRESENT', 'MANUAL', 'LOCATION_BASED', 'SELFIE_AND_LOCATION'), defaultValue: 'MANUAL' },
    holiday_policy: { type: DataTypes.ENUM('BLOCK_ATTENDANCE', 'COMP_OFF', 'ALLOW_NORMAL'), defaultValue: 'BLOCK_ATTENDANCE' },
    track_in_out: { type: DataTypes.BOOLEAN, defaultValue: true },
    require_punch_out: { type: DataTypes.BOOLEAN, defaultValue: false },
    allow_multiple_punches: { type: DataTypes.BOOLEAN, defaultValue: true },
    late_entry_limit: { type: DataTypes.INTEGER, defaultValue: 0 },
    late_entry_fine_type: { type: DataTypes.ENUM('NONE', 'FIXED', 'PERCENTAGE', 'DEDUCTION'), defaultValue: 'NONE' },
    late_entry_fine_value: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    early_exit_limit: { type: DataTypes.INTEGER, defaultValue: 0 },
    early_exit_fine_type: { type: DataTypes.ENUM('NONE', 'FIXED', 'PERCENTAGE', 'DEDUCTION'), defaultValue: 'NONE' },
    early_exit_fine_value: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    overtime_allowed: { type: DataTypes.BOOLEAN, defaultValue: true },
    min_overtime_mins: { type: DataTypes.INTEGER, defaultValue: 0 },
    max_overtime_mins: { type: DataTypes.INTEGER, defaultValue: 0 },
    auto_mark_absent: { type: DataTypes.BOOLEAN, defaultValue: false },
    auto_absent_buffer_days: { type: DataTypes.INTEGER, defaultValue: 2 },
    deduct_breaks_from_total: { type: DataTypes.BOOLEAN, defaultValue: false },
    include_overtime_in_total: { type: DataTypes.BOOLEAN, defaultValue: true },
    paid_break_duration_mins: { type: DataTypes.INTEGER, defaultValue: 0 },

    status: { type: DataTypes.SMALLINT, defaultValue: 0 },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  }, {
    tableName: "employee_attendance_templates",
    timestamps: true,
    underscored: true,
  });

  EmployeeAttendanceTemplate.associate = (models) => {
    EmployeeAttendanceTemplate.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
    EmployeeAttendanceTemplate.belongsTo(models.AttendanceTemplate, { foreignKey: "template_id" });
  };

  return EmployeeAttendanceTemplate;
};
