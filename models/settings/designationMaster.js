module.exports = (sequelize, DataTypes) => {
    const DesignationMaster = sequelize.define(
        "DesignationMaster",
        {
            designation_name: { type: DataTypes.STRING, allowNull: false },
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
            tableName: "designation_master",
            timestamps: true,
            underscored: true,
        }
    );
    return DesignationMaster;
}