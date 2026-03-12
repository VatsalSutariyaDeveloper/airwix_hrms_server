module.exports = (sequelize, DataTypes) => {
    const LeaveRequest = sequelize.define(
        "LeaveRequest",
        {
            employee_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "employees", key: "id" },
            },
            leave_category_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "leave_template_categories", key: "id" },
            },
            start_date: { type: DataTypes.DATEONLY, allowNull: false },
            end_date: { type: DataTypes.DATEONLY, allowNull: false },
            total_days: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
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
            approved_by: { type: DataTypes.INTEGER, allowNull: true },
            document: { type: DataTypes.STRING, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            is_encashment: { type: DataTypes.BOOLEAN, defaultValue: false },
            start_session: { 
                type: DataTypes.SMALLINT, 
                defaultValue: 0,
                comment: "0=Full Day, 1=Session 1, 2=Session 2"
            },
            end_session: { 
                type: DataTypes.SMALLINT, 
                defaultValue: 0,
                comment: "0=Full Day, 1=Session 1, 2=Session 2"
            },
        },
        {
            tableName: "leave_requests",
            timestamps: true,
            underscored: true,
        }
    );

    LeaveRequest.associate = (models) => {
        LeaveRequest.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        LeaveRequest.belongsTo(models.LeaveTemplateCategory, { foreignKey: "leave_category_id", as: "category" });
        LeaveRequest.belongsTo(models.User, { foreignKey: "approved_by", as: "approvedBy" });
        LeaveRequest.belongsTo(models.BranchMaster, { foreignKey: "branch_id", as: "branch" });
    };

    return LeaveRequest;
};
