module.exports = (sequelize, DataTypes) => {
    const ReimbursementItem = sequelize.define(
        "ReimbursementItem",
        {
            reimbursement_id: { type: DataTypes.INTEGER, allowNull: false },
            expense_type: { type: DataTypes.INTEGER, allowNull: true },
            amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
            expense_date: { type: DataTypes.DATEONLY, allowNull: true },
            description: { type: DataTypes.TEXT, allowNull: true },
            bills_docs: { type: DataTypes.STRING, allowNull: true, comment: "Path to the uploaded bill document" },
            company_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            status: {
                type: DataTypes.SMALLINT,
                defaultValue: 0,
                comment: "0: Active, 1: Inactive, 2: Deleted"
            },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
        },
        {
            tableName: "reimbursement_items",
            timestamps: true,
            underscored: true,
            indexes: [
                { fields: ['reimbursement_id'] },
                { fields: ['expense_type'] },
                { fields: ['company_id'] },
                { fields: ['branch_id'] },
                { fields: ['status'] }
            ]
        }
    );

    ReimbursementItem.associate = (models) => {
        ReimbursementItem.belongsTo(models.Reimbursement, { foreignKey: "reimbursement_id", as: "reimbursement", onDelete: "CASCADE", onUpdate: "CASCADE" });
        ReimbursementItem.belongsTo(models.ExpenseType, { foreignKey: "expense_type", as: "expenseType", onDelete: "SET NULL", onUpdate: "CASCADE" });
        ReimbursementItem.belongsTo(models.User, { foreignKey: "user_id", as: "user", onDelete: "SET NULL", onUpdate: "CASCADE" });
    };

    return ReimbursementItem;
};
