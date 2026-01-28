/*
CREATE TABLE holiday_transactions (
    id SERIAL PRIMARY KEY,
    template_id INTEGER,
    name VARCHAR(100),
    date DATE,
    holiday_type SMALLINT DEFAULT 1,
    color VARCHAR(20) DEFAULT '#E11D48',
    status SMALLINT DEFAULT 0,
    user_id INTEGER,
    branch_id INTEGER,
    company_id INTEGER,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);
*/
module.exports = (sequelize, DataTypes) => {
    const HolidayTransaction = sequelize.define(
        "HolidayTransaction",
        {
            template_id: { type: DataTypes.INTEGER, allowNull: true },
            name: { type: DataTypes.STRING(100), allowNull: true },
            date: { type: DataTypes.DATEONLY, allowNull: true },
            holiday_type: { type: DataTypes.SMALLINT, defaultValue: 1, comment: "1: Mandatory, 2: Restricted" },
            color: { type: DataTypes.STRING(20), defaultValue: "#E11D48" },
            status: { type: DataTypes.SMALLINT, defaultValue: 0 },
            user_id: { type: DataTypes.INTEGER, allowNull: true },
            branch_id: { type: DataTypes.INTEGER, allowNull: true },
            company_id: { type: DataTypes.INTEGER, allowNull: true }
        },
        {
            tableName: "holiday_transactions",
            timestamps: true,
            underscored: true,
        }
    );

    return HolidayTransaction;
}