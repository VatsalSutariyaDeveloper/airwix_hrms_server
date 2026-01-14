module.exports = (sequelize, DataTypes) => {
    const RoutePermission = sequelize.define("RoutePermission", {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        method: { 
            type: DataTypes.ENUM('GET', 'POST', 'PUT', 'DELETE', 'PATCH'),
            allowNull: false 
        },
        path_pattern: { 
            type: DataTypes.STRING, 
            allowNull: false,
            comment: "Express route path (e.g., /sales/invoice/create)"
        },
        permission_id: { 
            type: DataTypes.INTEGER, 
            allowNull: false,
            references: {
                model: 'permissions', 
                key: 'id'
            },
            comment: "Foreign key to Permission table"
        },
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: Active, 1: Inactive, 2: Deleted"
        },
    }, {
        tableName: "route_permissions",
        timestamps: true,
        underscored: true,
        indexes: [
            { unique: true, fields: ['method', 'path_pattern'] }
        ]
    });

    RoutePermission.associate = (models) => {
        // Link back to the main Permission table
        RoutePermission.belongsTo(models.Permission, {
            foreignKey: 'permission_id',
            as: 'permission' 
        });
    };

    return RoutePermission;
};