module.exports = (sequelize, DataTypes) => {
  const FaceRecognitionError = sequelize.define(
    "FaceRecognitionError",
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      image: { type: DataTypes.STRING, allowNull: true },
      accuracy: { type: DataTypes.DECIMAL(10, 4), allowNull: true },
      time: { type: DataTypes.DATE, allowNull: false },
      company_id: { type: DataTypes.INTEGER, defaultValue: 0 },
      branch_id: { type: DataTypes.INTEGER, defaultValue: 0 },
      employee_id: { type: DataTypes.INTEGER, allowNull: true },
      latitude: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
      status: {
        type: DataTypes.SMALLINT,
        defaultValue: 0,
        comment: "0: Active, 1: Resolved/Cleared",
      },
      matches: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: "Stores array of face matches (employee name and match score)"
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: "Stores details about the recognition error or failure reason"
      },
    },
    {
      tableName: "face_recognition_errors",
      timestamps: true,
      underscored: true,
    }
  );

  FaceRecognitionError.associate = (models) => {
    FaceRecognitionError.belongsTo(models.CompanyMaster, { foreignKey: "company_id", as: "company" });
    FaceRecognitionError.belongsTo(models.BranchMaster, { foreignKey: "branch_id", as: "branch" });
    FaceRecognitionError.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
  };

  return FaceRecognitionError;
};
