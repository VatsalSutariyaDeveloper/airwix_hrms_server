module.exports = (sequelize, DataTypes) => {
  const AttendanceTemplate = sequelize.define("AttendanceTemplate", {
    name: { type: DataTypes.STRING, },
    mode: { type: DataTypes.ENUM('AUTO_PRESENT', 'MANUAL', 'LOCATION_BASED', 'SELFIE_BASED', 'SELFIE_AND_LOCATION', 'FACE_RECOGNITION'), defaultValue: 'FACE_RECOGNITION', comment: 'Defines how the employee marks attendance' },

    // --- LOCATION AREA RESTRICTION (used by LOCATION_BASED / SELFIE_AND_LOCATION) ---
    location_latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true, comment: 'Allowed area centre latitude. If empty, the employee branch geofence is used.' },
    location_longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true, comment: 'Allowed area centre longitude. If empty, the employee branch geofence is used.' },
    location_radius_meters: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 100, comment: 'Allowed punch radius (metres) around the area centre' },

    // --- HOLIDAY RULES ---
    holiday_policy: { type: DataTypes.ENUM('BLOCK_ATTENDANCE', 'COMP_OFF', 'ALLOW_NORMAL'), defaultValue: 'BLOCK_ATTENDANCE', comment: 'Behavior when a user attempts to punch in on a paid holiday' },

    // --- PUNCH SETTINGS ---
    track_in_out: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'If false, only attendance status (P/A) is tracked, not time' },
    require_punch_out: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'If true, attendance is invalid/incomplete without a punch out' },
    allow_multiple_punches: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'Allows multiple check-ins per day (e.g. shifts or breaks)' },

    // --- LATE ENTRY & EARLY EXIT RULES ---
    late_entry_limit: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Allowed late entries per month before fine' },
    late_entry_fine_type: { type: DataTypes.ENUM('NONE', 'FIXED', 'PERCENTAGE', 'DEDUCTION', 'MINUTE_DEDUCTION', 'HALF_DAY', 'FULL_DAY'), defaultValue: 'NONE' },
    late_entry_fine_value: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    late_entry_rules: { type: DataTypes.JSON, defaultValue: [], comment: 'List of rules for late entry' },

    early_exit_limit: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Allowed early exits per month before fine' },
    early_exit_fine_type: { type: DataTypes.ENUM('NONE', 'FIXED', 'PERCENTAGE', 'DEDUCTION', 'MINUTE_DEDUCTION', 'HALF_DAY', 'FULL_DAY'), defaultValue: 'NONE' },
    early_exit_fine_value: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    early_exit_rules: { type: DataTypes.JSON, defaultValue: [], comment: 'List of rules for early exit' },

    // --- FINES ---
    fines_allowed: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'If true, calculates and applied late entry, early exit and excess break fines' },

    // --- OVERTIME RULES ---
    overtime_allowed: { type: DataTypes.BOOLEAN, defaultValue: true },
    min_overtime_mins: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Minimum minutes needed to count as overtime' },
    max_overtime_mins: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Maximum OT allowed per day (0 = Unlimited)' },
    overtime_rules: { type: DataTypes.JSON, defaultValue: [], comment: 'List of rules for overtime' },

    early_overtime_allowed: { type: DataTypes.BOOLEAN, defaultValue: false },
    early_overtime_rules: { type: DataTypes.JSON, defaultValue: [], comment: 'List of rules for early overtime' },
    allow_absent_fine: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'If true, allows applying absent fines' },
    absent_fine_rules: { type: DataTypes.JSON, defaultValue: [], comment: 'List of rules for absent fine' },

    // --- ABSENTEEISM AUTOMATION ---
    auto_mark_absent: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'Enable cron job to mark "Absent" for previous days with no data' },
    auto_mark_present: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'Enable auto marking "Present" for the day' },
    auto_absent_buffer_days: { type: DataTypes.INTEGER, defaultValue: 2, validate: { min: 0 } },
    deduct_breaks_from_total: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'Rule 4: All breaks deducted. Rule 1: Paid breaks deducted.' },
    include_overtime_in_total: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'Rule 3: Overtime deducted (False) vs Included (True)' },
    paid_break_duration_mins: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Minutes of break time that are NOT deducted' },
    break_rules: { type: DataTypes.JSON, defaultValue: [], comment: 'List of rules for breaks' },
    out_duty_approval_level: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      comment: "1, 2, or 3 levels of approval"
    },
    out_duty_approval_config: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "JSON configuration for each level: [{level: 1, type: 'SUPERVISOR/MANAGER/ADMIN/EMPLOYER'}]"
    },
    enble_out_duty: { type: DataTypes.BOOLEAN, defaultValue: false },

    comp_off_min_working_mins: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Min working mins for half comp-off on holiday/weekly off' },
    comp_off_max_working_mins: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Min working mins for full comp-off on holiday/weekly off' },
    comp_off_generation_mode: { type: DataTypes.ENUM('AUTO', 'MANUAL'), defaultValue: 'AUTO', comment: 'AUTO: Credit requests generated by attendance, MANUAL: Applied manually by employee' },

    status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted", },
    user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
    {
      tableName: "attendance_templates",
      timestamps: true,
      underscored: true,
    }
  );

  AttendanceTemplate.associate = (models) => {
    // Associations removed
  };

  return AttendanceTemplate;
};



// JSON
// {
//   "name": "Field Staff Policy",
//   "mode": "SELFIE_AND_LOCATION",
//   "holiday_policy": "COMP_OFF",
//   "track_in_out": true,
//   "require_punch_out": true,
//   "allow_multiple_punches": true,
//   "auto_mark_absent": true,
//   "auto_absent_buffer_days": 2,
//   "deduct_breaks_from_total": true,
//   "include_overtime_in_total": false,
//   "paid_break_duration_mins": 0,
//   "status": 0
// }