module.exports = (sequelize, DataTypes) => {
    const LeaveTemplateCategory = sequelize.define(
        "LeaveTemplateCategory",
        {
            leave_template_id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: {
                    model: "leave_templates",
                    key: "id",
                },
            },
            leave_category_name: { type: DataTypes.STRING(100), allowNull: false },
            leave_count: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            unused_leave_rule: {
                type: DataTypes.ENUM('LAPSE', 'CARRY_FORWARD', 'ENCASH'),
                allowNull: false,
                defaultValue: 'LAPSE',
                comment: "LAPSE: Lost, CARRY_FORWARD: Transfer to next year, ENCASH: Paid out",
            },
            carry_forward_limit: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
            automation_rules: { type: DataTypes.TEXT, allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "leave_template_categories",
            timestamps: true,
            underscored: true,
        }
    );

    LeaveTemplateCategory.associate = (models) => {
        LeaveTemplateCategory.belongsTo(models.LeaveTemplate, {
            foreignKey: "leave_template_id",
            as: "template",
        });
    };

    return LeaveTemplateCategory;
};
