module.exports = (sequelize, DataTypes) => {
    const HolidayTemplate = sequelize.define(
        "HolidayTemplate",
        {
            name: { type: DataTypes.STRING(100), allowNull: false },
            start_period: { type: DataTypes.STRING(100), allowNull: true },
            end_period: { type: DataTypes.STRING(100), allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "holiday_templates",
            timestamps: true,
            underscored: true,
        }
    );
    
    return HolidayTemplate;
}