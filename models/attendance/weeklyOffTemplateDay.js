// models/WeeklyOffTemplateDay.js
module.exports = (sequelize, DataTypes) => {
    const WeeklyOffTemplateDay = sequelize.define(
        "WeeklyOffTemplateDay",
        {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true
            },

            template_id: {
                type: DataTypes.INTEGER,
                allowNull: false
            },

            day_of_week: {
                type: DataTypes.SMALLINT,
                allowNull: false,
                comment: "0=Sunday, 1=Monday ... 6=Saturday"
            },

            week_no: {
                type: DataTypes.SMALLINT,
                allowNull: false,
                comment: "0=All, 1=1st week ... 5=5th week"
            },

            is_off: {
                type: DataTypes.BOOLEAN,
                defaultValue: true
            }
        },
        {
            tableName: "weekly_off_template_days",
            timestamps: false,
            underscored: true,
            indexes: [
                {
                    unique: true,
                    fields: ["template_id", "day_of_week", "week_no"]
                }
            ]
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