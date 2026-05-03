module.exports = (sequelize, DataTypes) => {
  const CronJobRun = sequelize.define("CronJobRun", {
    job_name: { type: DataTypes.STRING(100), allowNull: false },
    start_time: { type: DataTypes.DATE, allowNull: false },
    end_time: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.ENUM("RUNNING", "SUCCESS", "FAILED", "REVERTED"), defaultValue: "RUNNING" },
    as_of: { type: DataTypes.DATE, allowNull: true },
    reverted_at: { type: DataTypes.DATE, allowNull: true },
    summary: { type: DataTypes.JSONB, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: "cron_job_runs",
    timestamps: true,
    underscored: true,
  });

  CronJobRun.associate = (models) => {
    CronJobRun.hasMany(models.Logs, { foreignKey: "batch_id", as: "logs" });
  };

  return CronJobRun;
};
