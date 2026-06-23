module.exports = (sequelize, DataTypes) => {
    const AttendanceRegularization  = sequelize.define("attendance_regularization ",
        {
            employee_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'employees', key: 'id' } },
            attendance_date: { type: DataTypes.DATE, allowNull: false },
            reason: { type: DataTypes.TEXT, allowNull: true },
            approval_status: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: "0=PENDING, 1=PARTIALLY_APPROVED, 2=DELETED, 3=APPROVED, 4=REJECTED, 5=CANCELLED"
            },
            current_level: {
                type: DataTypes.INTEGER,
                defaultValue: 1,
                comment: "Tracks the current approval stage"
            },
            approval_history: {
                type: DataTypes.JSON,
                allowNull: true,
                comment: "Record of who approved at each level"
            },
            proposed_attendance_data: {
                type: DataTypes.JSON,
                allowNull: true,
                comment: "Saves customized times and status at Level 1 for Level 2 approval"
            },
            approved_by: { type: DataTypes.INTEGER, allowNull: true },
            approval_remark: { type: DataTypes.TEXT, allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        },
        {
            tableName: "attendance_regularization",
            timestamps: true,
            underscored: true,
        }
    );

    AttendanceRegularization .associate = (models) => {
        AttendanceRegularization .belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        AttendanceRegularization .belongsTo(models.User, { foreignKey: "approved_by", as: "approvedBy" });

    };

    return AttendanceRegularization ;
};
