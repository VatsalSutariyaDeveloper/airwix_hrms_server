module.exports = (sequelize, DataTypes) => {
    const Reimbursement = sequelize.define(
        "Reimbursement",
        {
            employee_id: { type: DataTypes.INTEGER },
            expense_type: { type: DataTypes.INTEGER },
            total_amount: { type: DataTypes.DECIMAL(10, 2) },
            date: { type: DataTypes.DATEONLY },
            expense_date: { type: DataTypes.DATEONLY, allowNull: true },
            description: { type: DataTypes.TEXT, allowNull: true },
            approved_by: { type: DataTypes.INTEGER, allowNull: true },
            bills_docs: { type: DataTypes.STRING, allowNull: true, comment: "Path to the uploaded bill document" },
            approval_status: { type: DataTypes.INTEGER, defaultValue: 0, comment: "0=PENDING, 1=PARTIALLY_APPROVED, 2=DELETED, 3=APPROVED, 4=REJECTED, 5=CANCELLED" },
            current_level: { type: DataTypes.INTEGER, defaultValue: 1, comment: "Tracks the current approval stage" },
            approval_history: { type: DataTypes.JSON, allowNull: true, comment: "Record of who approved at each level" },
            approval_remark: { type: DataTypes.TEXT, allowNull: true },
            payment_type: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null, comment: "1: Include in payroll (salary), 2: Direct payment (instant)" },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
                comment: "0: Active, 1: Inactive, 2: Deleted"
            },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "reimbursements",
            timestamps: true,
            underscored: true,
        }
    );

    Reimbursement.associate = (models) => {
        Reimbursement.belongsTo(models.Employee, { foreignKey: "employee_id", as: "employee" });
        Reimbursement.belongsTo(models.ExpenseType, { foreignKey: "expense_type", as: "expenseType" });
        Reimbursement.belongsTo(models.User, { foreignKey: "approved_by", as: "approvedBy" });
        Reimbursement.hasMany(models.ReimbursementItem, { foreignKey: "reimbursement_id", as: "items", onDelete: "CASCADE", onUpdate: "CASCADE" });
    };

    return Reimbursement;
};
