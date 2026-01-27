module.exports = (sequelize, DataTypes) => {
    const Department = sequelize.define(
        "Department",
        {
            name: { type: DataTypes.STRING(100), allowNull: false },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "departments",
            timestamps: true,
            underscored: true,
        }
    );

    Department.associate = function(models) {
        Department.hasMany(models.Employee, {
            foreignKey: 'department_id',
            as: 'employees'
        });
    };
      
    return Department;
}