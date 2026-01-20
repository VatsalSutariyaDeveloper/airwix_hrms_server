module.exports = (sequelize, DataTypes) => {
    const HolidayTransaction = sequelize.define(
        "HolidayTransaction",
        {
            template_id: { type: DataTypes.INTEGER, allowNull: true },
            name: { type: DataTypes.STRING(100), allowNull: true },
            date: { type: DataTypes.DATE, allowNull: true },
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

    HolidayTransaction.associate = (models) => {
        HolidayTransaction.belongsTo(models.HolidayTemplate, { foreignKey: "template_id", as: "template" });
    };

    return HolidayTransaction;
}