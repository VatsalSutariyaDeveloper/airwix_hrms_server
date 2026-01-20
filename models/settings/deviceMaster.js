module.exports = (sequelize, DataTypes) => {
    const DeviceMaster = sequelize.define(
        "DeviceMaster",
        {
            device_name: { type: DataTypes.STRING, allowNull: false },
            model_name: { type: DataTypes.STRING, unique: true, allowNull: false },
            access_by: { type: DataTypes.INTEGER, allowNull: true, comment: "User who last accessed/modified the device" },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
                comment: "0: Active, 1: Inactive, 2: Deleted"
            },
            user_id: { type: DataTypes.INTEGER, defaultValue: 0, comment: "Owner of the device" },
            branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
            company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
        },
        {
            tableName: "device_master",
            timestamps: true,
            underscored: true,
        }
    );
    DeviceMaster.associate = models => {
        DeviceMaster.belongsTo(models.User, {
            foreignKey: "user_id",
            as: "owner"
        });
        DeviceMaster.belongsTo(models.User, {
            foreignKey: "access_by",
            as: "accessBy"
        });
    };
    return DeviceMaster;
}