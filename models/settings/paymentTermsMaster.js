module.exports = (sequelize, DataTypes) => {
  const PaymentTermsMaster = sequelize.define(
    "PaymentTermsMaster",
    {
      terms_title: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      payment_day: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive, 2: Deleted",
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      branch_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "payment_terms_master",
      timestamps: true,
      underscored: true,
    }
  );

  return PaymentTermsMaster;
};
