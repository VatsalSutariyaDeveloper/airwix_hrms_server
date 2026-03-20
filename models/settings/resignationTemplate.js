module.exports = (sequelize, DataTypes) => {
    const ResignationTemplate = sequelize.define(
        "ResignationTemplate",
        {
            template_name: { type: DataTypes.STRING(100), allowNull: false },
            approval_levels: { 
                type: DataTypes.INTEGER, 
                defaultValue: 1, 
                comment: "Number of approval levels (1, 2, or 3)" 
            },
            approval_config: { 
                type: DataTypes.JSONB, 
                allowNull: true,
                comment: "Config for each level: [{level: 1, type: 'REPORTING_MANAGER/ADMIN/ETC'}]"
            },
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
            tableName: "resignation_templates",
            timestamps: true,
            underscored: true,
        }
    );

    ResignationTemplate.associate = (models) => {
        ResignationTemplate.hasMany(models.Employee, {
            foreignKey: "resignation_template_id",
            as: "employees",
        });
    };

    return ResignationTemplate;
};
