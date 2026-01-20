module.exports = (sequelize, DataTypes) => {
    const Holiday = sequelize.define(
        "Holiday",
        {
            name: { type: DataTypes.STRING(100), allowNull: false },
            date: { type: DataTypes.DATEONLY, allowNull: true },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "holidays",
            timestamps: true,
            underscored: true,
        }
    );
    
    return Holiday;
}