module.exports = (sequelize, DataTypes) => {
    const ResignationReason = sequelize.define(
        "ResignationReason",
        {
            reason_name: { type: DataTypes.STRING, allowNull: false },
            status: { 
                type: DataTypes.SMALLINT, 
                defaultValue: 0, 
                comment: "0: Active, 1: Inactive, 2: Deleted" 
            },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "resignation_reasons",
            timestamps: true,
            underscored: true,
        }
    );

    ResignationReason.associate = (models) => {
        ResignationReason.hasMany(models.EmployeeResignation, {
            foreignKey: "reason_type_id",
            as: "resignations",
        });
    };

    return ResignationReason;
};
