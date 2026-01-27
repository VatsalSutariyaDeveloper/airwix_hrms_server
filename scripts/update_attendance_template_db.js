const dotenv = require("dotenv");
dotenv.config({ path: ".env.local", override: true });
dotenv.config({ path: ".env" });
const sequelize = require("../config/database");
const { DataTypes } = require("sequelize");

async function updateDatabase() {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = "attendance_templates";

  try {
    console.log(`Starting database update for table: ${tableName}...`);

    // 1. Policy Links
    await queryInterface.addColumn(tableName, "holiday_template_id", {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    }).catch(e => {});

    await queryInterface.addColumn(tableName, "weekly_off_template_id", {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    }).catch(e => {});

    // 2. Late Entry & Early Exit Rules
    await queryInterface.addColumn(tableName, "late_entry_limit", {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Allowed late entries per month before fine'
    }).catch(e => {});

    try {
      await sequelize.query('CREATE TYPE "enum_attendance_templates_late_entry_fine_type" AS ENUM(\'NONE\', \'FIXED\', \'PERCENTAGE\', \'DEDUCTION\');');
    } catch (e) {}

    await queryInterface.addColumn(tableName, "late_entry_fine_type", {
      type: DataTypes.ENUM('NONE', 'FIXED', 'PERCENTAGE', 'DEDUCTION'),
      defaultValue: 'NONE',
    }).catch(e => {});

    await queryInterface.addColumn(tableName, "late_entry_fine_value", {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    }).catch(e => {});

    await queryInterface.addColumn(tableName, "early_exit_limit", {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Allowed early exits per month before fine'
    }).catch(e => {});

    try {
      await sequelize.query('CREATE TYPE "enum_attendance_templates_early_exit_fine_type" AS ENUM(\'NONE\', \'FIXED\', \'PERCENTAGE\', \'DEDUCTION\');');
    } catch (e) {}

    await queryInterface.addColumn(tableName, "early_exit_fine_type", {
      type: DataTypes.ENUM('NONE', 'FIXED', 'PERCENTAGE', 'DEDUCTION'),
      defaultValue: 'NONE',
    }).catch(e => {});

    await queryInterface.addColumn(tableName, "early_exit_fine_value", {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    }).catch(e => {});

    // 3. Overtime Rules
    await queryInterface.addColumn(tableName, "overtime_allowed", {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    }).catch(e => {});

    await queryInterface.addColumn(tableName, "min_overtime_mins", {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Minimum minutes needed to count as overtime'
    }).catch(e => {});

    await queryInterface.addColumn(tableName, "max_overtime_mins", {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Maximum OT allowed per day (0 = Unlimited)'
    }).catch(e => {});

    console.log("Database update completed!");
  } catch (error) {
    console.error("Error updating database:", error);
  } finally {
    await sequelize.close();
  }
}

updateDatabase();
