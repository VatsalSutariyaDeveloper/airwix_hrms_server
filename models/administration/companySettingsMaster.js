module.exports = (sequelize, DataTypes) => {
  const CompanySettingsMaster = sequelize.define("CompanySettingsMaster", {
    setting_key: { type: DataTypes.STRING(150), allowNull: false, unique: true },
    setting_label: { type: DataTypes.STRING(255) },
    setting_group: { type: DataTypes.ENUM('GENERAL', 'PRODUCT', 'INVENTORY', 'SALES', 'PURCHASE', 'BARCODE', 'EMAIL'), defaultValue: 'GENERAL' },
    input_type: { type: DataTypes.ENUM('TEXT', 'NUMBER', 'TEXTAREA', 'SELECT', 'SWITCH'), defaultValue: 'TEXT' },
    options: { type: DataTypes.JSONB, allowNull: true, comment: "Stores options for select/multiselect input types" },
    default_value: { type: DataTypes.TEXT, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted",
    },
    entity_visiblity: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1: Yes, 2: No" },
    priority: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
    {
      tableName: "company_settings_master",
      timestamps: true,
      underscored: true,
    }
  );
  return CompanySettingsMaster;
};