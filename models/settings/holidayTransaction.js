module.exports = (sequelize, DataTypes) => {
    const HolidayTransaction = sequelize.define(
        "HolidayTransaction",
        {
            template_id: { type: DataTypes.INTEGER, allowNull: true },
            name: { type: DataTypes.STRING(100), allowNull: true },
            date: { type: DataTypes.DATEONLY, allowNull: true },
            holiday_type: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1: Mandatory, 2: Restricted" },
            color: { type: DataTypes.STRING(20), defaultValue: "#E11D48" },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true }
        },
        {
            tableName: "holiday_transactions",
            timestamps: true,
            underscored: true,
        }
    );

    return HolidayTransaction;
}