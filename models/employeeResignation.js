module.exports = (sequelize, DataTypes) => {
    const EmployeeResignation = sequelize.define(
        "EmployeeResignation",
        {
            employee_id: { type: DataTypes.INTEGER, allowNull: false },
            resignation_date: { type: DataTypes.DATEONLY, allowNull: false },
            preferred_lwd: { type: DataTypes.DATEONLY, allowNull: true, comment: "Preferred Last Working Day by Employee" },
            approved_lwd: { type: DataTypes.DATEONLY, allowNull: true, comment: "Approved Last Working Day by HR" },
            reason_type_id: { type: DataTypes.INTEGER, allowNull: true },
            reason_description: { type: DataTypes.TEXT, allowNull: true },
            
            // Approval Workflow Tracking
            approval_status: { 
                type: DataTypes.SMALLINT, 
                defaultValue: 0, 
                comment: "0: Pending, 1: Partially Approved, 2: Rejected, 3: Approved, 4: Cancelled" 
            },
            current_level: { type: DataTypes.INTEGER, defaultValue: 1 },
            approval_history: { type: DataTypes.JSONB, defaultValue: [] },
            
            // Post-Approval Tracking
            exit_interview_notes: { type: DataTypes.TEXT, allowNull: true },
            ff_settlement_status: { 
                type: DataTypes.SMALLINT, 
                defaultValue: 0, 
                comment: "0: Not Started, 1: In Progress, 2: Settled" 
            },
            checklist: { type: DataTypes.JSONB, defaultValue: {} },
            status: { 
                type: DataTypes.SMALLINT, 
                defaultValue: 0, 
                comment: "0: Active, 1: Inactive, 2: Deleted" 
            },

            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "employee_resignations",
            timestamps: true,
            underscored: true,
        }
    );

    EmployeeResignation.associate = (models) => {
        EmployeeResignation.belongsTo(models.Employee, {
            foreignKey: "employee_id",
            as: "employee",
        });
        EmployeeResignation.belongsTo(models.User, {
            foreignKey: "user_id",
            as: "submitted_by",
        });
        EmployeeResignation.belongsTo(models.ResignationReason, {
            foreignKey: "reason_type_id",
            as: "reason_type",
        });
    };

    return EmployeeResignation;
};
