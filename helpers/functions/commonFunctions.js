const NodeCache = require("node-cache");
const { literal, Op } = require("sequelize");
const { SeriesTypeMaster, ItemMaster, Notification, ItemUnitMaster, CompanySettingsMaster, CompanyConfigration, CompanySubscription, CompanyMaster, EmployeeSettings  } = require("../../models");
const commonQuery = require("../commonQuery");
const { getCompanySetting, updateSubscriptionCache } = require("../cache");
const dayjs = require("dayjs"); 
const { fail } = require("../Err");

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

exports.fixDecimals = async function (company_id = null) {
  const { company_id: companyId } = getContext();
  const { decimal_points } = await getCompanySetting(companyId);

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
    M: monthIndex + 1,
    MM: String(monthIndex + 1).padStart(2, "0"),
    MMM: getMonthNameShort(monthIndex),
    MMMM: getMonthNameFull(monthIndex),
    YYYY: year,
    YY: String(year).slice(-2),
    d: date.getDay(),
    ddd: getDayNameShort(date.getDay()),
    dddd: getDayNameFull(date.getDay()),
    H: date.getHours(),
    HH: String(date.getHours()).padStart(2, "0"),
    h: date.getHours() % 12 || 12,
    hh: String(date.getHours() % 12 || 12).padStart(2, "0"),
    m: date.getMinutes(),
    mm: String(date.getMinutes()).padStart(2, "0"),
    s: date.getSeconds(),
    ss: String(date.getSeconds()).padStart(2, "0"),
    A: date.getHours() >= 12 ? "PM" : "AM",
    a: date.getHours() >= 12 ? "pm" : "am",
  };

  return format.replace(
    /YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|d|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g,
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

function getDayNameShort(index) {
  return [
    "Sun",
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
    "Sat",
  ][index];
}

function getDayNameFull(index) {
  return [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ][index];
}

exports.generateSeriesNumber = async (
  typeId,
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
      where = { series_entity_id: entity_id, is_default: 1, status: 0 };
    } else {
      where = { id: typeId, status: 0 };
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

    // Check uniqueness if model provided
    if (modelToCheck) {
      const exists = await commonQuery.findOneRecord(
        modelToCheck,
        { [uniqueField]: seriesNumber },
        {},
        transaction,
        true
      );
      
      if (!exists) {
        // Update series for next use
        return seriesNumber; // unique, return
      }

      // If exists, increment series and retry
      await commonQuery.updateRecordById(
        SeriesTypeMaster,
        { id: typeId },
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

exports.updateSeriesNumber = async (typeId, transaction = null, entity_id) => {
  try {
    let where = {};
    if (typeId === 0) {
      where = { series_entity_id: entity_id, is_default: 1, status: 0 };
    } else {
      where = { id: typeId, status: 0 };
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
        // // 1. Fetch all Master Settings (definitions)
        // // We assume status: 0 means Active master settings
        // const masterSettings = await commonQuery.findAllRecords(
        //     CompanySettingsMaster, 
        //     { status: 0 }, 
        //     {}, 
        //     transaction, 
        //     false // No tenant check needed for Master table
        // );

        // if (!masterSettings || masterSettings.length === 0) {
        //     console.warn("No Master Settings found to initialize.");
        //     return;
        // }

        // // 2. Prepare Payload for CompanyConfigration
        // const settingsPayload = masterSettings.map(setting => ({
        //     company_id: company_id,
        //     branch_id: branch_id,
        //     user_id: user_id,
        //     setting_key: setting.setting_key,
        //     setting_value: setting.default_value !== null ? setting.default_value : "", 
        //     status: 0
        // }));

        // // 3. Bulk Create
        // await commonQuery.bulkCreate(
        //     CompanyConfigration, 
        //     settingsPayload, 
        //     { company_id, branch_id, user_id }, 
        //     transaction
        // );

        const employeeSettingsPayload = [
            {
                settings_name: "is_auto_generate_employee_code",
                settings_value: true,
                status: 0,
                user_id: user_id,
                branch_id: branch_id,
                company_id: company_id
            },
            {
                settings_name: "employee_series",
                settings_value: [],
                status: 0,
                user_id: user_id,
                branch_id: branch_id,
                company_id: company_id
            }
        ];

        const data = await commonQuery.bulkCreate(
            EmployeeSettings,
            employeeSettingsPayload,
            { company_id, branch_id, user_id },
            transaction
        );
        
        // console.log(`Initialized ${settingsPayload.length} settings for Company ${company_id}`);
        return true;

    } catch (error) {
        console.error("Error initializing company settings:", error);
        throw error; // Let the caller handle the rollback
    }
};

exports.initializeCompanyRoles = async (company_id, branch_id, user_id, transaction) => {
    try {
        const { RolePermission } = require("../../models");
        const commonQuery = require("../commonQuery");

        const systemRoles = await commonQuery.findAllRecords(
            RolePermission,
            { is_system: true, status: 0, company_id: -1, branch_id: -1 },
            {},
            transaction,
            false
        );

        if (systemRoles && systemRoles.length > 0) {
            const rolesToCreate = systemRoles.map(role => {
                const roleData = role.toJSON ? role.toJSON() : { ...role };
                return {
                    role_name: roleData.role_name,
                    role_key: roleData.role_key,
                    description: roleData.description,
                    permissions: roleData.permissions,
                    is_system: false,
                    p_role_id: roleData.id,
                    company_id: company_id,
                    branch_id: branch_id || 0,
                    user_id: user_id,
                    status: 0
                };
            });
            return await commonQuery.bulkCreate(RolePermission, rolesToCreate, {}, transaction, false);
        }
        return [];
    } catch (error) {
        console.error("Error initializing company roles:", error);
        throw error;
    }
};

exports.updateDocumentUsedLimit = async (companyId, field, by=1, transaction) => {
    try {
      console.log("-----------------------------------------companyId",companyId)
      const record = await CompanyMaster.findOne({
          where: { id: companyId },
          attributes: ['id', 'company_id', 'organization_id'],
          transaction
      });

      if (!record) {
        fail("NOT_FOUND", { message : "Invalid or missing company record."});
      }
      
      let orgId = record.organization_id;
      let subscriptionWhere = {};
      let company_id = record.company_id || record.id;
      if (orgId) {
          subscriptionWhere = { organization_id: orgId, status: 0 };
      } else {
          subscriptionWhere = { company_id: company_id, status: 0 };
      }

      console.log(`Updating used limit for ${orgId ? 'organization ' + orgId : 'company ' + record.id}, field: used_${field}, by: ${by}`);
      
      // First find the specific subscription record for this company or organization
      const subscriptionRecord = await CompanySubscription.findOne({
        where: subscriptionWhere,
        attributes: ['id'],
        transaction
      });
      
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


exports.calculateWorkingAndOffDays = (days, referenceDate = new Date()) => {
    if (!Array.isArray(days) || days.length === 0) {
        return { working_days: null, off_days: 0 };
    }

    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth(); // 0-11
    const monthNames = ["January", "February", "March", "April", "May", "June",
                       "July", "August", "September", "October", "November", "December"];
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    
    // Get the actual number of days in the current month
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    days.forEach((day, index) => {
        if (day.is_off && day.status !== 2) {
            const dayName = dayNames[day.day_of_week];
            const weekText = day.week_no === 0 ? "All weeks" : `${getOrdinal(day.week_no)} week`;
            console.log(`   ${index + 1}. ${dayName} - ${weekText}`);
        }
    });
    
    let offDaysCount = 0;
    const offDates = new Set(); // Track specific dates that are off
    const matchedRules = []; // Track which rules matched which dates

    // Process each weekly off rule
    days.forEach((day, ruleIndex) => {
        if (day.is_off && day.status !== 2) {
            const dayName = dayNames[day.day_of_week];
            let ruleMatches = [];
            
            if (day.week_no === 0) {
                // All weeks - find all occurrences of this day in the month
                for (let date = 1; date <= daysInMonth; date++) {
                    const currentDate = new Date(year, month, date);
                    const dayOfWeek = currentDate.getDay();
                    
                    if (dayOfWeek === day.day_of_week) {
                        offDates.add(date);
                        ruleMatches.push(date);
                    }
                }
            } else {
                // Specific week - find the nth occurrence of this day in the month
                let occurrenceCount = 0;
                for (let date = 1; date <= daysInMonth; date++) {
                    const currentDate = new Date(year, month, date);
                    const dayOfWeek = currentDate.getDay();
                    
                    if (dayOfWeek === day.day_of_week) {
                        occurrenceCount++;
                        if (occurrenceCount === day.week_no) {
                            offDates.add(date);
                            ruleMatches.push(date);
                            break; // Found the nth occurrence
                        }
                    }
                }
                
                if (ruleMatches.length === 0) {
                }
            }
            
            if (ruleMatches.length > 0) {
                matchedRules.push({
                    rule: `${dayName} (${day.week_no === 0 ? 'All weeks' : getOrdinal(day.week_no) + ' week'})`,
                    matches: ruleMatches
                });
            }
        }
    });

    offDaysCount = offDates.size;
    const workingDays = daysInMonth - offDaysCount;
    return {
        working_days: Math.max(0, workingDays),
        off_days: offDaysCount,
        total_days_in_month: daysInMonth,
        off_dates: Array.from(offDates).sort((a, b) => a - b)
    };
};

// Helper function to get ordinal numbers (1st, 2nd, 3rd, 4th, etc.)
function getOrdinal(num) {
    const j = num % 10;
    const k = Math.floor(num / 10) % 10;
    if (k === 1) return num + 'th';
    if (j === 1) return num + 'st';
    if (j === 2) return num + 'nd';
    if (j === 3) return num + 'rd';
    return num + 'th';
}