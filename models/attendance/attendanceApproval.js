module.exports = (sequelize, DataTypes) => {
    const AttendanceApproval = sequelize.define(
        "AttendanceApproval",
        {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true
            },
            employee_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: 'employees', key: 'id' }
            },
            attendance_date: {
                type: DataTypes.DATEONLY,
                allowNull: false
            },
            reason: {
                type: DataTypes.TEXT,
                allowNull: true
            },
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
                comment: "Record of who approved at each level. Example: [{ level: 1, user_id: 45, date: '...' }]"
            },
            approved_by: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            approval_remark: {
                type: DataTypes.TEXT,
                allowNull: true
            },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
                comment: "0: Active, 1: Inactive, 2: Deleted",
            },
            user_id: {
                type: DataTypes.INTEGER,
                defaultValue: 0
            },
            company_id: {
                type: DataTypes.INTEGER,
                defaultValue: 0
            },
            proposed_attendance_data: {
                type: DataTypes.JSON,
                allowNull: true,
                comment: "Stores the exact JSON payload from the attendance summary update to be applied upon final approval"
            }
        },
        {
            tableName: "attendance_approval_requests",
            timestamps: true,
            underscored: true,
        }
    );

    AttendanceApproval.associate = (models) => {
        AttendanceApproval.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        AttendanceApproval.belongsTo(models.User, { foreignKey: "approved_by", as: "approvedBy" });
    };

    return AttendanceApproval;
};
