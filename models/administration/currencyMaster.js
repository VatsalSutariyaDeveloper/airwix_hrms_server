module.exports = (sequelize, DataTypes) => {
  const CurrencyMaster = sequelize.define(
    "CurrencyMaster",
    {
      currency_name: { type: DataTypes.STRING(100), allowNull: false, unique: true, },
      currency_code: { type: DataTypes.STRING(10), allowNull: false, },
      currency_symbol: { type: DataTypes.STRING(10), allowNull: true, },
      currency_rate: { type: DataTypes.DECIMAL(15, 5), allowNull: false, defaultValue: 0, },
      is_default: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: No, 1: Yes",},
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive, 2: Deleted",
      },
      user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
      branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
      company_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, },
    },
    {
      tableName: "currency_master",
      timestamps: true,
      underscored: true,
    }
  );

  return CurrencyMaster;
};
