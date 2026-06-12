module.exports = (sequelize, DataTypes) => {
    const Announcement = sequelize.define("Announcement", {
        title: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        content: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        announcement_date: {
            type: DataTypes.DATE,
            allowNull: false
        },
        expiry_date: {
            type: DataTypes.DATE,
            allowNull: true
        },
        announcement_type: {
            type: DataTypes.ENUM('info', 'urgent', 'update'),
            defaultValue: 'info'
        },
        target_type: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: "0: All users, 1: All employees, 2: Specific roles, 3: Specific users"
        },
        target:{
            type: DataTypes.STRING,
            allowNull: true,
            comment: "Target can be role_ids, user_ids, or null depending on target_type"
        },
        status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
        user_id: { type: DataTypes.INTEGER, allowNull: true },
        
        company_id: { type: DataTypes.INTEGER, allowNull: true }
    }, {
        tableName: "announcements",
        underscored: true,
        timestamps: true
    });

    Announcement.associate = (models) => {
        Announcement.belongsTo(models.User, {
            foreignKey: "user_id",
            as: "created_by"
        });
    };

    return Announcement;
};