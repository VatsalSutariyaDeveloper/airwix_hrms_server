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

  // Global hooks to prevent querying or inserting dropped branch columns
  const stripBranchFromObject = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if ('branch_id' in obj) {
      const val = obj.branch_id;
      if (val !== undefined && val !== null && val !== 0 && val !== "0" && val !== "All" && val !== "all") {
        obj.company_id = val;
      }
      delete obj.branch_id;
    }
    if ('branch_access' in obj) {
      delete obj.branch_access;
    }
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object') {
        stripBranchFromObject(obj[key]);
      }
    }
    const symbols = Object.getOwnPropertySymbols(obj);
    for (const sym of symbols) {
      if (obj[sym] && typeof obj[sym] === 'object') {
        stripBranchFromObject(obj[sym]);
      }
    }
  };

  const stripBranchFields = (options) => {
    if (!options) return;
    if (options.where) {
      stripBranchFromObject(options.where);
    }
    if (options.attributes) {
      if (Array.isArray(options.attributes)) {
        options.attributes = options.attributes.filter(attr => {
          if (typeof attr === 'string') {
            return attr !== 'branch_id' && attr !== 'branch_access';
          }
          if (Array.isArray(attr)) {
            return attr[0] !== 'branch_id' && attr[0] !== 'branch_access';
          }
          return true;
        });
      } else if (typeof options.attributes === 'object') {
        if (options.attributes.exclude) {
          options.attributes.exclude = options.attributes.exclude.filter(attr => attr !== 'branch_id' && attr !== 'branch_access');
        }
        if (options.attributes.include) {
          options.attributes.include = options.attributes.include.filter(attr => attr !== 'branch_id' && attr !== 'branch_access');
        }
      }
    }
    if (options.order && Array.isArray(options.order)) {
      options.order = options.order.filter(ord => {
        if (Array.isArray(ord)) {
          return ord[0] !== 'branch_id' && ord[0] !== 'branch_access';
        }
        if (typeof ord === 'string') {
          return !ord.includes('branch_id') && !ord.includes('branch_access');
        }
        return true;
      });
    }
    if (options.group) {
      if (Array.isArray(options.group)) {
        options.group = options.group.filter(g => g !== 'branch_id' && g !== 'branch_access');
      } else if (typeof options.group === 'string') {
        if (options.group === 'branch_id' || options.group === 'branch_access') {
          delete options.group;
        }
      }
    }
  };

  sequelize.addHook('beforeFind', (options) => {
    stripBranchFields(options);
  });

  sequelize.addHook('beforeCreate', (instance, options) => {
    if (instance.dataValues) {
      const val = instance.dataValues.branch_id;
      if (val !== undefined && val !== null && val !== 0 && val !== "0" && val !== "All" && val !== "all") {
        instance.dataValues.company_id = val;
      }
      delete instance.dataValues.branch_id;
      delete instance.dataValues.branch_access;
    }
  });

  sequelize.addHook('beforeUpdate', (instance, options) => {
    if (instance.dataValues) {
      const val = instance.dataValues.branch_id;
      if (val !== undefined && val !== null && val !== 0 && val !== "0" && val !== "All" && val !== "all") {
        instance.dataValues.company_id = val;
      }
      delete instance.dataValues.branch_id;
      delete instance.dataValues.branch_access;
    }
  });

  sequelize.addHook('beforeBulkCreate', (instances, options) => {
    for (const instance of instances) {
      if (instance && instance.dataValues) {
        const val = instance.dataValues.branch_id;
        if (val !== undefined && val !== null && val !== 0 && val !== "0" && val !== "All" && val !== "all") {
          instance.dataValues.company_id = val;
        }
        delete instance.dataValues.branch_id;
        delete instance.dataValues.branch_access;
      } else if (instance && typeof instance === 'object') {
        const val = instance.branch_id;
        if (val !== undefined && val !== null && val !== 0 && val !== "0" && val !== "All" && val !== "all") {
          instance.company_id = val;
        }
        delete instance.branch_id;
        delete instance.branch_access;
      }
    }
  });

  sequelize.addHook('beforeBulkUpdate', (options) => {
    if (options.attributes) {
      const val = options.attributes.branch_id;
      if (val !== undefined && val !== null && val !== 0 && val !== "0" && val !== "All" && val !== "all") {
        options.attributes.company_id = val;
      }
      delete options.attributes.branch_id;
      delete options.attributes.branch_access;
    }
    stripBranchFields(options);
  });

  connections[prefix] = sequelize;
  return sequelize;
};

// Default legacy export (uses DB_HOST, DB_NAME, etc. or defaults to HRMS_DB_HOST)
// We prioritize HRMS_ prefix as it's the primary one mentioned.
const defaultPrefix = process.env.HRMS_DB_NAME ? 'HRMS' : '';
const sequelize = createConnectionByPrefix(defaultPrefix);

module.exports = { sequelize, createConnectionByPrefix, connections };
