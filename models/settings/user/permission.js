module.exports = (sequelize, DataTypes) => {
    const Permission = sequelize.define("Permission", {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        // Replaces 'entity' string
        module_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'module_master',
                key: 'id'
            },
            comment: "Links to ModuleMaster (The high-level Entity, e.g. Sales)"
        },
        // Replaces 'entity' string
        entity_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'module_entity_master',
                key: 'id'
            },
            comment: "Links to ModuleEntityMaster (The Entity, e.g. Invoice)"
        },
        action: {
            type: DataTypes.STRING,
            allowNull: false,
            comment: "e.g. create, view, edit, delete, approve"
        },
        slug: {
            type: DataTypes.STRING,
            allowNull: true
        },
        description: {
            type: DataTypes.STRING
        },
        status: {
            type: DataTypes.SMALLINT,
            defaultValue: 0,
            comment: "0: Active, 1: Inactive, 2: Deleted"
        },
        user_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
        branch_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
        company_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 }
    }, {
        tableName: "permissions",
        timestamps: true,
        underscored: true,
        indexes: [
            {
                unique: true,
                fields: ['slug']
            }
        ],
        hooks: {
            // ASYNC HOOK: Fetch names and build slug before saving
            beforeValidate: async (permission, options) => {
                if (permission.module_id && permission.entity_id && permission.action) {
                    try {
                        // 1. Fetch entity Name (e.g., "Sales")
                        // access models from sequelize instance attached to the record
                        const ModuleMaster = sequelize.models.ModuleMaster;
                        const ModuleEntityMaster = sequelize.models.ModuleEntityMaster;

                        const module = await ModuleMaster.findByPk(permission.module_id, {
                            transaction: options.transaction
                        });
                        const moduleEntity = await ModuleEntityMaster.findByPk(permission.entity_id, {
                            transaction: options.transaction
                        });

                        if (!module || !moduleEntity) {
                            throw new Error("Invalid entity ID or Entity ID");
                        }

                        // 2. Clean strings (remove spaces, lowercase)
                        // "Sales" -> "sales", "Invoice List" -> "invoicelist"
                        const modulePart = module.module_name.replace(/\s+/g, '').toLowerCase();
                        const entityPart = moduleEntity.entity_name.replace(/\s+/g, '').toLowerCase();
                        const actionPart = permission.action.replace(/\s+/g, '').toLowerCase();

                        // 3. Set Slug
                        permission.slug = `${modulePart}.${entityPart}.${actionPart}`;
                    } catch (err) {
                        console.error("Slug generation failed:", err);
                        throw new Error("Failed to generate permission slug. Check IDs.");
                    }
                }
            }
        }
    });

    Permission.associate = (models) => {
        // Link to RoutePermission
        // Permission.hasMany(models.RoutePermission, {
        //     foreignKey: 'permission_id',
        //     as: 'routePermissions'
        // });

        // Link to Master tables (for querying later)
        Permission.belongsTo(models.ModuleMaster, {
            foreignKey: 'module_id',
            as: 'module'
        });
        Permission.belongsTo(models.ModuleEntityMaster, {
            foreignKey: 'entity_id',
            as: 'entity'
        });
    };

    return Permission;
};