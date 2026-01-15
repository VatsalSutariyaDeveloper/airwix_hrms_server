module.exports = (sequelize, DataTypes) => {
    const WeeklyOff = sequelize.define(
        "WeeklyOff",
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            employee_id: { type: DataTypes.INTEGER, allowNull: false },
            week_day: {
                type: DataTypes.ENUM(
                    "SUNDAY",
                    "MONDAY",
                    "TUESDAY",
                    "WEDNESDAY",
                    "THURSDAY",
                    "FRIDAY",
                    "SATURDAY"
                ),
                allowNull: false,
            },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
            },
            user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        },
        {
            tableName: "weekly_off",
            timestamps: true,
            underscored: true,
        }
    );

    return WeeklyOff;
};

