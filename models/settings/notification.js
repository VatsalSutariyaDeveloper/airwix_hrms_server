module.exports = (sequelize, DataTypes) => {
  const Notification = sequelize.define(
    "Notification",
    {
      receiver_id: { type: DataTypes.INTEGER, allowNull: false },
      title: { type: DataTypes.STRING, allowNull: false },
      message: { type: DataTypes.TEXT },
      type: { type: DataTypes.STRING, comment: "info, alert, task, etc." },
      is_read: { type: DataTypes.BOOLEAN, defaultValue: false },
      read_at: { type: DataTypes.DATE, allowNull: true },
      link: { type: DataTypes.STRING },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1 = Inactive, 2: Deleted"
      },
      user_id: { type: DataTypes.INTEGER, allowNull: true },
      branch_id: { type: DataTypes.INTEGER, allowNull: true },
      company_id: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      tableName: "notifications",
      timestamps: true,
      underscored: true,
    }
  );

  Notification.associate = (models) => {
    Notification.belongsTo(models.User, { foreignKey: "user_id", as: "user" });
    Notification.belongsTo(models.User, { foreignKey: "receiver_id", as: "receiver_user" });
    Notification.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
  };

  return Notification;
};