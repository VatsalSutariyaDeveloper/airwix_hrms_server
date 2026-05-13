const NodeCache = require("node-cache");
const { literal, Op } = require("sequelize");
const { SalaryComponent, SeriesTypeMaster, ItemMaster, Notification, ItemUnitMaster, CompanySettingsMaster, CompanyConfigration, CompanySubscription, CompanyMaster, EmployeeSettings, CompanySettings, sequelize } = require("../../models");
const commonQuery = require("../commonQuery");
const { getCompanySetting, updateSubscriptionCache } = require("../cache");
const dayjs = require("dayjs"); 
const customParseFormat = require("dayjs/plugin/customParseFormat");
dayjs.extend(customParseFormat);
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

exports.formatDateTime = (dateInput, format = "DD-MM-YYYY") => {
  if (!dateInput) return "";
  
  let d;
  // If it's already a Date object or Dayjs object, just wrap it
  if (dateInput instanceof Date || dayjs.isDayjs(dateInput)) {
    d = dayjs(dateInput);
  } else {
    // If it's a string, use our supported formats
    d = dayjs(dateInput, ["YYYY-MM-DD", "DD-MM-YYYY", "YYYY-MM-DD HH:mm:ss", "DD-MM-YYYY HH:mm:ss", "YYYY-MM-DDTHH:mm:ss.SSSZ"]);
  }
  
  if (!d.isValid()) return "";
  return d.format(format);
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
            transaction,
            false
        );

        // --- 4. Initialize CompanySettings with Defaults ---
        const { constants } = require("../constants");
        if (constants.DEFAULT_COMPANY_SETTINGS && Array.isArray(constants.DEFAULT_COMPANY_SETTINGS)) {
            const companySettingsPayload = constants.DEFAULT_COMPANY_SETTINGS.map(setting => ({
                ...setting,
                user_id: user_id,
                branch_id: branch_id,
                company_id: company_id,
                status: 0
            }));

            await commonQuery.bulkCreate(
                CompanySettings,
                companySettingsPayload,
                { company_id, branch_id, user_id },
                transaction,
                false
            );
        }

        await this.initializeSalaryComponents(company_id, branch_id, user_id, transaction);

        return data; 
    } catch (error) {
        console.error("Error initializing company settings:", error);
        throw error;
    }
};

exports.initializeSalaryComponents = async (company_id, branch_id, user_id, transaction) => {
    try {
        const standardComponents = [
            {
                component_name: "Basic",
                component_type: "EARNING",
                component_category: "FIXED",
                calculation_type: "ATTENDANCE_BASED",
                is_system_component: true,
                is_lwp_impacted: true,
                is_part_of_ctc: true,
                is_part_of_gross: true,
                is_part_of_take_home: true,
                is_taxable: true,
                sort_order: 1
            },
            {
                component_name: "HRA",
                component_type: "EARNING",
                component_category: "FIXED",
                calculation_type: "FIXED",
                is_system_component: true,
                is_lwp_impacted: true,
                is_part_of_ctc: true,
                is_part_of_gross: true,
                is_part_of_take_home: true,
                is_taxable: true,
                sort_order: 2
            },
            {
                component_name: "Food Deduction",
                component_type: "DEDUCTION",
                component_category: "VARIABLE",
                calculation_type: "FORMULA",
                formula: "{CANTEEN_ATTENDANCE} * 40",
                is_system_component: true,
                is_lwp_impacted: false,
                is_part_of_ctc: false,
                is_part_of_gross: false,
                is_part_of_take_home: true,
                is_taxable: false,
                sort_order: 3
            },
            {
                component_name: "Leave Encashment",
                component_type: "EMPLOYER_CONTRIBUTION",
                component_category: "STATUTORY",
                calculation_type: "PERCENTAGE",
                percentage_of: "BASIC",
                percentage_value: 4.81,
                is_system_component: true,
                is_lwp_impacted: false,
                is_part_of_ctc: true,
                is_part_of_gross: false,
                is_part_of_take_home: false,
                is_taxable: true,
                is_statutory: true,
                sort_order: 4
            },
            {
                component_name: "Bonus",
                component_type: "EMPLOYER_CONTRIBUTION",
                component_category: "STATUTORY",
                calculation_type: "PERCENTAGE",
                percentage_of: "BASIC",
                percentage_value: 8.33,
                is_system_component: true,
                is_lwp_impacted: false,
                is_part_of_ctc: true,
                is_part_of_gross: false,
                is_part_of_take_home: false,
                is_taxable: true,
                is_statutory: true,
                sort_order: 5
            }
        ];

        const payload = standardComponents.map(comp => ({
            ...comp,
            company_id,
            branch_id: branch_id || 0,
            user_id: user_id || 0,
            status: 0
        }));

        // Use update or create logic for each to ensure existing ones are updated to new standard
        for (const comp of payload) {
            const [record, created] = await SalaryComponent.findOrCreate({
                where: {
                    component_name: comp.component_name,
                    company_id: comp.company_id,
                    status: { [Op.ne]: 2 }
                },
                defaults: comp,
                transaction
            });

            if (!created) {
                // Update existing record with new standard values if it was already created
                await record.update(comp, { transaction });
            }
        }

        return true;
    } catch (error) {
        console.error("Error initializing salary components:", error);
        throw error;
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
            {}
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
            return await commonQuery.bulkCreate(RolePermission, rolesToCreate, {}, transaction, {});
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
/**
 * Generates a where condition for punching operations based on company settings.
 * Levels: 
 * 1. Default: Employee must match device company AND branch.
 * 2. company_branch_punch_config: Employee can punch in any branch of their company.
 * 3. company_punch_config: Employee can punch in any branch/company within their organization.
 */
exports.getPunchAllowedWhere = async (company_id, branch_id) => {
    const settings = await getCompanySetting(company_id);
    const company_branch_punch_config = settings.company_branch_punch_config;
    const company_punch_config = settings.company_punch_config;
    let where = { status: 0 };
    if (company_punch_config === true || company_punch_config === "true") {
        const company = await commonQuery.findOneRecord(CompanyMaster, { id: company_id }, { attributes: ["organization_id"] }, null, false, {});
        if (company && company.organization_id) {
            const orgCompanies = await commonQuery.findAllRecords(CompanyMaster, { organization_id: company.organization_id, status: 0 }, { attributes: ["id"] }, null, {});
            const companyIds = orgCompanies.map(c => c.id);
            where.company_id = { [Op.in]: companyIds };
        } else {
            where.company_id = company_id;
        }
    } else if (company_branch_punch_config === true || company_branch_punch_config === "true") {
        where.company_id = company_id;
    } else {
        where.company_id = company_id;
        where[Op.or] = [
            { branch_id: branch_id },
            {
                access_branches: {
                    [Op.contains]: [branch_id]   // 👈 important
                }
            }
        ];
    }
    console.log('where', where);
    return where;
}

exports.getFilteredAnnouncements = async (userId, roleId, models, returnCountOnly = true, excludeRead = false) => {
    const { Announcement, Notification } = models;
    const today = dayjs().format("YYYY-MM-DD");
    const todayEnd = dayjs().endOf('day').format("YYYY-MM-DD HH:mm:ss");

    // Fetch active announcements
    const activeAnnouncements = await commonQuery.findAllRecords(Announcement, {
        status: 0,
        announcement_date: { [Op.lte]: todayEnd },
        [Op.or]: [
            { expiry_date: null },
            { expiry_date: { [Op.gte]: today } }
        ]
    }, {}, null);

    // Fetch CLEARED announcement IDs (status: 2, type: 'ANNOUNCEMENT') - matching getNotifications logic
    const clearedAnnouncementRecords = await commonQuery.findAllRecords(Notification, {
        user_id: userId,
        type: 'ANNOUNCEMENT',
        status: 2 // Deleted/cleared
    }, {}, null);
    const clearedAnnouncementIds = clearedAnnouncementRecords.map(n => parseInt(n.reference_id));

    // Fetch READ announcement IDs (is_read: 1, type: 'ANNOUNCEMENT') - for count only
    let readAnnouncementIds = [];
    if (excludeRead) {
        const readAnnouncementRecords = await commonQuery.findAllRecords(Notification, {
            user_id: userId,
            type: 'ANNOUNCEMENT',
            is_read: 1
        }, {
            attributes: ['reference_id']
        }, null, false);
        readAnnouncementIds = readAnnouncementRecords.map(n => parseInt(n.reference_id));
    }

    // Filter announcements by target (matching getNotifications logic)
    const filteredAnnouncements = activeAnnouncements.filter(ann => {
        // Exclude if user has CLEARED this announcement (status 2)
        if (clearedAnnouncementIds.includes(ann.id)) return false;

        // Exclude if user has READ this announcement (is_read: 1) - for count only
        if (excludeRead && readAnnouncementIds.includes(ann.id)) return false;

        // target_type: 0 = all, 1 = employees, 2 = specific roles, 3 = specific users
        if (ann.target_type === 0) return true; // All users
        if (ann.target_type === 1) return true; // All employees
        if (ann.target_type === 2) {
            // Specific roles - target contains role_ids like "79,80,83" or [79, 80]
            let targetArray = Array.isArray(ann.target) ? ann.target : String(ann.target || "").split(",");
            const targetRoleIds = targetArray.map(t => parseInt(String(t).trim()));
            return targetRoleIds.includes(roleId);
        }
        if (ann.target_type === 3) {
            // Specific users - target contains user_ids
            let targetArray = Array.isArray(ann.target) ? ann.target : String(ann.target || "").split(",");
            const targetUserIds = targetArray.map(t => parseInt(String(t).trim()));
            return targetUserIds.includes(userId);
        }
        return false;
    });

    return returnCountOnly ? filteredAnnouncements.length : filteredAnnouncements;
}
