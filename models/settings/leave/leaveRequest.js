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
                type: DataTypes.STRING(20), 
                defaultValue: "PENDING",
                comment: "PENDING, PARTIALLY_APPROVED, APPROVED, REJECTED, CANCELLED" 
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
            company_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
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
    };

    return LeaveRequest;
};
