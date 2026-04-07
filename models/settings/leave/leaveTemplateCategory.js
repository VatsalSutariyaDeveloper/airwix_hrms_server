module.exports = (sequelize, DataTypes) => {
const LeaveTemplateCategory = sequelize.define("LeaveTemplateCategory",{
    leave_template_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
            model: "leave_templates",
            key: "id",
        },
    },
    leave_category_name: { type: DataTypes.STRING(100), allowNull: false },
    leave_count: { type: DataTypes.DECIMAL(10, 1), defaultValue: 0 },
    unused_leave_rule: {
        type: DataTypes.ENUM('LAPSE', 'CARRY_FORWARD', 'ENCASH'),
        allowNull: false,
        defaultValue: 'LAPSE',
        comment: "LAPSE: Lost, CARRY_FORWARD: Transfer to next year, ENCASH: Paid out",
    },
    carry_forward_limit: { type: DataTypes.DECIMAL(10, 1), defaultValue: 0 },
    is_paid: { 
        type: DataTypes.BOOLEAN, 
        defaultValue: true, 
        comment: "false means this is LOP (Loss of Pay)" 
    },
    is_compoff: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: "true means this category is used for compensatory off credits"
    },
    automation_rules: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.SMALLINT, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: true },
    user_id: { type: DataTypes.INTEGER, allowNull: true },
    branch_id: { type: DataTypes.INTEGER, allowNull: true },
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
