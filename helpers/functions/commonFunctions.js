const NodeCache = require("node-cache");
const { literal, Op } = require("sequelize");
const { SeriesTypeMaster, ItemMaster, Notification, ItemUnitMaster, CompanySettingsMaster, CompanyConfigration, CompanySubscription, CompanyMaster,  } = require("../../models");
const commonQuery = require("../commonQuery");
const { getCompanySetting, updateSubscriptionCache } = require("../cache");
const dayjs = require("dayjs"); 

exports.parseDate = (dateInput) => {
  if (!dateInput) {
    return null;
  }

  const parsedDate = dayjs(dateInput);

  if (!parsedDate.isValid()) {
    return null; // Return null if the date is invalid
  }

  // Check if the original input likely contained a time component.
  // This is a simple heuristic that checks for common time separators.
  const hasTime = dateInput.toString().includes(":");

  if (hasTime) {
    // Format with time if time is present
    return parsedDate.format("YYYY-MM-DD HH:mm:ss");
  } else {
    // Format as date-only if no time is present
    return parsedDate.format("YYYY-MM-DD");
  }
};

exports.getItemDetail = async (item_id, transaction = null) => {
  if (!item_id) {
    throw new Error("Item ID is required");
  }

  try {
    const item = await commonQuery.findOneRecord(
      ItemMaster,
      item_id,
      {
        include: [
          {
            model: ItemUnitMaster,
            as: "primaryUnit",
            where: { status: 0 },
            attribute: ["unit_name"]
          }
        ]
      },
      transaction
    );

    if (!item) {
      throw new Error(`Item with ID ${item_id} not found`);
    }

    return item;
  } catch (err) {
    console.error(`Error fetching item with id ${item_id}:`, err);
    throw err; // rethrow so transaction fails
  }
};

// Private helper to contain the core formatting logic.
function fixNumber(value, decimals) {
  if (value === null || value === undefined || value === "") return 0;

  const num =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/,/g, ""));

  if (isNaN(num)) return 0;

  return Number(num.toFixed(decimals));
}

exports.fixDecimals = async function (company_id) {
  const { decimal_points } = await getCompanySetting(company_id);

  const qtyDigits =
    decimal_points !== null && decimal_points !== undefined
      ? Number(decimal_points)
      : 0;

  const rateDigits = 2;

  return {
    fixQty(value) {
      return fixNumber(value, qtyDigits);
    },

    fixNum(value) {
      return fixNumber(value, rateDigits);
    }
  };
};

/**
 * Number Formatter.
 * Usage: formatNumber("1,234.5678", 2) -> "1234.57"
 */
exports.fixNum = (value, decimals = 6) => {

  if (value === null || value === undefined || value === '') return 0;

  if (typeof value === 'number') {
     return value.toFixed(decimals);
  }

  let str = String(value);

  if (str.indexOf(',') > -1) {
    str = str.replace(/,/g, '');
  }

  const num = parseFloat(str);

  return isNaN(num) ? 0 : num.toFixed(decimals);
};

/**
 * Quantity Fixer.
 * Usage: fixQty("10.5555", 3) -> "10.556"
 */
exports.fixQty = (value, decimals = 3) => {

  if (value === null || value === undefined || value === '') return 0;

  if (typeof value === 'number') {
     return value.toFixed(decimals);
  }

  const num = parseFloat(value);

  return isNaN(num) ? 0 : num.toFixed(decimals);
};

// const _format = (value, digits) => {
//   if (isNaN(value) || value === null) value = 0;
//   const factor = Math.pow(10, digits);
//   return Number((Math.round(Number(value) * factor) / factor).toFixed(digits));
// };

// exports.fixDecimals = async function (...args) {
//   // ─────────────────────────────────────────────
//   // FACTORY MODE → fixDecimals(company_id, defaultType?)
//   // ─────────────────────────────────────────────
//   if (args.length <= 2) {
//     const company_id = args[0];
//     const defaultType = args[1] || "rate";

//     const { decimal_points } = await getCompanySetting(company_id);

//     const rateDigits = 2;
//     const qtyDigits = decimal_points != null ? Number(decimal_points) : 0;

//     return function format(value, type = defaultType) {
//       const digits = type === "qty" ? qtyDigits : rateDigits;
//       return _format(value, digits);
//     };
//   }

//   // ─────────────────────────────────────────────
//   // DIRECT MODE → fixDecimals(value, company_id, type)
//   // ─────────────────────────────────────────────
//   const [value, company_id, type = "rate"] = args;

//   const { decimal_points } = await getCompanySetting(company_id);

//   const digits = type === "qty" ? Number(decimal_points || 0) : 2;

//   return _format(value, digits);
// };


exports.formatDateTime = (dateInput, format = "DD-MM-YYYY") => {
  const date = new Date(dateInput);
  if (isNaN(date)) return "";

  const day = date.getDate();
  const monthIndex = date.getMonth();
  const year = date.getFullYear();

  const map = {
    D: day,
    DD: String(day).padStart(2, "0"),
    M: getMonthNameFull(monthIndex),
    MM: String(monthIndex + 1).padStart(2, "0"),
    MMM: getMonthNameShort(monthIndex),
    YYYY: year,
    YY: String(year).slice(-2),
    H: date.getHours(),
    HH: String(date.getHours()).padStart(2, "0"),
    m: date.getMinutes(),
    mm: String(date.getMinutes()).padStart(2, "0"),
    s: date.getSeconds(),
    ss: String(date.getSeconds()).padStart(2, "0"),
  };

  return format.replace(
    /YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|H|mm|m|ss|s/g,
    (match) => map[match]
  );

  // console.log(formatDateTime(date, "D M YYYY"));      // 28 July 2025
  // console.log(formatDateTime(date, "DD-MM-YYYY"));    // 28-07-2025
  // console.log(formatDateTime(date, "MMM D, YY"));     // Jul 28, 25
  // console.log(formatDateTime(date, "YYYY/MM/DD"));    // 2025/07/28
  // console.log(formatDateTime(date, "HH:mm:ss"));      // 16:53:45
};

function getMonthNameShort(index) {
  return [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][index];
}

function getMonthNameFull(index) {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][index];
}

exports.generateSeriesNumber = async (
  typeId,
  companyId,
  transaction,
  modelToCheck = null, // e.g. ItemMaster
  uniqueField = null, // e.g. 'series_code'
  maxAttempts = 5,
  entity_id
) => {
  let attempts = 0;
  let seriesNumber;

  while (attempts < maxAttempts) {
    attempts++;

    let where = {};
    if (typeId === 0) {
      where = { series_entity_id: entity_id, is_default: 1, company_id: companyId, status: 0 };
    } else {
      where = { id: typeId, company_id: companyId, status: 0 };
    }

    // Fetch current series config
    const seriesType = await commonQuery.findOneRecord(
      SeriesTypeMaster,
      where,
      {},
      transaction,
      true
    );

    if (!seriesType) {
      throw new Error("Invalid Series type ID or Company ID");
    }

    // Generate number from config
    const id = parseInt(seriesType.start_series || 0, 10) + 1;
    switch (seriesType.series_format) {
      case 2:
        seriesNumber = `${seriesType.format_value}${padNumber(id, 3)}`;
        break;
      case 3:
        seriesNumber = `${padNumber(id, 4)}${seriesType.end_format_value}`;
        break;
      case 4:
        seriesNumber = `${seriesType.format_value}${padNumber(id, 3)}${
          seriesType.end_format_value
        }`;
        break;
      default:
        seriesNumber = padNumber(id, 3);
        break;
    }

    // ✅ Check uniqueness if model provided
    if (modelToCheck) {
      const exists = await commonQuery.findOneRecord(
        modelToCheck,
        { [uniqueField]: seriesNumber, company_id: companyId },
        {},
        transaction,
        true
      );
      
      if (!exists) {
        // Update series for next use
        return seriesNumber; // ✅ unique, return
      }

      // If exists, increment series and retry
      await commonQuery.updateRecordById(
        SeriesTypeMaster,
        { id: typeId, company_id: companyId },
        { start_series: id },
        transaction
      );
    } else {
      // If no model check required, return immediately
      return seriesNumber;
    }
  }

  throw new Error(
    `Failed to generate a unique code after ${maxAttempts} attempts. Please check series config.`
  );
};

exports.updateSeriesNumber = async (typeId, companyId, transaction = null, entity_id) => {
  try {
    let where = {};
    if (typeId === 0) {
      where = { series_entity_id: entity_id, is_default: 1, company_id: companyId, status: 0 };
    } else {
      where = { id: typeId, company_id: companyId, status: 0 };
    }
    const rows = await commonQuery.findOneRecord(
      SeriesTypeMaster,
      where,
      {},
      transaction,
      true
    );

    const seriesType = rows;

    if (!seriesType) {
      throw new Error("Series type not found");
    }

    await commonQuery.updateRecordById(
      SeriesTypeMaster,
      {
        id: typeId,
        company_id: companyId,
      },
      { start_series: parseInt(seriesType.start_series || 0, 10) + 1 },
      transaction
    );

    return true;
  } catch (err) {
    console.error("Error updating series number:", err);
    throw err;
  }
};

// Helper
function padNumber(num, width = 3, char = "0") {
  return String(num).padStart(width, char);
}

/**
 * Generates a revised series code based on the previous record.
 * e.g., 'QT-001' -> 'QT-001/R-1'
 * e.g., 'QT-001/R-1' -> 'QT-001/R-2'
 * @param {Model} Model - The Sequelize model to query (e.g., Quotation).
 * @param {number} previousRecordId - The ID of the record being revised.
 * @param {object} transaction - The Sequelize transaction object.
 * @returns {Promise<string>} The new revised series code.
 * @throws {Error} If the previous record is not found or the series code is malformed.
 */
exports.generateRevisionSeries = async (Model, previousRecordId, transaction) => {
  // 1. Get the previous record
  const previousRecord = await Model.findByPk(previousRecordId, {
    attributes: ['series_code'],
    transaction,
    raw: true,
  });

  if (!previousRecord) {
    throw new Error('Previous record for revision not found.');
  }

  // 2. Calculate the next revision number
  const prevSeriesCode = previousRecord.series_code;
  const revisionParts = prevSeriesCode.split('/R-');
  const baseSeriesCode = revisionParts[0];
  let nextRevisionNumber;

  if (revisionParts.length > 1) {
    // Previous code was already a revision
    const currentRevisionNumber = parseInt(revisionParts[1], 10);
    
    if (isNaN(currentRevisionNumber)) {
      throw new Error('Cannot revise due to a malformed previous series code.');
    }
    nextRevisionNumber = currentRevisionNumber + 1;
  } else {
    // Previous code was the original, so this is the first revision
    nextRevisionNumber = 1;
  }

  // 3. Return the new series code
  return `${baseSeriesCode}/R-${nextRevisionNumber}`;
};

exports.createOrUpdateNotification = async (data, transaction = null) => {
  try {
    if (data.id) {
      const notification = await commonQuery.updateRecordById(Notification, data.id, data, transaction);
      return { success: true, action: "updated", data: notification };
    } else {
      const notification = await commonQuery.createRecord(Notification, data, transaction);
      return { success: true, action: "created", data: notification };
    }
  } catch (error) {
    console.error("Error in createOrUpdateNotification:", error);
    return { success: false, message: "Failed to process notification." };
  }
}

exports.initializeCompanySettings = async (company_id, branch_id, user_id, transaction) => {
    try {
        // 1. Fetch all Master Settings (definitions)
        // We assume status: 0 means Active master settings
        const masterSettings = await commonQuery.findAllRecords(
            CompanySettingsMaster, 
            { status: 0 }, 
            {}, 
            transaction, 
            false // No tenant check needed for Master table
        );

        if (!masterSettings || masterSettings.length === 0) {
            console.warn("No Master Settings found to initialize.");
            return;
        }

        // 2. Prepare Payload for CompanyConfigration
        const settingsPayload = masterSettings.map(setting => ({
            company_id: company_id,
            branch_id: branch_id,
            user_id: user_id,
            setting_key: setting.setting_key,
            // Use the default value from master, or empty string if null
            setting_value: setting.default_value !== null ? setting.default_value : "", 
            status: 0
        }));

        // 3. Bulk Create
        await commonQuery.bulkCreate(
            CompanyConfigration, 
            settingsPayload, 
            { company_id, branch_id, user_id }, 
            transaction
        );
        
        console.log(`Initialized ${settingsPayload.length} settings for Company ${company_id}`);
        return true;

    } catch (error) {
        console.error("Error initializing company settings:", error);
        throw error; // Let the caller handle the rollback
    }
};

exports.updateDocumentUsedLimit = async (companyId, field, by=1, transaction) => {
    try {
      const record = await commonQuery.findOneRecord(
          CompanyMaster, 
          companyId,
          { attributes: ['id', 'company_id'] }
      );
      
      if (!record) {
          return res.error("NOT_FOUND", { message : "Invalid or missing company record."});
      }
  
      let company_id = record.company_id || record.id;
      console.log(`Updating used limit for company ${company_id}, field: used_${field}, by: ${by}`);
      
      // First find the specific subscription record for this company
      const subscriptionRecord = await commonQuery.findOneRecord(
        CompanySubscription,
        {
          company_id: company_id,
          status: 0
        },
        { attributes: ['id'] }
      );
      
      if (!subscriptionRecord) {
          console.warn(`No active subscription found for company ${company_id}`);
          return false;
      }
      
      // Increment only the specific found record by ID
      const affected = await CompanySubscription.increment(
        `used_${field}`,
        {
          by: by,
          where: {
            id: subscriptionRecord.id,
            [Op.and]: [literal(`${field}_limit > used_${field}`)],
          },
          transaction
        }
      );

      updateSubscriptionCache(company_id, field, by);

      return true;
    } catch (error) {
        console.error("Error in update used limit:", error);
        throw error;
    }
};