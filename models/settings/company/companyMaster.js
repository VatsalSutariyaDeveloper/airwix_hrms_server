module.exports = (sequelize, DataTypes) => {
  const CompanyMaster = sequelize.define("CompanyMaster", {
    company_code: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    company_name: { type: DataTypes.STRING(100), allowNull: false },
    legal_name: { type: DataTypes.STRING(100), allowNull: true },
    address: { type: DataTypes.TEXT(), allowNull: true },
    country_id: { type: DataTypes.INTEGER, allowNull: true },
    state_id: { type: DataTypes.INTEGER, allowNull: true },
    city: { type: DataTypes.STRING(100), allowNull: true },
    pincode: { type: DataTypes.STRING(10), allowNull: true },
    mobile_no: { type: DataTypes.STRING(15), allowNull: true },
    email: { type: DataTypes.STRING(100), allowNull: true },
    tax_no: { type: DataTypes.STRING(30), allowNull: true },
    pan_no: { type: DataTypes.STRING(30), allowNull: true },
    currency_id: { type: DataTypes.INTEGER, allowNull: true },
    business_type_id: { type: DataTypes.INTEGER, allowNull: true },
    website_url: { type: DataTypes.STRING(255), allowNull: true },
    logo_image: { type: DataTypes.STRING(255), allowNull: true },
    admin_signature_img: { type: DataTypes.STRING(255), allowNull: true },
    is_default: { type: DataTypes.INTEGER, defaultValue: 2, comment: "1: Yes, 2: No" },
    deactivated_at: { type: DataTypes.DATE },
    status: {
      type: DataTypes.SMALLINT,
      defaultValue: 0,
      comment: "0: Active, 1: Inactive, 2: Deleted, 3: Suspended",
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    company_id: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
  }, {
    tableName: "company_master",
    timestamps: true,
    underscored: true,
  });

  CompanyMaster.associate = (models) => {
    // Association to CountryMaster (needed for country_name)
    CompanyMaster.belongsTo(models.CountryMaster, {
      as: "country",
      foreignKey: "country_id",
    });

    // Association to StateMaster (needed for state_name)
    CompanyMaster.belongsTo(models.StateMaster, {
      as: "state",
      foreignKey: "state_id",
    });

    CompanyMaster.hasMany(models.CompanyAddress, {
      as: "addresses",
      foreignKey: "company_id",
    });
  };

  return CompanyMaster;
};
