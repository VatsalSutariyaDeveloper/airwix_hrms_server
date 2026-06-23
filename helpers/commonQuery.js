const { Op } = require("sequelize");
const { sequelize } = require("../models");
const { getCompanySetting } = require("./cache");
const { logQuery } = require("./functions/logFunctions");
const { getContext } = require("../utils/requestContext.js");
const dayjs = require("dayjs");

const DEBUG_SQL = process.env.DEBUG_SQL === "true";

// Capture stack at the entry of these functions to bypass async stack loss
const captureCaller = () => {
    const stack = new Error().stack.split("\n");
    // [0] Error, [1] captureCaller, [2] commonQuery function, [3] ACTUAL CALLER
    return stack[3] ? stack[3].trim().replace(/^at /, "") : "unknown";
};

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
function withDebug(options = {}, transaction = null, capture = null) {
  const opts = { ...options };
  if (transaction) opts.transaction = transaction;

  // Use pre-captured caller if available, otherwise fallback to current stack
  let caller = opts.__caller;
  if (!caller) {
    const stack = new Error().stack.split("\n");
    caller = stack[3] ? stack[3].trim().replace(/^at /, "") : "unknown";
  }

  opts.logging = (sql, queryObject) => {
    const bind = queryObject.bind || queryObject.parameters || [];
    const formatted = formatSQL(sql, bind);
    
    if (capture && typeof capture === 'object') {
        capture.sql = formatted; 
    }

    if (DEBUG_SQL) {
      console.log("\x1b[36m[SQL]\x1b[0m", formatted);
      console.log("\x1b[90m[From]\x1b[0m", caller);
    }
  };
  return opts;
}

/**
 * ⚡️ UNIFIED BUILD WHERE FUNCTION
 * Merges input normalization, status filtering, and tenant logic.
 * * @param {Object|Array|String|Number} whereInput - The filter condition
 * @param {Boolean} applyDefaults - If true, injects Company, Branch, and User IDs based on settings
 * @param {Boolean} [skipStatus=false] - When true the default status (not equal 2) check is skipped;
 *                                       useful for include queries where status should not be applied
 */
function resolveTenantConfig(requireTenantFields, defaultApplyHierarchy) {
  if (typeof requireTenantFields === 'object' && requireTenantFields !== null) {
    return { applyHierarchy: defaultApplyHierarchy, ...requireTenantFields };
  }
  return {
    company_id: !!requireTenantFields,
    branch_id: !!requireTenantFields,
    user_id: !!requireTenantFields,
    applyHierarchy: requireTenantFields === true ? defaultApplyHierarchy : false
  };
}

async function buildWhere(whereInput, tenantConfig = true, skipStatus = false, model = null) {
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
  if (!skipStatus && model && model.rawAttributes && !model.rawAttributes.status) {
    skipStatus = true;
  }

  if (!skipStatus) {
    if (where.status === undefined) {
      where.status = { [Op.ne]: 2 };
    }
  }

  const isObj = typeof tenantConfig === "object" && tenantConfig !== null;
  const isEmptyObj = isObj && Object.keys(tenantConfig).length === 0;
  const ctx = getContext();
  try {
    if (ctx.company_id) {
      settings = await getCompanySetting(ctx.company_id);
    }
  } catch (err) {
    console.warn("⚠️ Failed to fetch company settings:", err.message);
  }

  // Temporary override if needed
  settings = { enable_user_wise_data: false, enable_branch_wise_data: true };
  const { enable_user_wise_data, enable_branch_wise_data } = settings;


  const hasCompanyField = !model || !model.rawAttributes || !!model.rawAttributes.company_id;
  const hasBranchField = !model || !model.rawAttributes || !!model.rawAttributes.branch_id;
  const hasUserField = !model || !model.rawAttributes || !!model.rawAttributes.user_id;

  if (tenantConfig === true) {
    if (ctx.company_id && hasCompanyField) {
      if (where.company_id === undefined) {
        where.company_id = ctx.company_id;
      } else if (!ctx.is_super_admin) {
        let requested = [];
        if (Array.isArray(where.company_id)) {
          requested = where.company_id;
        } else if (where.company_id && typeof where.company_id === 'object' && where.company_id[Op.in]) {
          requested = where.company_id[Op.in];
        } else {
          requested = [where.company_id];
        }
        const intersected = requested.filter(id => Number(id) === Number(ctx.company_id));
        where.company_id = intersected.length > 0 ? { [Op.in]: intersected } : ctx.company_id;
      }
    }
    if (enable_branch_wise_data === "true" || enable_branch_wise_data === true) {
      if (hasBranchField) {
        if (ctx.branch_id && ctx.branch_id !== 0 && ctx.branch_id !== "0") {
          if (where.branch_id === undefined) {
            where.branch_id = ctx.branch_id;
          } else {
            where.branch_id = ctx.branch_id;
          }
        } else if (!ctx.is_super_admin && ctx.branch_access) {
          let allowedBranches = [];
          if (typeof ctx.branch_access === 'string') {
            allowedBranches = ctx.branch_access.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
          } else if (Array.isArray(ctx.branch_access)) {
            allowedBranches = ctx.branch_access.map(id => parseInt(id)).filter(id => !isNaN(id));
          }
          if (allowedBranches.length > 0) {
            if (where.branch_id === undefined) {
              where.branch_id = { [Op.in]: allowedBranches };
            } else {
              let requested = [];
              if (Array.isArray(where.branch_id)) {
                requested = where.branch_id;
              } else if (where.branch_id && typeof where.branch_id === 'object' && where.branch_id[Op.in]) {
                requested = where.branch_id[Op.in];
              } else {
                requested = [where.branch_id];
              }
              const intersected = requested.filter(id => allowedBranches.includes(Number(id)));
              where.branch_id = intersected.length > 0 ? { [Op.in]: intersected } : { [Op.in]: [-1] };
            }
          }
        }
      }
    }
    if ((enable_user_wise_data === "true" || enable_user_wise_data === true) && ctx.user_id && hasUserField) where.user_id = ctx.user_id;
  } else if (tenantConfig === false) {
    if (ctx.company_id && hasCompanyField) where.company_id = { [Op.or]: [-1, ctx.company_id] };
    if ((enable_branch_wise_data === "true" || enable_branch_wise_data === true) && ctx.branch_id && hasBranchField) where.branch_id = { [Op.or]: [-1, ctx.branch_id] };
    if ((enable_user_wise_data === "true" || enable_user_wise_data === true) && ctx.user_id && hasUserField) where.user_id = { [Op.or]: [-1, ctx.user_id] };
  } else if (isObj && !isEmptyObj) {
    // --- EXPLICIT TOGGLES ---
    if (tenantConfig.company_id && ctx.company_id && hasCompanyField) {
      if (where.company_id === undefined) {
        where.company_id = ctx.company_id;
      } else if (!ctx.is_super_admin) {
        let requested = [];
        if (Array.isArray(where.company_id)) {
          requested = where.company_id;
        } else if (where.company_id && typeof where.company_id === 'object' && where.company_id[Op.in]) {
          requested = where.company_id[Op.in];
        } else {
          requested = [where.company_id];
        }
        const intersected = requested.filter(id => Number(id) === Number(ctx.company_id));
        where.company_id = intersected.length > 0 ? { [Op.in]: intersected } : ctx.company_id;
      }
    }
    if (tenantConfig.branch_id && hasBranchField) {
      if (ctx.branch_id && ctx.branch_id !== 0 && ctx.branch_id !== "0") {
        if (where.branch_id === undefined) {
          where.branch_id = ctx.branch_id;
        } else {
          where.branch_id = ctx.branch_id;
        }
      } else if (!ctx.is_super_admin && ctx.branch_access) {
        let allowedBranches = [];
        if (typeof ctx.branch_access === 'string') {
          allowedBranches = ctx.branch_access.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        } else if (Array.isArray(ctx.branch_access)) {
          allowedBranches = ctx.branch_access.map(id => parseInt(id)).filter(id => !isNaN(id));
        }
        if (allowedBranches.length > 0) {
          if (where.branch_id === undefined) {
            where.branch_id = { [Op.in]: allowedBranches };
          } else {
            let requested = [];
            if (Array.isArray(where.branch_id)) {
              requested = where.branch_id;
            } else if (where.branch_id && typeof where.branch_id === 'object' && where.branch_id[Op.in]) {
              requested = where.branch_id[Op.in];
            } else {
              requested = [where.branch_id];
            }
            const intersected = requested.filter(id => allowedBranches.includes(Number(id)));
            where.branch_id = intersected.length > 0 ? { [Op.in]: intersected } : { [Op.in]: [-1] };
          }
        }
      }
    }
  }

  // 🔒 Hierarchy Data Visibility Filter: Restriction for Attendance Supervisors and Reporting Managers
  const applyHierarchy = typeof tenantConfig === "object" && tenantConfig !== null && tenantConfig.applyHierarchy === true;
  if (applyHierarchy && !ctx.is_super_admin && !ctx.is_admin) {
    const isSupervisor = ctx.is_attendance_supervisor === true;
    const isManager = ctx.is_reporting_manager === true;
    console.log(`Hierarchy Filter Applied - Supervisor: ${isSupervisor}, Manager: ${isManager}, User ID: ${ctx.user_id}`);
    if (isSupervisor || isManager) {
      const modelName = model?.name;
      
      // Define hierarchy conditions
      const hierarchyConditions = [];
      if (isSupervisor) hierarchyConditions.push({ attendance_supervisor: ctx.user_id });
      if (isManager) hierarchyConditions.push({ reporting_manager: ctx.user_id });
      const hierarchyWhere = hierarchyConditions.length > 1 ? { [Op.or]: hierarchyConditions } : hierarchyConditions[0]; 
      console.log("Hierarchy Where Clause:", JSON.stringify(hierarchyWhere));
      if (modelName === "Employee") {
        // Restrict Employee table directly
        if (where[Op.and]) {
          where[Op.and].push(hierarchyWhere);
        } else {
          where[Op.and] = [hierarchyWhere];
        }
      } else if (modelName !== "User" && model.rawAttributes && model.rawAttributes.employee_id) {
        // For records referencing Employee, restrict by employee_id subquery/Op.in
        const employeeSubquery = {
          modelName: "Employee",
          where: hierarchyWhere
        };
        
        // Construct the Op.in clause to limit employee_id
        const restrictedEmployeeIdsCondition = sequelize.literal(
          `("${modelName}"."employee_id" IN (SELECT id FROM employees WHERE status != 2 AND (${
            [
              isSupervisor ? `attendance_supervisor = ${ctx.user_id}` : null,
              isManager ? `reporting_manager = ${ctx.user_id}` : null
            ].filter(Boolean).join(" OR ")
          })))`
        );

        if (where[Op.and]) {
          where[Op.and].push(restrictedEmployeeIdsCondition);
        } else {
          where[Op.and] = [restrictedEmployeeIdsCondition];
        }
      }
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

      if (newWhere.status === undefined && inc.model && inc.model.rawAttributes && inc.model.rawAttributes.status) {
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

// Normalizes order clause to handle dotted notation like [['state.state_name', 'ASC']]
function normalizeOrder(order) {
    if (!order || !Array.isArray(order)) return order;

    return order.map(item => {
        if (!Array.isArray(item)) return item;
        
        let [col, dir] = item;
        // If col is a string and contains a dot, split it
        // Example: ['state.state_name', 'ASC'] -> ['state', 'state_name', 'ASC']
        if (typeof col === 'string' && col.includes('.')) {
            const parts = col.split('.');
            return [...parts, dir];
        }
        return item;
    });
}

/**
 * ------------------------------------------------------------------
 * CORE EXPORTS
 * ------------------------------------------------------------------
 */

module.exports = {
  // 1. Create Record
  createRecord: async (model, data, transaction = null, requireTenantFields=true, batch_id = null) => {
    const caller = captureCaller();
    let enrichedData = { ...data }
    let commonData = {
      user_id: data.user_id,
      company_id: data.company_id,
      branch_id: data.branch_id,
    };

    const isObj = typeof requireTenantFields === "object" && requireTenantFields !== null;
    const isEmptyObj = isObj && Object.keys(requireTenantFields).length === 0;

    let ctx = {};
    if (!isEmptyObj) {
      ctx = getContext();  
    }

    const hasCompanyField = !model || !model.rawAttributes || !!model.rawAttributes.company_id;
    const hasBranchField = !model || !model.rawAttributes || !!model.rawAttributes.branch_id;
    const hasUserField = !model || !model.rawAttributes || !!model.rawAttributes.user_id;

    if (requireTenantFields === true) {
      if (ctx.company_id && enrichedData.company_id === undefined && hasCompanyField) { enrichedData.company_id = ctx.company_id; commonData.company_id = ctx.company_id; }
      if (ctx.user_id && enrichedData.user_id === undefined && hasUserField) { enrichedData.user_id = ctx.user_id; commonData.user_id = ctx.user_id; }
      if (ctx.branch_id && enrichedData.branch_id === undefined && hasBranchField) { enrichedData.branch_id = ctx.branch_id; commonData.branch_id = ctx.branch_id; }
    } else if (isObj && !isEmptyObj) {
      if (requireTenantFields.company_id && ctx.company_id && enrichedData.company_id === undefined && hasCompanyField) { enrichedData.company_id = ctx.company_id; commonData.company_id = ctx.company_id; }
      if (requireTenantFields.user_id && ctx.user_id && enrichedData.user_id === undefined && hasUserField) { enrichedData.user_id = ctx.user_id; commonData.user_id = ctx.user_id; }
      if (requireTenantFields.branch_id && ctx.branch_id && enrichedData.branch_id === undefined && hasBranchField) { enrichedData.branch_id = ctx.branch_id; commonData.branch_id = ctx.branch_id; }
    }

    const capture = {};
    const result = await model.create(enrichedData, withDebug({ __caller: caller }, transaction, capture));

    try {
      await logQuery({
        action_type: "CREATE",
        entity_name: model.name,
        record_id: result.id,
        new_data: result.toJSON ? result.toJSON() : result,
        sql_query: capture.sql,
        access_type: ctx.access,
        caller: caller,
        ...commonData,
        ip_address: ctx ? ctx.ip : null,
        batch_id: batch_id || data.batch_id
      }, transaction);

    } catch (logErr) {
      console.error("Audit log failed:", logErr.message);
    }

    return result;
  },

  // 2. Bulk Create
  bulkCreate: async (Model, dataArray, extraFields, transaction = null, requireTenantFields=true, batch_id = null) => {
    const caller = captureCaller();
    if (!Array.isArray(dataArray) || !dataArray.length) return [];
    let enriched = dataArray.map((item) => ({ ...item, ...extraFields }));
    let commonData = {
      user_id: extraFields.user_id,
      company_id: extraFields.company_id,
      branch_id: extraFields.branch_id,
    };
    const isObj = typeof requireTenantFields === "object" && requireTenantFields !== null;
    const isEmptyObj = isObj && Object.keys(requireTenantFields).length === 0;

    let ctx = {};
    if (!isEmptyObj) {
      ctx = getContext();  
    }

    let attachCompany = false, attachUser = false, attachBranch = false;
    
    const hasCompanyField = !Model || !Model.rawAttributes || !!Model.rawAttributes.company_id;
    const hasBranchField = !Model || !Model.rawAttributes || !!Model.rawAttributes.branch_id;
    const hasUserField = !Model || !Model.rawAttributes || !!Model.rawAttributes.user_id;

    if (requireTenantFields === true) {
      attachCompany = !!ctx.company_id && hasCompanyField;
      attachUser = !!ctx.user_id && hasUserField;
      attachBranch = !!ctx.branch_id && hasBranchField;
    } else if (isObj && !isEmptyObj) {
      attachCompany = !!(requireTenantFields.company_id && ctx.company_id) && hasCompanyField;
      attachUser = !!(requireTenantFields.user_id && ctx.user_id) && hasUserField;
      attachBranch = !!(requireTenantFields.branch_id && ctx.branch_id) && hasBranchField;
    }

    if (attachCompany || attachUser || attachBranch) {
      enriched = dataArray.map((item) => {
        let newItem = { ...item, ...extraFields };
        // 🚀 ONLY INJECT IF UNDEFINED
        if (attachCompany && newItem.company_id === undefined) newItem.company_id = ctx.company_id;
        if (attachUser && newItem.user_id === undefined) newItem.user_id = ctx.user_id;
        if (attachBranch && newItem.branch_id === undefined) newItem.branch_id = ctx.branch_id;
        return newItem;
      });

      if (attachCompany && commonData.company_id === undefined) commonData.company_id = ctx.company_id;
      if (attachUser && commonData.user_id === undefined) commonData.user_id = ctx.user_id;
      if (attachBranch && commonData.branch_id === undefined) commonData.branch_id = ctx.branch_id;
    }

    const capture = {};
    const createdRecords = await Model.bulkCreate(enriched, withDebug({ __caller: caller }, transaction, capture));

    if (createdRecords.length) {
      try {
        for (const record of createdRecords) {
          await logQuery({
            action_type: "BULK CREATE",
            entity_name: Model.name,
            record_id: record.id,
            sql_query: capture.sql,
            access_type: ctx.access,
            caller: caller,
            ...commonData,
            ip_address: ctx ? ctx.ip : null,
            batch_id: batch_id || extraFields.batch_id
          }, transaction);
        }

      } catch (logErr) {
        console.error("Audit log failed:", logErr.message);
      }
    }

    return createdRecords;
  },

  // 3. Update Record
  updateRecordById: async (model, whereInput, data, transaction = null, forceReload = false, requireTenantFields=true, batch_id = null) => {
    const caller = captureCaller();
    if (!whereInput || !model || !data) throw new Error("Invalid params for update");
    let condition = await buildWhere(whereInput, resolveTenantConfig(requireTenantFields, false), false, model); 
    
    let safeData = { ...data };
    let commonData = {
      user_id: data.user_id,
      company_id: data.company_id,
      branch_id: data.branch_id,
    };
    
    const isObj = typeof requireTenantFields === "object" && requireTenantFields !== null;
    const isEmptyObj = isObj && Object.keys(requireTenantFields).length === 0;

    let ctx = {};
    if (!isEmptyObj) {
      ctx = getContext();  
    }

    const hasCompanyField = !model || !model.rawAttributes || !!model.rawAttributes.company_id;
    const hasBranchField = !model || !model.rawAttributes || !!model.rawAttributes.branch_id;
    const hasUserField = !model || !model.rawAttributes || !!model.rawAttributes.user_id;

    if (requireTenantFields === true) {
      if (ctx.company_id && safeData.company_id === undefined && hasCompanyField) { safeData.company_id = ctx.company_id; commonData.company_id = ctx.company_id; }
      if (ctx.user_id && safeData.user_id === undefined && hasUserField) { safeData.user_id = ctx.user_id; commonData.user_id = ctx.user_id; }
      if (ctx.branch_id && safeData.branch_id === undefined && hasBranchField) { safeData.branch_id = ctx.branch_id; commonData.branch_id = ctx.branch_id; }
    } else if (isObj && !isEmptyObj) {
      if (requireTenantFields.company_id && ctx.company_id && safeData.company_id === undefined && hasCompanyField) { safeData.company_id = ctx.company_id; commonData.company_id = ctx.company_id; }
      if (requireTenantFields.user_id && ctx.user_id && safeData.user_id === undefined && hasUserField) { safeData.user_id = ctx.user_id; commonData.user_id = ctx.user_id; }
      if (requireTenantFields.branch_id && ctx.branch_id && safeData.branch_id === undefined && hasBranchField) { safeData.branch_id = ctx.branch_id; commonData.branch_id = ctx.branch_id; }
    }

    let oldRecord = null;
    try {
      oldRecord = await model.findOne({ where: condition, transaction, raw: true });
    } catch (e) {}
    if (!oldRecord) return null;
    const capture = {};
    const [count] = await model.update(
      safeData,
      withDebug({ where: condition, __caller: caller }, transaction, capture)
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
        sql_query: capture.sql,
        access_type: ctx.access,
        caller: caller,
        ...commonData,
        ip_address: ctx ? ctx.ip : null,
        batch_id: batch_id || data.batch_id
      }, transaction);

    } catch (logErr) {
      console.error(`[commonQuery] Log failed for ${model.name} (Non-fatal):`, logErr.message);
    }

    return newRecord;
  },

  // 4. Soft Delete
  softDeleteById: async (model, whereInput, transaction = null, requireTenantFields=true, batch_id = null) => {
    const caller = captureCaller();
    const isObj = typeof requireTenantFields === "object" && requireTenantFields !== null;
    const isEmptyObj = isObj && Object.keys(requireTenantFields).length === 0;

    let ctx = {};
    if (!isEmptyObj) {
      ctx = getContext();  
    }
    const condition = await buildWhere(whereInput, resolveTenantConfig(requireTenantFields, false), false, model);

    const recordsToDelete = await model.findAll({
      where: condition,
      transaction,
      raw: true
    });

    if (!recordsToDelete.length) return 0;

    const hasUserField = !model || !model.rawAttributes || !!model.rawAttributes.user_id;
    const updateData = { status: 2 };
    if (hasUserField) {
      updateData.user_id = ctx.user_id || 0;
    }

    const capture = {};
    const [count] = await model.update(
      updateData,
      withDebug({ where: { id: { [Op.in]: recordsToDelete.map(r => r.id) } } }, transaction, capture)
    );

    try {
      for (const record of recordsToDelete) {
        await logQuery({
          action_type: "DELETE",
          entity_name: model.name,
          record_id: record.id,
          old_data: record,
          sql_query: capture.sql,
          access_type: ctx.access,
          caller: caller,
          user_id: ctx.user_id,
          company_id: ctx.company_id,
          branch_id: ctx.branch_id,
          ip_address: ctx.ip,
          batch_id: batch_id
        }, transaction);
      }

    } catch (logErr) {
      console.error("Audit log failed:", logErr.message);
    }

    return count;
  },

  // 5. Find All
  findAllRecords: async (model, filters = {}, options = {}, transaction = null, requireTenantFields = true) => {
    const caller = captureCaller();
    const safeOptions = options || {};
    const where = await buildWhere(filters, resolveTenantConfig(requireTenantFields, true), !!safeOptions.skipStatus, model);

    const attributesOption = buildAttributes(safeOptions);
    const includeOption = safeOptions.include ? await normalizeInclude(safeOptions.include) : [];

    const queryOptions = withDebug({
      __caller: caller,
      where,
      ...attributesOption,
      ...(safeOptions.skip ? { offset: safeOptions.skip } : {}),
      ...(safeOptions.limit ? { limit: safeOptions.limit } : {}),
      ...(safeOptions.order ? { order: normalizeOrder(safeOptions.order) } : {}),
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
    const caller = captureCaller();
    const safeOptions = options || {};
    const where = await buildWhere(filters, resolveTenantConfig(requireTenantFields, false), !!safeOptions.skipStatus, model);
    
    const includeOption = safeOptions.include ? await normalizeInclude(safeOptions.include) : [];

    const result = await model.count(withDebug({
      __caller: caller,
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
    const caller = captureCaller();
    const safeOptions = options || {};
    const condition = await buildWhere(whereInput, resolveTenantConfig(requireTenantFields, false), !!safeOptions.skipStatus, model);
    
    const attributesOption = buildAttributes(safeOptions);
    const includeOption = safeOptions.include ? await normalizeInclude(safeOptions.include) : [];

    const result = await model.findOne(withDebug({
      __caller: caller,
      where: condition,
      ...attributesOption,
      ...(safeOptions.order ? { order: normalizeOrder(safeOptions.order) } : {}),
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
    const caller = captureCaller();
    const ctx = getContext();
    const condition = await buildWhere(whereInput, resolveTenantConfig(requireTenantFields, false), false, model);

    // Fetch records before deletion to preserve data for audit log
    const recordsToDelete = await model.findAll({
      where: condition,
      transaction,
      raw: true
    });

    if (!recordsToDelete.length) return 0;

    const capture = {};
    const count = await model.destroy(withDebug({ where: condition, __caller: caller }, transaction, capture));

    try {
      for (const record of recordsToDelete) {
        await logQuery({
          action_type: "DELETE",
          entity_name: model.name,
          record_id: record.id,
          old_data: record,
          sql_query: capture.sql,
          access_type: ctx.access,
          caller: caller,
          user_id: ctx.user_id,
          company_id: ctx.company_id,
          branch_id: ctx.branch_id,
          ip_address: ctx.ip,
        }, transaction);
      }
    } catch (logErr) {
      console.error(`Audit log failed for hardDeleteRecords in ${model.name}:`, logErr.message);
    }

    return count;
  },

  // 9. Aggregates
  sumRecords: async (model, field, filters = {}, transaction = null) => {
    const caller = captureCaller();
    const where = await buildWhere(filters, true, false, model);
    const total = await model.sum(field, withDebug({ where, __caller: caller }, transaction));
    return total || 0;
  },

  incrementRecords: async (model, field, by = 1, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true, false, model);
    return model.increment(field, { by, where, transaction });
  },

  decrementRecords: async (model, field, by = 1, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true, false, model);
    return model.decrement(field, { by, where, transaction });
  },

  minRecords: async (model, field, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true, false, model);
    return model.min(field, { where, transaction });
  },

  maxRecords: async (model, field, whereInput = {}, transaction = null) => {
    const where = await buildWhere(whereInput, true, false, model);
    return model.max(field, { where, transaction });
  },

    // 10. ADVANCED PAGINATION
async fetchPaginatedData(model, reqBody, fieldConfig, options = {}, requireTenantFields = true, dateField = "createdAt", customWhere = {}) {
    const resolvedTenant = resolveTenantConfig(requireTenantFields, true);
    if (model.name === 'Employee' && options.attributes && Array.isArray(options.attributes)) {
        if (!options.attributes.includes('company_id')) options.attributes.push('company_id');
        if (!options.attributes.includes('branch_id')) options.attributes.push('branch_id');
    }
    const caller = captureCaller();
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

      // A. Status (skip entirely if `include` object is provided)
      if (!reqBody?.include) {
        if (reqBody?.status !== undefined && reqBody?.status !== "All") {
          if (Array.isArray(reqBody?.status) && reqBody?.status.length > 0) {
            filters.status = { [Op.in]: reqBody?.status };
          } else {
            const s = reqBody?.status;
            if (["Active", "0", 0].includes(s)) filters.status = 0;
            else if (["Deactive", "1", 1].includes(s)) filters.status = 1;
            else filters.status = s;
          }
        } else if (reqBody?.status === "All") {
          // Optional: explicitly allow all statuses if needed, usually we just don't filter
          delete filters.status;
        }
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
      if (reqBody?.branch_id !== undefined && reqBody?.branch_id !== null && reqBody?.branch_id !== "") {
        if (reqBody.branch_id !== "All" && reqBody.branch_id !== "all" && reqBody.branch_id !== 0 && reqBody.branch_id !== "0") {
          filters.branch_id = reqBody.branch_id;
        }
      }
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

      const normalizedSearch = reqBody?.search ? String(reqBody.search).replace(/[\u202f\u00a0]/g, " ").trim() : "";

      if (normalizedSearch && searchFields.length > 0) {
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
            
            let dbCol;
            
            // 1. Check if the key exists directly in attributeMap (handled aliases)
            if (attributeMap.has(config.key)) {
                const mapped = attributeMap.get(config.key);
                dbCol = (typeof mapped === 'string' && !mapped.includes('.'))
                        ? `${model.name}.${mapped}`
                        : mapped;
            } 
            // 2. Handle dotted notation
            else if (typeof config.key === 'string' && config.key.includes('.')) {
                const parts = config.key.split('.');
                const prefix = parts[0].toLowerCase();
                const field = parts.slice(1).join('.');
                
                // If prefix refers to the main model (e.g. "user.email" -> "User.email")
                if (prefix === 'user' || prefix === model.name.toLowerCase()) {
                    const mapped = attributeMap.get(field);
                    // Force prefix even if found in attributeMap (if the mapping is simple)
                    dbCol = (mapped && typeof mapped === 'string' && mapped.includes('.')) 
                            ? mapped 
                            : `${model.name}.${field}`;
                } 
                // If the suffix exists in attributeMap (common for aliases like employee_code)
                else if (attributeMap.has(field)) {
                    dbCol = attributeMap.get(field);
                }
                // Dotted notation for associations
                else {
                    const associations = options.include || [];
                    const match = associations.find(inc => inc.as?.toLowerCase() === prefix);
                    if (match) {
                        dbCol = `${match.as}.${field}`;
                    } else {
                        dbCol = config.key; // Fallback
                    }
                }
            } 
            // 3. Simple field name - prefix with main model name to prevent ambiguity
            else {
                dbCol = `${model.name}.${config.key}`;
            }
            
            const likeVal = `%${normalizedSearch}%`;
            if (typeof dbCol === 'string') {
                const finalKey = dbCol.includes('.') && !dbCol.startsWith('$') ? `$${dbCol}$` : dbCol;
                const colName = finalKey.replace(/\$/g, '');
                
                // 🚀 Advanced Date Search: Use 'FM' (Fill Mode) to support non-padded dates like 4/21 (instead of 04/21)
                if (colName.includes('created_at') || colName.includes('updated_at') || colName.includes('_date')) {
                    const formats = [
                        'FMDD-FMMM-YYYY, FMHH12:MI:SS AM', 
                        'FMDD/FMMM/YYYY, FMHH12:MI:SS AM', 
                        'FMMM/FMDD/YYYY, FMHH12:MI:SS AM',
                        'MM/DD/YYYY, HH12:MI:SS AM',
                        'YYYY-MM-DD HH24:MI:SS'
                    ];
                    // Convert timezone to Asia/Kolkata first since the UI displays in local (IST) time
                    const tzCol = sequelize.fn('timezone', 'Asia/Kolkata', sequelize.col(colName));
                    return {
                        [Op.or]: formats.map(fmt => 
                            sequelize.where(sequelize.fn('to_char', tzCol, fmt), { [Op.iLike]: likeVal })
                        )
                    };
                }

                return sequelize.where(
                    sequelize.cast(sequelize.col(colName), 'TEXT'),
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
      let order = options.order || [[dateField, 'DESC']];
      if (reqBody?.sortBy && sortableFields.includes(reqBody?.sortBy)) {
        const sortKey = reqBody.sortBy;
        if (sortKey.includes('.')) {
            const parts = sortKey.split('.');
            order = [[...parts, reqBody.sortDirection === "descending" ? "DESC" : "ASC"]];
        } else {
            order = [[sortKey, reqBody.sortDirection === "descending" ? "DESC" : "ASC"]];
        }
      }

      // Execution
      let data = await module.exports.findAllRecords(
        model,
        filters, 
        { ...options, skip, limit, order, subQuery: false, __caller: caller, skipStatus: !!options.skipStatus },
        null,
        resolvedTenant
      );

      // 👇 AUTO-INJECT BRANCH NAME (if branch_id=0 and model has branch_id field)
      const context = getContext();
      if (context.branch_id === 0 && Array.isArray(data) && data.length > 0 && model.rawAttributes.branch_id) {
          try {
              const branchIds = [...new Set(data.map(item => (item.get ? item.get('branch_id') : item.branch_id)).filter(id => id !== null && id !== undefined && Number(id) > 0))];
              let branchMap = {};
              if (branchIds.length > 0) {
                  const branches = await sequelize.models.BranchMaster.findAll({
                      where: { id: { [Op.in]: branchIds } },
                      attributes: ['id', 'branch_name'],
                      raw: true
                  });
                  branchMap = Object.fromEntries(branches.map(b => [b.id, b.branch_name]));
              }
              data = data.map(item => {
                  const itemJson = item.get ? item.get({ plain: true }) : item;
                  return {
                      ...itemJson,
                      branch_name: branchMap[itemJson.branch_id] || "N/A"
                  };
              });
          } catch (err) {
              console.error("Auto branch_name enrichment failed:", err.message);
          }
      }

      // Sticky Includes (Logic preserved)
      if (reqBody?.include && typeof reqBody?.include === "object") {
        const includeConditions = [];
        for (const [key, value] of Object.entries(reqBody?.include)) {
            if (Array.isArray(value) && value.length > 0) includeConditions.push({ [key]: { [Op.in]: value } });
            else if (value) includeConditions.push({ [key]: value });
        }
        if (includeConditions.length > 0) {
            // we intentionally bypass default status filtering for include logic
            const stickyWhere = await buildWhere({ [Op.or]: includeConditions }, resolvedTenant, true, model);
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
      const totalCount = await module.exports.countRecords(model, filters, { ...countOptions, skipStatus: !!options.skipStatus }, resolvedTenant);

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
};