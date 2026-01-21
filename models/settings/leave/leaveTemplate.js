module.exports = (sequelize, DataTypes) => {
    const LeaveTemplate = sequelize.define(
        "LeaveTemplate",
        {
            template_name: { type: DataTypes.STRING(100), allowNull: false },
            leave_policy_cycle: { 
                type: DataTypes.ENUM('CALENDAR_YEAR', 'FINANCIAL_YEAR', 'SERVICE_YEAR'), 
                allowNull: false, 
                defaultValue: 'CALENDAR_YEAR',
                comment: "CALENDAR_YEAR: Jan-Dec, FINANCIAL_YEAR: Apr-Mar, SERVICE_YEAR: Join Date anniversary" 
            },
            leave_period_start: { type: DataTypes.DATEONLY, allowNull: true },
            leave_period_end: { type: DataTypes.DATEONLY, allowNull: true },
            accrual_type: { 
                type: DataTypes.ENUM('UPFRONT', 'MONTHLY'), 
                allowNull: false, 
                defaultValue: 'UPFRONT',
                comment: "UPFRONT: Full credit at start, MONTHLY: Earn credit every month" 
            },
            join_month_rule: {
                type: DataTypes.ENUM('THRESHOLD_BASED', 'FULL_MONTH', 'PRO_RATA_DAYS'),
                allowNull: false,
                defaultValue: 'THRESHOLD_BASED',
                comment: "How to handle join month credit"
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
