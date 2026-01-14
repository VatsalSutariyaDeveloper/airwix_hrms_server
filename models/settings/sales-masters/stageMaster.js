module.exports = (sequelize, DataTypes) => {
  const StageMaster = sequelize.define(
    "StageMaster",
    {
      name: { type: DataTypes.STRING(100), allowNull: false },
      type: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0, comment: "1=Leads(leads), 2=General Task, 3=Appointment" },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Inactive, 2: Deleted",
      },
      user_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      branch_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: "stage_master",
      timestamps: true,
      underscored: true,
    }
  );

  return StageMaster;
};
