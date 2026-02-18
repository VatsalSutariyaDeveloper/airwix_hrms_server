const { Op } = require("sequelize");
const { sequelize } = require("../models");
const { getCompanySetting } = require("./cache");
const { logQuery } = require("./functions/logFunctions");
const { getContext } = require("../utils/requestContext.js");
const dayjs = require("dayjs");

const DEBUG_SQL = process.env.DEBUG_SQL === "true";

/**
 * ------------------------------------------------------------------
 * HELPERS
 * ------------------------------------------------------------------
 */

// Format SQL for console logging
function formatSQL(sql, bind) {
  if (!bind) return sql;

  const formatVal = (val) => {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "string") return `'${val.replace(/'/g, "''")}'`;
    if (val instanceof Date)
      return `'${dayjs(val).format("YYYY-MM-DD HH:mm:ss")}'`;
    if (typeof val === "object") {
      try {
        return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
      } catch (e) {
        return `'[Object]'`;
      }
    }
    return val;
  };

  if (Array.isArray(bind)) {
    let result = sql;
    // Handle $1, $2...
    result = result.replace(/\$([0-9]+)/g, (match, p1) => {
      const index = parseInt(p1) - 1;
      return formatVal(bind[index]);
    });
    // Handle ?
    let i = 0;
    result = result.replace(/\?/g, () => formatVal(bind[i++]));
    return result;
  } else if (typeof bind === "object") {
    // Handle :key
    return sql.replace(/:(\w+)/g, (match, p1) => formatVal(bind[p1]));
  }
  return sql;
}

// Wrapper to inject transaction and logging
function withDebug(options = {}, transaction = null) {
  const opts = { ...options };
  if (transaction) opts.transaction = transaction;

  opts.logging = (sql, queryObject) => {
    if (DEBUG_SQL) {
      const bind = queryObject.bind || queryObject.parameters || [];
      const formatted = formatSQL(sql, bind);
      console.log("\x1b[36m[SQL]\x1b[0m", formatted);
    }
  };
  return opts;
}

/**
 * ⚡️ UNIFIED BUILD WHERE FUNCTION
 * Merges input normalization, status filtering, and tenant logic.
 * * @param {Object|Array|String|Number} whereInput - The filter condition
 * @param {Boolean} applyDefaults - If true, injects Company, Branch, and User IDs based on settings
 */
async function buildWhere(whereInput, applyDefaults = true) {
  let where = {};

  // --- 1. Normalize Input ---
  if (Array.isArray(whereInput)) {
    where = { id: { [Op.in]: whereInput } };
  } else if (typeof whereInput === "string" || typeof whereInput === "number") {
    where = { id: whereInput };
  } else if (typeof whereInput === "object" && whereInput !== null) {
    where = { ...whereInput }; // Shallow copy
  } else if (whereInput === undefined) {
    where = {};
  } else {
    throw new Error("Invalid where clause provided");
  }

  // --- 2. Apply Status Filter ---
  // If status is not explicitly set, default to excluding deleted (2)
  if (where.status === undefined) {
    where.status = { [Op.ne]: 2 };
  }

  const ctx = getContext();

  // 1. Always Fetch Settings First (You need them for both IF and ELSE)
  let settings = { enable_user_wise_data: false, enable_branch_wise_data: false };
  try {
    if (ctx.company_id) {
      settings = await getCompanySetting(ctx.company_id);
    }
  } catch (err) {
    console.warn("⚠️ Failed to fetch company settings:", err.message);
  }

  // (Your temporary override if needed)
  settings = { enable_user_wise_data: false, enable_branch_wise_data: true };
  const { enable_user_wise_data, enable_branch_wise_data } = settings;

  if (applyDefaults) {
    // --- STANDARD STRICT BEHAVIOR ---
    if (ctx.company_id) where.company_id = ctx.company_id;

    if ((enable_branch_wise_data === "true" || enable_branch_wise_data === true) && ctx.branch_id) {
      where.branch_id = ctx.branch_id;
    } 

    if ((enable_user_wise_data === "true" || enable_user_wise_data === true) && ctx.user_id) {
      where.user_id = ctx.user_id;
    }

  } else {
    // --- LOOSE BEHAVIOR (-1 OR ContextID) ---
    
    // 1. Company Logic (Always check context)
    if (ctx.company_id) {
      where.company_id = { [Op.or]: [-1, ctx.company_id] };
    }

    // 2. Branch Logic (ONLY if enabled in settings)
    if ((enable_branch_wise_data === "true" || enable_branch_wise_data === true) && ctx.branch_id) {
       where.branch_id = { [Op.or]: [-1, ctx.branch_id] };
    }

    // 3. User Logic (ONLY if enabled in settings)
    if ((enable_user_wise_data === "true" || enable_user_wise_data === true) && ctx.user_id) {
       where.user_id = { [Op.or]: [-1, ctx.user_id] };
    }
  }
  return where;
}

// Normalizes attributes projection
function buildAttributes(options, includeId = false) {
  if (!options || typeof options !== "object") {
    return includeId ? { attributes: { exclude: ["id"] } } : {};
  }

  if (Array.isArray(options.attributes)) {
    if (options.attributes.length === 0) return { attributes: [] };

    const processedAttributes = options.attributes.map((attr) => {
      if (Array.isArray(attr) && typeof attr[0] === "string" && attr[0].includes(".")) {
        return [sequelize.col(attr[0]), attr[1]];
      }
      if (typeof attr === "string" && attr.includes(".")) {
        return [sequelize.col(attr), attr.split(".").pop()];
      }
      return attr;
    });
    return { attributes: processedAttributes };
  }

  if (includeId) {
    return { attributes: { exclude: ["id"] } };
  }

  return {};
}

// Recursively clean and secure Include options
async function normalizeInclude(includeArray) {
  if (!includeArray) return [];
  if (!Array.isArray(includeArray)) includeArray = [includeArray];

  return Promise.all(
    includeArray.map(async (inc) => {
      const newInc = { ...inc }; 
      const newWhere = { ...(newInc.where || {}) };

      if (newWhere.status === undefined) {
        newWhere.status = { [Op.ne]: 2 };
      }

      newInc.where = newWhere;
      newInc.required = newInc.required === true; 

      if (newInc.include) {
        newInc.include = await normalizeInclude(newInc.include);
      }

      return newInc;
    })
  );
}

/**
 * ------------------------------------------------------------------
 * CORE EXPORTS
 * ------------------------------------------------------------------
 */

module.exports = {
  // 1. Create Record
  createRecord: async (model, data, transaction = null, requireTenantFields=true) => {
    let enrichedData = { ...data }
    let commonData = {
      user_id: data.user_id,
      company_id: data.company_id,
      branch_id: data.branch_id,
    };
    if(requireTenantFields){
      const ctx = getContext();
      enrichedData.company_id= ctx.company_id;
      enrichedData.user_id= ctx.user_id;
      enrichedData.branch_id= ctx.branch_id;
      commonData = {
        user_id: ctx.user_id,
        company_id: ctx.company_id,
        branch_id: ctx.branch_id,
      };
    }

    const result = await model.create(enrichedData, withDebug({}, transaction));

    try {
      await logQuery({
        action_type: "CREATE",
        entity_name: model.name,
        record_id: result.id,
        new_data: result.toJSON ? result.toJSON() : result,
        ...commonData,
        ip_address: ctx.ip,
      }, transaction);
    } catch (logErr) {
      console.error("Audit log failed:", logErr.message);
    }

    return result;
  },

  // 2. Bulk Create
  bulkCreate: async (Model, dataArray, extraFields, transaction = null, requireTenantFields=true) => {
    if (!Array.isArray(dataArray) || !dataArray.length) return [];
    let enriched = dataArray.map((item) => ({ ...item, ...extraFields }));
    let commonData = {
      user_id: extraFields.user_id,
      company_id: extraFields.company_id,
      branch_id: extraFields.branch_id,
    };

    if(requireTenantFields){
      const ctx = getContext();
      enriched = dataArray.map((item) => ({
        ...item,
        company_id: ctx.company_id,
        user_id: ctx.user_id,
        branch_id: ctx.branch_id,
      }));

      commonData = {
        user_id: ctx.user_id,
        company_id: ctx.company_id,
        branch_id: ctx.branch_id,
      };
    }

    const createdRecords = await Model.bulkCreate(enriched, withDebug({}, transaction));

    if (createdRecords.length) {
      try {
        for (const record of createdRecords) {
          await logQuery({
            action_type: "BULK CREATE",
            entity_name: Model.name,
            record_id: record.id,
            ...commonData,
            ip_address: ctx.ip,
          }, transaction);
        }
      } catch (logErr) {
        console.error("Audit log failed:", logErr.message);
      }
    }

    return createdRecords;
  },

  // 3. Update Record
  updateRecordById: async (model, whereInput, data, transaction = null, forceReload = false, requireTenantFields=true) => {
    if (!whereInput || !model || !data) throw new Error("Invalid params for update");
    let condition = await buildWhere(whereInput, requireTenantFields); 
    
    let safeData = { ...data }
    let commonData = {
      user_id: data.user_id,
      company_id: data.company_id,
      branch_id: data.branch_id,
    };
    if(requireTenantFields){
      const ctx = getContext();
      safeData.company_id= ctx.company_id;
      safeData.user_id= ctx.user_id;
      safeData.branch_id= ctx.branch_id;
      commonData = {
        user_id: ctx.user_id,
        company_id: ctx.company_id,
        branch_id: ctx.branch_id,
      };
    }

    let oldRecord = null;
    try {
      oldRecord = await model.findOne({ where: condition, transaction, raw: true });
    } catch (e) {}
    if (!oldRecord) return null;
    const [count] = await model.update(
      safeData,
      withDebug({ where: condition }, transaction)
    );

    if (count === 0) return null;

    const newRecord = await model.findOne({ where: condition, transaction });
    if (newRecord && forceReload) await newRecord.reload({ transaction });

    try {
      const isStatusChange = Object.keys(safeData).length === 1 && safeData.status !== undefined;
      await logQuery({
        action_type: isStatusChange ? "STATUS_CHANGE" : "UPDATE",
        entity_name: model.name,
        record_id: newRecord.id,
        old_data: oldRecord,
        new_data: newRecord.toJSON(),
        ...commonData,
        ip_address: ctx.ip,
      }, transaction);
    } catch (logErr) {
      console.error("Audit log failed:", logErr.message);
    }

    return newRecord;
  },

  // 4. Soft Delete
  softDeleteById: async (model, whereInput, transaction = null, requireTenantFields=true) => {
    const ctx = getContext();
    const condition = await buildWhere(whereInput, requireTenantFields);

    const recordsToDelete = await model.findAll({
      where: condition,
      transaction,
      raw: true
    });

    if (!recordsToDelete.length) return 0;

    const [count] = await model.update(
      { status: 2, user_id: ctx.user_id },
      withDebug({ where: { id: { [Op.in]: recordsToDelete.map(r => r.id) } } }, transaction)
    );

    try {
      for (const record of recordsToDelete) {
        await logQuery({
          action_type: "DELETE",
          entity_name: model.name,
          record_id: record.id,
          old_data: record,
          user_id: ctx.user_id,
          company_id: ctx.company_id,
          branch_id: ctx.branch_id,
          ip_address: ctx.ip,
        }, transaction);
      }
    } catch (logErr) {
      console.error("Audit log failed:", logErr.message);
    }

    return count;
  },

  // 5. Find All
  findAllRecords: async (model, filters = {}, options = {}, transaction = null, requireTenantFields = true) => {
    const safeOptions = options || {};
    const where = await buildWhere(filters, requireTenantFields);

    const attributesOption = buildAttributes(safeOptions);
    const includeOption = safeOptions.include ? await normalizeInclude(safeOptions.include) : [];

    const queryOptions = withDebug({
      where,
      ...attributesOption,
      ...(safeOptions.skip ? { offset: safeOptions.skip } : {}),
      ...(safeOptions.limit ? { limit: safeOptions.limit } : {}),
      ...(safeOptions.order ? { order: safeOptions.order } : {}),
      ...(includeOption.length ? { include: includeOption } : {}),
      ...(safeOptions.group ? { group: safeOptions.group } : {}),
      ...(safeOptions.subQuery !== undefined
        ? { subQuery: safeOptions.subQuery }
        : safeOptions.group
        ? { subQuery: false }
        : {}),
      ...(safeOptions.raw && { raw: safeOptions.raw }),
      ...(safeOptions.nest && { nest: safeOptions.nest }),
    }, transaction);

    return model.findAll(queryOptions);
  },

  // 6. Count
  countRecords: async (model, filters = {}, options = {}, requireTenantFields = true) => {
    const safeOptions = options || {};
    const where = await buildWhere(filters, requireTenantFields);
    
    const includeOption = safeOptions.include ? await normalizeInclude(safeOptions.include) : [];

    const result = await model.count(withDebug({
      where,
      ...(includeOption.length ? { include: includeOption } : {}),
      ...(safeOptions.group ? { group: safeOptions.group } : {}),
      distinct: true,
      col: model.primaryKeyAttribute || "id",
    }));

    return Array.isArray(result) ? result.length : result;
  },

  // 7. Find One
  findOneRecord: async (model, whereInput = {}, options = {}, transaction = null, forceReload = false, requireTenantFields = true) => {
    const safeOptions = options || {};
    const condition = await buildWhere(whereInput, requireTenantFields);
    
    const attributesOption = buildAttributes(safeOptions);
    const includeOption = safeOptions.include ? await normalizeInclude(safeOptions.include) : [];

    const result = await model.findOne(withDebug({
      where: condition,
      ...attributesOption,
      ...(safeOptions.order ? { order: safeOptions.order } : {}),
      ...(includeOption.length ? { include: includeOption } : {}),
      ...(safeOptions.group ? { group: safeOptions.group } : {}),
      ...(safeOptions.raw && { raw: safeOptions.raw }),
      ...(safeOptions.nest && { nest: safeOptions.nest }),
    }, transaction));

    if (result && forceReload) await result.reload({ transaction });
    return result;
  },

  // 8. Hard Delete
  hardDeleteRecords: async (model, whereInput = {}, transaction = null, requireTenantFields = true) => {
    const condition = await buildWhere(whereInput, requireTenantFields);
    return model.destroy(withDebug({ where: condition }, transaction));
  },

  // 9. Aggregates
  sumRecords: async (model, field, filters = {}, transaction = null) => {
    const where = await buildWhere(filters, true);
    const total = await model.sum(field, withDebug({ where }, transaction));
    return total || 0;
  },

  incrementRecords: async (model, field, by = 1, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true);
    return model.increment(field, { by, where, transaction });
  },

  decrementRecords: async (model, field, by = 1, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true);
    return model.decrement(field, { by, where, transaction });
  },

  minRecords: async (model, field, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true);
    return model.min(field, { where, transaction });
  },

  maxRecords: async (model, field, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true);
    return model.max(field, { where, transaction });
  },

    // 10. ADVANCED PAGINATION
async fetchPaginatedData(model, reqBody, fieldConfig, options = {}, requireTenantFields = true, dateField = "createdAt", customWhere = {}) {
    try {
      const standardizedConfig = fieldConfig.map(([key, searchable, sortable]) => ({
        key,
        searchable: searchable === true,
        sortable: sortable === true,
      }));

      const page = Math.max(parseInt(reqBody?.page) || 1, 1);
      const isFetchAll = reqBody?.limit === "all" || reqBody?.limit === "All";
      const limit = isFetchAll ? undefined : (parseInt(reqBody?.limit) || 10);
      const skip = isFetchAll ? 0 : (page - 1) * limit;

      let filters = {};

      // A. Status
      if (reqBody?.status !== undefined && reqBody?.status !== "All") {
        if (Array.isArray(reqBody?.status) && reqBody?.status.length > 0) {
          filters.status = { [Op.in]: reqBody?.status };
        } else {
          const s = reqBody?.status;
          if (["Active", "0", 0].includes(s)) filters.status = 0;
          else if (["Deactive", "1", 1].includes(s)) filters.status = 1;
          else filters.status = s;
        }
      } 
      else if (reqBody?.status === "All") {
        // Optional: explicitly allow all statuses if needed, usually we just don't filter
        delete filters.status;
      }

      // B. Filter Object
      if (reqBody?.filter && typeof reqBody?.filter === "object") {
        for (const [k, v] of Object.entries(reqBody?.filter)) {
          if (Array.isArray(v) && v.length > 0) {
            filters[k] = { [Op.in]: v };
          } else if (v !== undefined && v !== null && v !== "") {
            filters[k] = v;
          }
        }
      }

      // C. Explicit Tenant overrides
      if (reqBody?.company_id) filters.company_id = reqBody?.company_id;
      if (reqBody?.branch_id) filters.branch_id = reqBody?.branch_id;
      if (reqBody?.user_id) filters.user_id = reqBody?.user_id;

      // D. Date Range
      if (reqBody?.startDate || reqBody?.endDate) {
        const dateFilter = {};
        if (reqBody?.startDate) dateFilter[Op.gte] = new Date(reqBody?.startDate);
        if (reqBody?.endDate) dateFilter[Op.lte] = new Date(reqBody?.endDate);
        if (Object.keys(dateFilter).length > 0) filters[dateField] = dateFilter;
      }

      // E. Search Logic
      const allowedSearchable = standardizedConfig.filter(f => f.searchable);
      let searchFields = reqBody?.searchFields || allowedSearchable.map(f => f.key);
      searchFields = searchFields.filter(key => allowedSearchable.some(f => f.key === key));

      if (reqBody?.search && searchFields.length > 0) {
        const attributeMap = new Map();
        if (options.attributes && Array.isArray(options.attributes)) {
            options.attributes.forEach(attr => {
                if (Array.isArray(attr)) attributeMap.set(attr[1], attr[0]);
                else if (typeof attr === 'string') attributeMap.set(attr.split('.').pop(), attr);
            });
        }

        const orConditions = searchFields.map((key) => {
            const config = standardizedConfig.find(f => f.key === key);
            if (!config) return null;
            let dbCol = attributeMap.has(config.key) ? attributeMap.get(config.key) : config.key;
            
            const likeVal = `%${reqBody?.search}%`;
            if (typeof dbCol === 'string') {
                const finalKey = dbCol.includes('.') && !dbCol.startsWith('$') ? `$${dbCol}$` : dbCol;
                return sequelize.where(
                    sequelize.cast(sequelize.col(finalKey.replace(/\$/g, '')), 'TEXT'),
                    { [Op.iLike]: likeVal }
                );
            } else {
                return sequelize.where(dbCol, { [Op.iLike]: likeVal });
            }
        }).filter(Boolean);

        if (orConditions.length > 0) filters[Op.or] = orConditions;
      }

      // 👇 CHANGE 2: Merge customWhere (User Access Logic)
      if (customWhere && (Object.keys(customWhere).length > 0 || Object.getOwnPropertySymbols(customWhere).length > 0)) {
        // If both Search and Custom Filter use [Op.or], we must use [Op.and] to combine them
        if (filters[Op.or] && customWhere[Op.or]) {
            filters = {
                [Op.and]: [
                    { [Op.or]: filters[Op.or] },      // The Search conditions
                    { [Op.or]: customWhere[Op.or] }   // The Custom conditions
                ],
                ...filters,
                ...customWhere
            };
            delete filters[Op.or]; // Remove top-level collision
            delete customWhere[Op.or]; // Ensure we don't overwrite
        } else {
            // Safe merge including Symbols
            filters = { ...filters, ...customWhere };
            // Manually copy Symbols (like Op.or) just in case
            const symbols = Object.getOwnPropertySymbols(customWhere);
            for (const sym of symbols) {
                filters[sym] = customWhere[sym];
            }
        }
      }

      // Sorting
      const sortableFields = standardizedConfig.filter(f => f.sortable).map(f => f.key);
      let order = [['createdAt', 'DESC']];
      if (reqBody?.sortBy && sortableFields.includes(reqBody?.sortBy)) {
        order = [[reqBody.sortBy, reqBody.sortDirection === "descending" ? "DESC" : "ASC"]];
      }

      // Execution
      let data = await module.exports.findAllRecords(
        model,
        filters, 
        { ...options, skip, limit, order, subQuery: false },
        null,
        requireTenantFields
      );

      // Sticky Includes (Logic preserved)
      if (reqBody?.include && typeof reqBody?.include === "object") {
        const includeConditions = [];
        for (const [key, value] of Object.entries(reqBody?.include)) {
            if (Array.isArray(value) && value.length > 0) includeConditions.push({ [key]: { [Op.in]: value } });
            else if (value) includeConditions.push({ [key]: value });
        }
        if (includeConditions.length > 0) {
            const stickyWhere = await buildWhere({ [Op.or]: includeConditions }, requireTenantFields);
            const extraRecords = await model.findAll({ where: stickyWhere, ...options });
            const existingIds = new Set(data.map(d => String(d.id)));
            const filteredExtras = extraRecords.filter(r => !existingIds.has(String(r.id)));
            data = [...data, ...filteredExtras];
        }
      }

      // Count Logic
      const countOptions = { ...options };
      delete countOptions.attributes;
      delete countOptions.order;
      delete countOptions.limit;
      delete countOptions.offset;
      const totalCount = await module.exports.countRecords(model, filters, countOptions, requireTenantFields);

      // Calculations
      let totals = {};
      if (options?.sumField && Array.isArray(data)) {
         const calculateSum = (field) => data.reduce((sum, row) => sum + (Number((row.get ? row.get(field) : row[field]) || 0) || 0), 0);
         if (typeof options.sumField === "string") totals[options.sumField] = calculateSum(options.sumField);
         else if (Array.isArray(options.sumField)) options.sumField.forEach(f => totals[f] = calculateSum(f));
         else if (typeof options.sumField === "object") Object.entries(options.sumField).forEach(([a, f]) => totals[a] = calculateSum(f));
      }

      return {
        items: data,
        total: totalCount,
        totals,
        currentPage: isFetchAll ? 1 : page,
        pageSize: isFetchAll ? totalCount : limit,
        totalPages: isFetchAll ? 1 : Math.ceil(totalCount / (limit || 1)),
        hasNextPage: isFetchAll ? false : (page * limit) < totalCount,
        hasPreviousPage: isFetchAll ? false : page > 1,
        appliedFilters: { ...reqBody, searchFields, sortableFields, filters: Object.keys(filters).length },
      };

    } catch (err) {
      console.error("FetchPaginatedData Error:", err);
      throw err;
    }
  }
  }