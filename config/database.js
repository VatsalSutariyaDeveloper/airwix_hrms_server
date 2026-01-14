const { Sequelize } = require("sequelize");
require("dotenv").config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "postgres",
    port: process.env.DB_PORT || 5432,
    logging: process.env.DEBUG_SQL == "true" ? 
      (msg) => {
        if (typeof msg === "string") {
          console.log("\n[SQL]:", msg);
        }
      } : false,
    timezone: '+05:30',
  }
);

module.exports = sequelize;
