const { sequelize } = require("../models");
const Op = require("sequelize").Op;
const { getContext } = require("../utils/requestContext");
const { logQuery } = require("./functions/logFunctions");

// Helper to capture the caller file/line for audit logging
function captureCaller() {
  const err = new Error();
  const stack = err.stack ? err.stack.split("\n") : [];
  for (let i = 2; i < stack.length; i++) {
    const line = stack[i];
    if (line.includes("node_modules") || line.includes("node:internal")) continue;
    const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) || line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (match) {
      const file = match[2] || match[1];
      const ln = match[3] || match[2];
      const fn = match[1] && !match[2] ? "anonymous" : match[1];
      return `${file.split(/[\\/]/).pop()}:${ln} (${fn})`;
    }
  }
  return "unknown";
}

// Helper to inject SQL query into debug logs
function withDebug(options, transaction, capture = {}) {
  const opt = { ...options };
  if (transaction) opt.transaction = transaction;
  
  opt.logging = (sql) => {
    capture.sql = sql;
  };
  return opt;
}

// Bypassed buildWhere for admin panel query
function buildWhere(whereInput, skipStatus = false, model = null) {
  let where = {};
  if (Array.isArray(whereInput)) {
    where = { id: { [Op.in]: whereInput } };
  } else if (typeof whereInput === "string" || typeof whereInput === "number") {
    where = { id: whereInput };
  } else if (typeof whereInput === "object" && whereInput !== null) {
    where = { ...whereInput };
  }

  // Apply Status Filter (exclude soft-deleted records by default)
  if (!skipStatus && model && model.rawAttributes && !model.rawAttributes.status) {
    skipStatus = true;
  }
  if (!skipStatus) {
    if (where.status === undefined) {
      where.status = { [Op.ne]: 2 };
    }
  }
  return where;
}

// Normalize attributes mapping
function buildAttributes(options) {
  if (!options) return {};
  const opt = {};
  if (options.attributes) opt.attributes = options.attributes;
  if (options.exclude) opt.exclude = options.exclude;
  return opt;
}

// Normalize sorting
function normalizeOrder(order) {
  if (!order) return undefined;
  if (Array.isArray(order)) return order;
  if (typeof order === "string") {
    return order.split(",").map(part => {
      const [col, dir] = part.trim().split(/\s+/);
      return [col, dir || "ASC"];
    });
  }
  return undefined;
}

// Normalize includes
async function normalizeInclude(include) {
  if (!include) return [];
  if (Array.isArray(include)) return include;
  return [include];
}

module.exports = {
  // 1. Create Record
  createRecord: async (model, data, transaction = null, requireTenantFields = false, batch_id = null) => {
    const caller = captureCaller();
    const ctx = getContext();

    const record = await model.create(
      data,
      withDebug({}, transaction)
    );

    try {
      await logQuery({
        action_type: "CREATE",
        entity_name: model.name,
        record_id: record.id,
        new_data: record.toJSON(),
        access_type: ctx.access,
        caller: caller,
        user_id: ctx.user_id || 0,
        company_id: ctx.company_id || 0,
        branch_id: ctx.branch_id || 0,
        ip_address: ctx.ip,
        batch_id: batch_id || data.batch_id
      }, transaction);
    } catch (logErr) {
      console.error(`[adminCommonQuery] Log failed for createRecord in ${model.name}:`, logErr.message);
    }

    return record;
  },

  // 2. Bulk Create
  bulkCreate: async (model, dataArray, extraFields = {}, transaction = null, requireTenantFields = false, batch_id = null) => {
    const caller = captureCaller();
    const ctx = getContext();

    if (!Array.isArray(dataArray) || dataArray.length === 0) return [];

    const preparedData = dataArray.map(item => ({
      ...item,
      ...extraFields
    }));

    const records = await model.bulkCreate(
      preparedData,
      withDebug({}, transaction)
    );

    try {
      for (const record of records) {
        await logQuery({
          action_type: "CREATE",
          entity_name: model.name,
          record_id: record.id,
          new_data: record.toJSON(),
          access_type: ctx.access,
          caller: caller,
          user_id: ctx.user_id || 0,
          company_id: ctx.company_id || 0,
          branch_id: ctx.branch_id || 0,
          ip_address: ctx.ip,
          batch_id: batch_id || extraFields.batch_id
        }, transaction);
      }
    } catch (logErr) {
      console.error(`[adminCommonQuery] Log failed for bulkCreate in ${model.name}:`, logErr.message);
    }

    return records;
  },

  // 3. Update Record By ID
  updateRecordById: async (model, whereInput, data, transaction = null, forceReload = false, requireTenantFields = false, batch_id = null) => {
    const caller = captureCaller();
    const ctx = getContext();
    const condition = buildWhere(whereInput, false, model);

    let oldRecord = null;
    try {
      oldRecord = await model.findOne({ where: condition, transaction, raw: true });
    } catch (e) {}
    if (!oldRecord) return null;

    const capture = {};
    const [count] = await model.update(
      data,
      withDebug({ where: condition }, transaction, capture)
    );

    if (count === 0) return null;

    const newRecord = await model.findOne({ where: condition, transaction });
    if (newRecord && forceReload) await newRecord.reload({ transaction });

    try {
      const isStatusChange = Object.keys(data).length === 1 && data.status !== undefined;
      await logQuery({
        action_type: isStatusChange ? "STATUS_CHANGE" : "UPDATE",
        entity_name: model.name,
        record_id: newRecord.id,
        old_data: oldRecord,
        new_data: newRecord.toJSON(),
        sql_query: capture.sql,
        access_type: ctx.access,
        caller: caller,
        user_id: ctx.user_id || 0,
        company_id: ctx.company_id || 0,
        branch_id: ctx.branch_id || 0,
        ip_address: ctx.ip,
        batch_id: batch_id || data.batch_id
      }, transaction);
    } catch (logErr) {
      console.error(`[adminCommonQuery] Log failed for updateRecordById in ${model.name}:`, logErr.message);
    }

    return newRecord;
  },

  // 4. Soft Delete
  softDeleteById: async (model, whereInput, transaction = null, requireTenantFields = false, batch_id = null) => {
    const caller = captureCaller();
    const ctx = getContext();
    const condition = buildWhere(whereInput, false, model);

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
          user_id: ctx.user_id || 0,
          company_id: ctx.company_id || 0,
          branch_id: ctx.branch_id || 0,
          ip_address: ctx.ip,
          batch_id: batch_id
        }, transaction);
      }
    } catch (logErr) {
      console.error(`[adminCommonQuery] Audit log failed:`, logErr.message);
    }

    return count;
  },

  // 5. Find All Records
  findAllRecords: async (model, filters = {}, options = {}, transaction = null, requireTenantFields = false) => {
    const caller = captureCaller();
    const safeOptions = options || {};
    const where = buildWhere(filters, !!safeOptions.skipStatus, model);

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

  // 6. Count Records
  countRecords: async (model, filters = {}, options = {}, requireTenantFields = false) => {
    const caller = captureCaller();
    const safeOptions = options || {};
    const where = buildWhere(filters, !!safeOptions.skipStatus, model);
    
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

  // 7. Find One Record
  findOneRecord: async (model, whereInput = {}, options = {}, transaction = null, forceReload = false, requireTenantFields = false) => {
    const caller = captureCaller();
    const safeOptions = options || {};
    const condition = buildWhere(whereInput, !!safeOptions.skipStatus, model);
    
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

  // 8. Hard Delete Records
  hardDeleteRecords: async (model, whereInput = {}, transaction = null, requireTenantFields = false) => {
    const caller = captureCaller();
    const ctx = getContext();
    const condition = buildWhere(whereInput, false, model);

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
          user_id: ctx.user_id || 0,
          company_id: ctx.company_id || 0,
          branch_id: ctx.branch_id || 0,
          ip_address: ctx.ip,
        }, transaction);
      }
    } catch (logErr) {
      console.error(`[adminCommonQuery] Hard delete audit log failed:`, logErr.message);
    }

    return count;
  },

  // 9. Advanced Pagination for Master Admin Panel (always bypasses tenant and injects names)
  fetchPaginatedData: async function(model, reqBody, fieldConfig, options = {}, requireTenantFields = false, dateField = "createdAt", customWhere = {}) {
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
        }
      }

      if (reqBody?.filter && typeof reqBody?.filter === "object") {
        for (const [k, v] of Object.entries(reqBody?.filter)) {
          if (Array.isArray(v) && v.length > 0) {
            filters[k] = { [Op.in]: v };
          } else if (v !== undefined && v !== null && v !== "") {
            filters[k] = v;
          }
        }
      }

      // Explicit Tenant overrides passed in the request body
      if (reqBody?.company_id) filters.company_id = reqBody?.company_id;
      if (reqBody?.user_id) filters.user_id = reqBody?.user_id;

      if (reqBody?.startDate || reqBody?.endDate) {
        const dateFilter = {};
        if (reqBody?.startDate) dateFilter[Op.gte] = new Date(reqBody?.startDate);
        if (reqBody?.endDate) dateFilter[Op.lte] = new Date(reqBody?.endDate);
        if (Object.keys(dateFilter).length > 0) filters[dateField] = dateFilter;
      }

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
          
          let dbCol;
          if (attributeMap.has(config.key)) {
            dbCol = attributeMap.get(config.key);
          } else if (typeof config.key === 'string' && config.key.includes('.')) {
            const parts = config.key.split('.');
            const prefix = parts[0].toLowerCase();
            const field = parts.slice(1).join('.');
            if (prefix === 'user' || prefix === model.name.toLowerCase()) {
              const mapped = attributeMap.get(field);
              dbCol = (mapped && typeof mapped === 'string' && mapped.includes('.')) ? mapped : `${model.name}.${field}`;
            } else if (attributeMap.has(field)) {
              dbCol = attributeMap.get(field);
            } else {
              const associations = options.include || [];
              const match = associations.find(inc => inc.as?.toLowerCase() === prefix);
              dbCol = match ? `${match.as}.${field}` : config.key;
            }
          } else {
            dbCol = `${model.name}.${config.key}`;
          }
          
          const likeVal = `%${reqBody?.search}%`;
          if (typeof dbCol === 'string') {
            const finalKey = dbCol.includes('.') && !dbCol.startsWith('$') ? `$${dbCol}$` : dbCol;
            const colName = finalKey.replace(/\$/g, '');
            if (colName.includes('created_at') || colName.includes('updated_at') || colName.includes('_date')) {
              const formats = [
                'FMDD-FMMM-YYYY, FMHH12:MI:SS AM', 
                'FMDD/FMMM/YYYY, FMHH12:MI:SS AM', 
                'FMMM/FMDD/YYYY, FMHH12:MI:SS AM',
                'MM/DD/YYYY, HH12:MI:SS AM',
                'YYYY-MM-DD HH24:MI:SS'
              ];
              return {
                [Op.or]: formats.map(fmt => 
                  sequelize.where(sequelize.fn('to_char', sequelize.col(colName), fmt), { [Op.iLike]: likeVal })
                )
              };
            }
            return sequelize.where(sequelize.cast(sequelize.col(colName), 'TEXT'), { [Op.iLike]: likeVal });
          } else {
            return sequelize.where(dbCol, { [Op.iLike]: likeVal });
          }
        }).filter(Boolean);

        if (orConditions.length > 0) filters[Op.or] = orConditions;
      }

      if (customWhere && (Object.keys(customWhere).length > 0 || Object.getOwnPropertySymbols(customWhere).length > 0)) {
        if (filters[Op.or] && customWhere[Op.or]) {
          filters = {
            [Op.and]: [
              { [Op.or]: filters[Op.or] },
              { [Op.or]: customWhere[Op.or] }
            ],
            ...filters,
            ...customWhere
          };
          delete filters[Op.or];
          delete customWhere[Op.or];
        } else {
          filters = { ...filters, ...customWhere };
          const symbols = Object.getOwnPropertySymbols(customWhere);
          for (const sym of symbols) {
            filters[sym] = customWhere[sym];
          }
        }
      }

      const sortableFields = standardizedConfig.filter(f => f.sortable).map(f => f.key);
      let order = options?.order || [[dateField, 'DESC']];
      if (reqBody?.sortBy && sortableFields.includes(reqBody?.sortBy)) {
        const sortKey = reqBody.sortBy;
        if (sortKey.includes('.')) {
          const parts = sortKey.split('.');
          order = [[...parts, reqBody.sortDirection === "descending" ? "DESC" : "ASC"]];
        } else {
          order = [[sortKey, reqBody.sortDirection === "descending" ? "DESC" : "ASC"]];
        }
      }

      let data = await module.exports.findAllRecords(
        model,
        filters, 
        { ...options, skip, limit, order, subQuery: false, __caller: caller, skipStatus: !!options?.skipStatus },
        null,
        false
      );

      // Auto-inject company & branch names for Master Admin viewing
      if (Array.isArray(data) && data.length > 0) {
        try {
          if (model.rawAttributes.company_id) {
            const companyIds = [...new Set(data.map(item => (item.get ? item.get('company_id') : item.company_id)).filter(id => id !== null && id !== undefined && Number(id) > 0))];
            let companyMap = {};
            if (companyIds.length > 0) {
              const companies = await sequelize.models.CompanyMaster.findAll({
                where: { id: { [Op.in]: companyIds } },
                attributes: ['id', 'company_name'],
                raw: true
              });
              companyMap = Object.fromEntries(companies.map(c => [c.id, c.company_name]));
            }
            data = data.map(item => {
              const itemJson = item.get ? item.get({ plain: true }) : item;
              return {
                ...itemJson,
                company_name: companyMap[itemJson.company_id] || "N/A"
              };
            });
          }
          if (model.rawAttributes.branch_id) {
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
          }
        } catch (err) {
          console.error("[adminCommonQuery] Enrichment failed:", err.message);
        }
      }

      // Sticky Includes
      if (reqBody?.include && typeof reqBody?.include === "object") {
        const includeConditions = [];
        for (const [key, value] of Object.entries(reqBody?.include)) {
          if (Array.isArray(value) && value.length > 0) includeConditions.push({ [key]: { [Op.in]: value } });
          else if (value) includeConditions.push({ [key]: value });
        }
        if (includeConditions.length > 0) {
          const stickyWhere = buildWhere({ [Op.or]: includeConditions }, true, model);
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
      const totalCount = await module.exports.countRecords(model, filters, { ...countOptions, skipStatus: !!options?.skipStatus }, false);

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

    } catch (error) {
      console.error(`[adminCommonQuery] Pagination failed:`, error);
      throw error;
    }
  }
};
