module.exports = (sequelize, DataTypes) => {
    const Notification = sequelize.define("Notification", {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: "Recipient user ID"
        },
        title: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        message: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        type: {
            type: DataTypes.STRING(50),
            allowNull: false,
            comment: "LEAVE, RESIGNATION, OUT_DUTY, REGULARIZATION, ATTENDANCE"
        },
        reference_id: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: "Primary Key of the related entity"
        },
        is_read: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: "0: Unread, 1: Read"
        },
        redirect_url: {
            type: DataTypes.STRING(255),
            allowNull: true
        },
        status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
        status_code : {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: "0: Success/Info, 1: Warning, 2: Danger"
        },
        company_id: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        branch_id: {
            type: DataTypes.INTEGER,
            allowNull: true
        }
    }, {
        tableName: "notifications",
        underscored: true,
        timestamps: true
    });

    Notification.associate = (models) => {
        Notification.belongsTo(models.User, { foreignKey: "user_id", as: "recipient" });
    };

    return Notification;
};
