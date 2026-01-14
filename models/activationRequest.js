module.exports = (sequelize, DataTypes) => {
  const ActivationRequest = sequelize.define(
    "ActivationRequest",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM("pending", "approved", "rejected"),
        defaultValue: "pending",
        comment: "Current status of the activation request",
      },
      request_message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: "Optional message from the user",
      },
      admin_remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: "Remarks added by admin when approving/rejecting",
      },
      resolved_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      resolved_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      tableName: "activation_requests",
      timestamps: true,
      underscored: true,
    }
  );

  ActivationRequest.associate = (models) => {
    ActivationRequest.belongsTo(models.CompanyMaster, {
      foreignKey: "company_id",
      as: "company",
    });
    ActivationRequest.belongsTo(models.User, {
      foreignKey: "user_id",
      as: "user",
    });
  };

  return ActivationRequest;
};