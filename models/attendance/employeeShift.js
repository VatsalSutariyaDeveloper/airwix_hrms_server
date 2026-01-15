module.exports = (sequelize, DataTypes) => {
    const EmployeeShift = sequelize.define(
        "EmployeeShift",
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            employee_id: { type: DataTypes.INTEGER, allowNull: false },
            shift_id: { type: DataTypes.INTEGER, allowNull: false },
            effective_from: { type: DataTypes.DATEONLY, allowNull: false },
            effective_to: { type: DataTypes.DATEONLY, allowNull: true },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
            },
            user_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        },
        {
            tableName: "employee_shift",
            timestamps: true,
            underscored: true,
        }
    );

    return EmployeeShift;
};

