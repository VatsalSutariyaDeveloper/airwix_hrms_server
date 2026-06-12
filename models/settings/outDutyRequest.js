module.exports = (sequelize, DataTypes) => {
    const OutDutyRequest = sequelize.define(
        "OutDutyRequest",
        {
            employee_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "employees", key: "id" },
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
            current_out_duty_level: { 
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
            approval_remark: { type: DataTypes.TEXT, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
            
            user_id: { type: DataTypes.INTEGER, allowNull: true },
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
            status: { type: DataTypes.SMALLINT, defaultValue: 0 }
  }, {
    tableName: "out_duty_requests",
            timestamps: true,
            underscored: true,
        }
    );

    OutDutyRequest.associate = (models) => {
        OutDutyRequest.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        OutDutyRequest.belongsTo(models.User, { foreignKey: "approved_by", as: "approvedBy" });
    };

    return OutDutyRequest;
};
