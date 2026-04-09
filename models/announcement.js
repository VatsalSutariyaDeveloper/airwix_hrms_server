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
        status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Active, 1: Inactive, 2: Deleted" },
        priority: {
            type: DataTypes.ENUM('low', 'medium', 'high'),
            defaultValue: 'medium'
        },
        target_audience: {
            type: DataTypes.STRING(255),
            defaultValue: 'all'
        },
        created_by: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: "User ID who created the announcement"
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
        tableName: "announcements",
        underscored: true,
        timestamps: true
    });

    Announcement.associate = (models) => {
        Announcement.belongsTo(models.User, { foreignKey: "created_by", as: "creator" });
    };

    return Announcement;
};