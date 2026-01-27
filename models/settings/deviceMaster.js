module.exports = (sequelize, DataTypes) => {
    const DeviceMaster = sequelize.define(
        "DeviceMaster",
        {
            device_name: { type: DataTypes.STRING, allowNull: false },
            model_name: { type: DataTypes.STRING },
            mobile_no: { type: DataTypes.STRING, allowNull: true },
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
            tableName: "device_master",
            timestamps: true,
            underscored: true,
        }
    );
    return DeviceMaster;
}