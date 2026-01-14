module.exports = (sequelize, DataTypes) => {
  const CustomField = sequelize.define("CustomField", {
    module_id: { type: DataTypes.INTEGER, allowNull: false, comment: "Links to ModuleMaster (e.g., Sales, Purchase)" },
    entity_id: { type: DataTypes.INTEGER, allowNull: false, comment: "Links to ModuleEntityMaster (e.g., Quotation, Invoice)" }, 
    field_label: { type: DataTypes.STRING(100), allowNull: false },
    field_name: { type: DataTypes.STRING(100), allowNull: false, comment: "Unique slug for the field, e.g., 'fabric_quality'" },
    field_type: { type: DataTypes.ENUM('text', 'number', 'textarea', 'select', 'date', 'checkbox', 'image'), allowNull: false },
    is_mandatory: { type: DataTypes.BOOLEAN, defaultValue: false, comment: "true: Yes, false: No" },
    is_readonly: { type: DataTypes.BOOLEAN, defaultValue: false, comment: "true: Yes, false: No" },
    default_value: { type: DataTypes.STRING(255), allowNull: true },
    placeholder: { type: DataTypes.STRING(255), allowNull: true },
    options: { type: DataTypes.JSONB, allowNull: true, defaultValue: [], comment: "Stores options for select/radio. Postgres JSONB is faster for querying." },
    validation_regex: { type: DataTypes.STRING(255), allowNull: true },
    priority: { type: DataTypes.INTEGER, defaultValue: 0, comment: "Order of display in the form" },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: { 
      type: DataTypes.SMALLINT, 
      defaultValue: 0, 
      comment: "0: Active, 1: Inactive, 2: Deleted" 
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: "custom_fields",
    timestamps: true,
    underscored: true,
  });

  CustomField.associate = (models) => {
    CustomField.belongsTo(models.ModuleMaster, { foreignKey: 'module_id', as: 'module' });
    CustomField.belongsTo(models.ModuleEntityMaster, { foreignKey: 'entity_id', as: 'entity' });
    CustomField.belongsTo(models.CompanyMaster, { foreignKey: 'company_id', as: 'company' });
    CustomField.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
  };

  return CustomField;
};