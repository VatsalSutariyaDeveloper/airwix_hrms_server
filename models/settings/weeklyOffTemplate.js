// models/WeeklyOffTemplate.js
module.exports = (sequelize, DataTypes) => {
    const WeeklyOffTemplate = sequelize.define(
        "WeeklyOffTemplate",
        {
            name: { type: DataTypes.STRING(100), allowNull: false },
            status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
            user_id: {type: DataTypes.INTEGER, allowNull: true },
            branch_id: {type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: false },
        },
        {
            tableName: "weekly_off_templates",
            timestamps: true,
            underscored: true
        }
    );

    WeeklyOffTemplate.associate = (models) => {
        WeeklyOffTemplate.hasMany(models.WeeklyOffTemplateDay, {
            foreignKey: "template_id",
            as: "days"
        });
    };
    
    return WeeklyOffTemplate;
};