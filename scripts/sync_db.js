const db = require("../models");

async function syncDatabase() {
  try {
    console.log("🛠️  Syncing new models one by one...");
    const newModels = [
      'EmployeeAttendanceTemplate',
      'EmployeeHoliday',
      'EmployeeWeeklyOff',
      'EmployeeLeaveCategory',
      'EmployeeSalaryComponent',
      'EmployeeShiftSetting',
      'EmployeePrintTemplate'
    ];

    for (const modelName of newModels) {
      try {
        console.log(`Syncing ${modelName}...`);
        await db[modelName].sync({ alter: true });
        console.log(`✅ ${modelName} synced.`);
      } catch (err) {
        console.error(`❌ Failed to sync ${modelName}:`, err.message);
        if (err.parent) {
            console.error("SQL Error:", err.parent.sql);
            console.error("Detail:", err.parent.detail);
        }
      }
    }
    process.exit(0);
  } catch (err) {
    console.error("❌ Fatal error:", err);
    process.exit(1);
  }
}

syncDatabase();
