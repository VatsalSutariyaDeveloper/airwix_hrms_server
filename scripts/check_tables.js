const db = require("../models");

async function checkTables() {
  try {
    const [results] = await db.sequelize.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'employee_%';"
    );
    console.log("Raw results:", JSON.stringify(results, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkTables();
