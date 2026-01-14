module.exports = (sequelize, DataTypes) => {
  const OtpVerification = sequelize.define("OtpVerification",
    {
      mobile_no: { type: DataTypes.STRING(20), allowNull: false},
      otp: { type: DataTypes.STRING(6), allowNull: false,},
      expires_at: { type: DataTypes.DATE, allowNull: false,},
      status: { type: DataTypes.SMALLINT, defaultValue: 0, comment: "0: Pending, 1: Verified", },
    },
    {
      tableName: "otp_verifications",
      underscored: true,
      timestamps: true,
    }
  );

  return OtpVerification;
};