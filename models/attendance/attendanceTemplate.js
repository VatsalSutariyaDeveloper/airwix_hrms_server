module.exports = (sequelize, DataTypes) => {
  const AttendanceTemplate = sequelize.define("AttendanceTemplate",{
        name: { type: DataTypes.STRING, },
        mode: { type: DataTypes.ENUM('AUTO_PRESENT', 'MANUAL', 'LOCATION_BASED', 'SELFIE_AND_LOCATION'), defaultValue: 'MANUAL', comment: 'Defines how the employee marks attendance' },

        // --- HOLIDAY RULES ---
        holiday_policy: { type: DataTypes.ENUM('BLOCK_ATTENDANCE', 'COMP_OFF', 'ALLOW_NORMAL'), defaultValue: 'BLOCK_ATTENDANCE', comment: 'Behavior when a user attempts to punch in on a paid holiday' },

        // --- PUNCH SETTINGS ---
        track_in_out: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'If false, only attendance status (P/A) is tracked, not time' },
        require_punch_out: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'If true, attendance is invalid/incomplete without a punch out' },
        allow_multiple_punches: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'Allows multiple check-ins per day (e.g. shifts or breaks)' },

        // --- ABSENTEEISM AUTOMATION ---
        auto_mark_absent: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'Enable cron job to mark "Absent" for previous days with no data' },
        auto_absent_buffer_days: { type: DataTypes.INTEGER, defaultValue: 2, validate: { min: 0 } },
        deduct_breaks_from_total: { type: DataTypes.BOOLEAN, defaultValue: false, comment: 'Rule 4: All breaks deducted. Rule 1: Paid breaks deducted.' },
        include_overtime_in_total: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'Rule 3: Overtime deducted (False) vs Included (True)' },
        paid_break_duration_mins: { type: DataTypes.INTEGER, defaultValue: 0, comment: 'Minutes of break time that are NOT deducted' },

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