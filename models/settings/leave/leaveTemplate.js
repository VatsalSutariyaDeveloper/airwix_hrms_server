module.exports = (sequelize, DataTypes) => {
    const LeaveTemplate = sequelize.define(
        "LeaveTemplate",
        {
            template_name: { type: DataTypes.STRING(100), allowNull: false },
            leave_policy_cycle: { 
                type: DataTypes.STRING(50), 
                allowNull: false, 
                comment: "Yearly, Monthly, etc." 
            },
            leave_period_start: { type: DataTypes.DATEONLY, allowNull: true },
            leave_period_end: { type: DataTypes.DATEONLY, allowNull: true },
            accrual_type: { 
                type: DataTypes.STRING(50), 
                allowNull: false, 
                comment: "All at once, Monthly, etc." 
            },
            count_sandwich_leaves: { type: DataTypes.BOOLEAN, defaultValue: false },
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
            tableName: "leave_templates",
            timestamps: true,
            underscored: true,
        }
    );

    LeaveTemplate.associate = (models) => {
        LeaveTemplate.hasMany(models.LeaveTemplateCategory, {
            foreignKey: "leave_template_id",
            as: "categories",
        });
    };

    return LeaveTemplate;
};
