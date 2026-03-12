const { sequelize } = require("./models");

async function run() {
    try {
        const [results, metadata] = await sequelize.query(`
            ALTER TABLE leave_requests 
            ADD COLUMN IF NOT EXISTS start_session INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS end_session INTEGER DEFAULT 0;
        `);
        console.log("Columns added successfully");
        process.exit(0);
    } catch (err) {
        console.error("Error adding columns:", err);
        process.exit(1);
    }
}

run();
