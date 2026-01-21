// models/WeeklyOffTemplateDay.js
module.exports = (sequelize, DataTypes) => {
    const WeeklyOffTemplateDay = sequelize.define(
        "WeeklyOffTemplateDay",
        {
            template_id: { type: DataTypes.INTEGER, allowNull: false },
            day_of_week: { type: DataTypes.SMALLINT, allowNull: false, comment: "0=Sunday, 1=Monday ... 6=Saturday" },
            week_no: { type: DataTypes.SMALLINT, allowNull: false, comment: "0=All, 1=1st week ... 5=5th week" },
            is_off: { type: DataTypes.BOOLEAN, defaultValue: false },
            status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
            user_id: {type: DataTypes.INTEGER, allowNull: true },
            branch_id: {type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "weekly_off_template_days",
            timestamps: true,
            underscored: true
        }
    );

    WeeklyOffTemplateDay.associate = (models) => {
        WeeklyOffTemplateDay.belongsTo(models.WeeklyOffTemplate, {
            foreignKey: "template_id",
            as: "template"
        });
    };

    return WeeklyOffTemplateDay;
};