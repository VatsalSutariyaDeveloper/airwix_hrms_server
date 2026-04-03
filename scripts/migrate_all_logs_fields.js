const { sequelize } = require("../models");

async function migrate() {
  const tables = ["logs", "activity_logs", "api_logs"];
  try {
    console.log("🚀 Starting database migration for all audit log tables...");
    
    for (const table of tables) {
      console.log(`\nProcessing table: ${table}`);
      
      // 1. Add Missing Columns
      console.log(`- Adding access_type, sql_query, and caller columns if missing...`);
      await sequelize.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS access_type VARCHAR(50);`);
      await sequelize.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS sql_query TEXT;`);
      await sequelize.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS caller TEXT;`);
      
      // 2. Drop Foreign Key on user_id to allow Device IDs
      console.log(`- Removing user_id foreign key constraint if it exists...`);
      // We attempt to drop standard constraint names based on common patterns
      const constraints = [`${table}_user_id_fkey`, `fk_${table}_user_id` ];
      for (const con of constraints) {
          try { await sequelize.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${con};`); } catch (e) {}
      }
    }
    
    console.log("\n✅ Migration completed successfully across all tables.");
  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
  } finally {
    if (sequelize) await sequelize.close();
  }
}

migrate();
