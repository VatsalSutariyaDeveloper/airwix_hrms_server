// models/WeeklyOffTemplate.js
module.exports = (sequelize, DataTypes) => {
    const WeeklyOffTemplate = sequelize.define(
        "WeeklyOffTemplate",
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: DataTypes.STRING(100), allowNull: false },
            company_id: { type: DataTypes.INTEGER, allowNull: false },
            branch_id: {type: DataTypes.INTEGER, allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 1, 
                // 1 = Active, 0 = Inactive 
            },
            created_by: {
                type: DataTypes.INTEGER,
                allowNull: false
            }
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