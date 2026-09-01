module.exports = (sequelize, DataTypes) => {
    const LeaveSandwichReviewFlag = sequelize.define(
        "LeaveSandwichReviewFlag",
        {
            employee_id: { type: DataTypes.INTEGER, allowNull: false },
            earlier_leave_request_id: { type: DataTypes.INTEGER, allowNull: false },
            later_leave_request_id: { type: DataTypes.INTEGER, allowNull: false },
            leave_category_id: { type: DataTypes.INTEGER, allowNull: true },
            gap_dates: {
                type: DataTypes.JSON,
                allowNull: true,
                comment: "The specific off-days newly implicated by the pair of requests"
            },
            suggested_additional_days: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
            review_status: {
                type: DataTypes.SMALLINT,
                allowNull: false,
                defaultValue: 0,
                comment: "0: Pending review, 1: Applied, 2: Dismissed"
            },
            reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
            reviewed_at: { type: DataTypes.DATE, allowNull: true },
            remark: { type: DataTypes.TEXT, allowNull: true },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
                comment: "0: Active, 1: Inactive, 2: Deleted"
            },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true }
        },
        {
            tableName: "leave_sandwich_review_flags",
            timestamps: true,
            underscored: true,
        }
    );

    LeaveSandwichReviewFlag.associate = (models) => {
        LeaveSandwichReviewFlag.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        LeaveSandwichReviewFlag.belongsTo(models.LeaveRequest, { foreignKey: "earlier_leave_request_id", as: "earlierRequest" });
        LeaveSandwichReviewFlag.belongsTo(models.LeaveRequest, { foreignKey: "later_leave_request_id", as: "laterRequest" });
        LeaveSandwichReviewFlag.belongsTo(models.LeaveTemplateCategory, { foreignKey: "leave_category_id", as: "category" });
        LeaveSandwichReviewFlag.belongsTo(models.User, { foreignKey: "reviewed_by", as: "reviewer" });
    };

    return LeaveSandwichReviewFlag;
};
