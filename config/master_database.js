const { Sequelize } = require('sequelize');
require('dotenv').config();

// Initialize Sequelize with the Master database credentials
const masterSequelize = new Sequelize(
  process.env.MASTER_DB_NAME,
  process.env.MASTER_DB_USER,
  process.env.MASTER_DB_PASSWORD,
  {
    host: process.env.MASTER_DB_HOST,
    dialect: 'mysql',
    logging: false, // Optional: disable logging for this connection
    port: process.env.MASTER_DB_PORT,
    pool: {
      max: 25,
      min: 2,
      acquire: 60000,
      idle: 10000
    }
  }
);

module.exports = masterSequelize;