const { sequelize } = require("./models");

async function checkSchema() {
  try {
    const [results] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'logs'
      ORDER BY column_name;
    `);
    
    const columns = results.map(r => r.column_name);
    console.log("COLUMNS_START");
    console.log(JSON.stringify(columns, null, 2));
    console.log("COLUMNS_END");
  } catch (err) {
    console.error("Error checking schema:", err.message);
  } finally {
    if (sequelize) await sequelize.close();
  }
}

checkSchema();
