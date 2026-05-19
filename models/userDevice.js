module.exports = (sequelize, DataTypes) => {
    const UserDevice = sequelize.define("UserDevice", {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: "Owner user ID"
        },
        company_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: "Company ID for tenant scope"
        },
        fcm_token: {
            type: DataTypes.TEXT,
            allowNull: false,
            unique: true,
            comment: "FCM registration token"
        }
    }, {
        tableName: "user_devices",
        underscored: true,
        timestamps: true
    });

    UserDevice.associate = (models) => {
        UserDevice.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    };

    return UserDevice;
};
