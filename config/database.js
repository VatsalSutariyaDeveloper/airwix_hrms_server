const { Sequelize } = require("sequelize");
require("dotenv").config();

const connections = {};

/**
 * Creates or retrieves a Sequelize connection based on an ENV prefix.
 * Example: if prefix is 'AIRWIX', it looks for AIRWIX_DB_HOST, AIRWIX_DB_USER, etc.
 */
const createConnectionByPrefix = (prefix) => {
  if (connections[prefix]) {
    return connections[prefix];
  }

  const dbHost = process.env[`${prefix}_DB_HOST`] || process.env.DB_HOST;
  const dbPort = process.env[`${prefix}_DB_PORT`] || process.env.DB_PORT || 5432;
  const dbUser = process.env[`${prefix}_DB_USER`] || process.env.DB_USER;
  const dbPass = process.env[`${prefix}_DB_PASSWORD`] || process.env.DB_PASSWORD;
  const dbName = process.env[`${prefix}_DB_NAME`] || process.env.DB_NAME;

  if (!dbHost || !dbName) {
    throw new Error(`Database configuration for prefix '${prefix}' is incomplete (missing host or name).`);
  }

  const sequelize = new Sequelize(
    dbName,
    dbUser,
    dbPass,
    {
      host: dbHost,
      dialect: "postgres",
      port: dbPort,
      logging: process.env.DEBUG_SQL == "true" ? 
        (msg) => {
          if (typeof msg === "string") {
            console.log(`\n[SQL - ${prefix}]:`, msg);
          }
        } : false,
      timezone: '+05:30',
    }
  );

  connections[prefix] = sequelize;
  return sequelize;
};

// Default legacy export (uses DB_HOST, DB_NAME, etc. or defaults to HRMS_DB_HOST)
// We prioritize HRMS_ prefix as it's the primary one mentioned.
const defaultPrefix = process.env.HRMS_DB_NAME ? 'HRMS' : '';
const sequelize = createConnectionByPrefix(defaultPrefix);

module.exports = { sequelize, createConnectionByPrefix, connections };
