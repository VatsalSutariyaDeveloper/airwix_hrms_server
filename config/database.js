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
      pool: {
        max: 25,
        min: 0,
        acquire: 60000,
        idle: 30000
      },
      dialectOptions: {
        keepAlive: true,
        keepAliveInitialDelayMillis: 5000,
        // "acquire" above only bounds waiting for a free connection FROM the pool -
        // it does nothing once a connection is acquired. If that connection has gone
        // silently dead (network blip to the DB host), a query sent over it can hang
        // forever with zero visible activity in pg_stat_activity, since nothing ever
        // times out. connectionTimeoutMillis bounds establishing a new TCP connection;
        // statement_timeout has Postgres itself kill a slow/stuck query server-side;
        // query_timeout is a client-side timer that fires even if the connection is so
        // dead the server never even sees the query. Together these guarantee every
        // query resolves (success or error) within ~30s instead of hanging indefinitely.
        connectionTimeoutMillis: 10000,
        statement_timeout: 30000,
        idle_in_transaction_session_timeout: 30000,
        query_timeout: 30000
      },
      retry: {
        max: 3,
        match: [
          /ECONNRESET/,
          /ETIMEDOUT/,
          /EHOSTUNREACH/,
          /EPIPE/,
          /ECONNREFUSED/,
          Sequelize.ConnectionError
        ]
      }
    }
  );

  const modifyCompanyId = (options) => {
    if (!options.where) return;
    
    let getContext;
    try {
      getContext = require("../utils/requestContext").getContext;
    } catch (e) {
      return;
    }
    
    const ctx = getContext();
    if (ctx && ctx.selected_company_ids && ctx.selected_company_ids.length > 0) {
      const activeCompanyIds = ctx.selected_company_ids.map(Number);
      
      if (options.where.company_id !== undefined) {
        let requested = [];
        if (Array.isArray(options.where.company_id)) {
          requested = options.where.company_id;
        } else if (options.where.company_id && typeof options.where.company_id === 'object') {
          const keys = Object.getOwnPropertySymbols(options.where.company_id);
          const opInSymbol = keys.find(sym => sym.toString().includes('in'));
          const opEqSymbol = keys.find(sym => sym.toString().includes('eq'));
          
          if (opInSymbol && Array.isArray(options.where.company_id[opInSymbol])) {
            requested = options.where.company_id[opInSymbol];
          } else if (opEqSymbol) {
            requested = [options.where.company_id[opEqSymbol]];
          } else {
            if (Array.isArray(options.where.company_id.in)) {
              requested = options.where.company_id.in;
            } else if (options.where.company_id.eq) {
              requested = [options.where.company_id.eq];
            } else {
              return;
            }
          }
        } else {
          requested = [options.where.company_id];
        }
        
        const isPrimaryQuery = requested.some(id => Number(id) === Number(ctx.company_id));
        if (isPrimaryQuery) {
          options.where.company_id = activeCompanyIds.length === 1 ? activeCompanyIds[0] : { [Sequelize.Op.in]: activeCompanyIds };
        }
      }
    }
  };

  sequelize.addHook('beforeFind', modifyCompanyId);
  sequelize.addHook('beforeCount', modifyCompanyId);

  connections[prefix] = sequelize;
  return sequelize;
};

// Default legacy export (uses DB_HOST, DB_NAME, etc. or defaults to HRMS_DB_HOST)
// We prioritize HRMS_ prefix as it's the primary one mentioned.
const defaultPrefix = process.env.HRMS_DB_NAME ? 'HRMS' : '';
const sequelize = createConnectionByPrefix(defaultPrefix);

module.exports = { sequelize, createConnectionByPrefix, connections };
