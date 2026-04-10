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
        priority: {
            type: DataTypes.ENUM('low', 'medium', 'high'),
            defaultValue: 'medium'
        },
        target_type: {
            type: DataTypes.INTEGER,
            defaultValue: 0
        },
        target:{
            type: DataTypes.STRING,
            allowNull: true
        },
        status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
        user_id: { type: DataTypes.INTEGER, allowNull: true },
        branch_id: { type: DataTypes.INTEGER, allowNull: true },
        company_id: { type: DataTypes.INTEGER, allowNull: true }
    }, {
        tableName: "announcements",
        underscored: true,
        timestamps: true
    });

    return Announcement;
};