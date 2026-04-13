const { WeeklyOffTemplate, WeeklyOffTemplateDay, User, Employee, AttendanceDay, EmployeeHoliday, Holiday } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, Op } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { calculateWorkingAndOffDays } = require("../../helpers/functions/commonFunctions");
const EmployeeTemplateService = require("../../services/employeeTemplateService");
const dayjs = require("dayjs");


async function checkHolidayForEmployees(employeeIds, date, transaction) {
    const holidays = await commonQuery.findAllRecords(
        EmployeeHoliday,
        {
            employee_id: { [Op.in]: employeeIds },
            date: date,
            status: 0
        },
        {},
        transaction
    );
    
    const holidayMap = new Map();
    holidays.forEach(holiday => {
        holidayMap.set(holiday.employee_id, holiday);
    });
    
    return holidayMap;
}

async function handleAttendanceDayUpdates(employeeIds, date, isAddingWeeklyOff, transaction, meta = {}) {
    if (!employeeIds || employeeIds.length === 0) return;
    
    const today = dayjs().format('YYYY-MM-DD');
    const isToday = date === today;
    
    // Only process for today or future dates
    if (date < today) return;
    
    if (isAddingWeeklyOff) {
        // Adding weekly off - create/update AttendanceDay records with WEEKLY_OFF status
        const existingRecords = await commonQuery.findAllRecords(
            AttendanceDay,
            {
                employee_id: { [Op.in]: employeeIds },
                attendance_date: date,
                status: { [Op.notIn]: [2, 3, 6] } // Exclude deleted, weekly_off, leave (but include HOLIDAY)
            },
            {},
            transaction
        );
        
        const existingEmpIds = new Set(existingRecords.map(r => r.employee_id));
        const missingEmpIds = employeeIds.filter(id => !existingEmpIds.has(id));
        
        // Update existing records to WEEKLY_OFF (including HOLIDAY records)
        const updatePromises = existingRecords.map(record => 
            commonQuery.updateRecordById(
                AttendanceDay,
                record.id,
                {
                    status: 3, // WEEKLY_OFF
                    shift_id: null, // Clear shift when converting to weekly off
                    note: "", 
                    // note: record.status === 4 
                    //     ? `System: Changed from Holiday to Weekly Off (${dayjs(date).format('dddd')})`
                    //     : "System: Weekly Off auto-detected (template updated)",
                    updated_at: new Date()
                },
                transaction
            )
        );
        
        // Create new records for employees without AttendanceDay for this date
        const createPayloads = missingEmpIds.map(empId => ({
            employee_id: empId,
            attendance_date: date,
            status: 3, // WEEKLY_OFF
            user_id: meta.user_id || 0,
            company_id: meta.company_id || 0,
            branch_id: meta.branch_id || 0,
            note: "",
            // note: "System: Weekly Off auto-detected (template updated)",
            created_at: new Date(),
            updated_at: new Date()
        }));
        
        await Promise.all(updatePromises);
        if (createPayloads.length > 0) {
            await commonQuery.bulkCreate(AttendanceDay, createPayloads, {}, transaction);
        }
    } else {
        // Removing weekly off - check for holidays first
        const holidayMap = await checkHolidayForEmployees(employeeIds, date, transaction);
        
        const weeklyOffRecords = await commonQuery.findAllRecords(
            AttendanceDay,
            {
                employee_id: { [Op.in]: employeeIds },
                attendance_date: date,
                status: 3 // WEEKLY_OFF
            },
            {},
            transaction
        );
        
        for (const record of weeklyOffRecords) {
            if (holidayMap.has(record.employee_id)) {
                // This day is a holiday, update status to HOLIDAY
                const holiday = holidayMap.get(record.employee_id);
                await commonQuery.updateRecordById(
                    AttendanceDay,
                    record.id,
                    {
                        status: 4, // HOLIDAY
                        note: ``,
                        // note: `System: Holiday auto-detected (${holiday.name || 'Holiday'}) - Weekly Off removed`,
                        updated_at: new Date()
                    },
                    transaction
                );
            } else {
                // Not a holiday, delete the AttendanceDay record
                await commonQuery.hardDeleteRecords(
                    AttendanceDay,
                    {
                        id: record.id
                    },
                    transaction
                );
            }
        }
    }
}

exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            name: "Template Name",
            days: "Weekly Off Days"
        };

        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: {
                model: WeeklyOffTemplate,
                fields: ["name"],
            }
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const { days, ...templateData } = req.body;

        // 1️⃣ Create Template
        const template = await commonQuery.createRecord(WeeklyOffTemplate, templateData, transaction);

        // 2️⃣ Prepare Days
        const dayRecords = days.map(d => ({
            template_id: template.id,
            day_of_week: d.day_of_week,
            week_no: d.week_no,
            is_off: d.is_off ?? false
        }));

        // 3️⃣ Bulk Insert Days
        await commonQuery.bulkCreate(WeeklyOffTemplateDay, dayRecords, {}, transaction);

        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_CREATED, template );
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all active shift records
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["name", true, true],
        ];
            
        const records = await commonQuery.fetchPaginatedData(
            WeeklyOffTemplate,
            req.body,
            fieldConfig,
        );

        if (records.items && Array.isArray(records.items)) {
            for (const record of records.items) {
                const employeeCount = await commonQuery.countRecords(
                    Employee,
                    { weekly_off_template: record.id, status: 0 }
                );
                if (record.dataValues) {
                    record.dataValues.employee_count = employeeCount;
                } else {
                    record.employee_count = employeeCount;
                }
            }
        }

        return res.ok(records);
    } catch (err) {
        return handleError(err, res, req);
    }
};
// Get By Id
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(WeeklyOffTemplate, req.params.id, {
            include: [{ model: WeeklyOffTemplateDay, as: "days" }]
        });

        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update shift record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { days, ...templateData } = req.body;

        const requiredFields = {
            name: "Template Name",
            days: "Weekly Off Days"
        };

        const errors = await validateRequest(
            req.body,
            requiredFields,
            {
                uniqueCheck: {
                    model: WeeklyOffTemplate,
                    fields: ["name"],
                    excludeId: id,
                }
            },
            transaction
        );

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const updated = await commonQuery.updateRecordById(WeeklyOffTemplate, id, templateData, transaction);

        if (!updated || updated.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // Trigger sync for all employees using this template
        const employeesToSync = await commonQuery.findAllRecords(Employee, { weekly_off_template: id, status: 0 }, { attributes: ['id', 'shift_template', 'company_id', 'branch_id'] }, transaction);

        // Sync WeeklyOffTemplateDay
        if (Array.isArray(days)) {
            const incomingIds = days.map(d => d.id).filter(Boolean);

            // Get existing days to compare changes
            const existingDays = await commonQuery.findAllRecords(
                WeeklyOffTemplateDay,
                { template_id: id, status: 0 },
                {},
                transaction
            );

            // 1. Soft delete removed days
            await commonQuery.softDeleteById(
                WeeklyOffTemplateDay,
                {
                    template_id: id,
                    id: { [Op.notIn]: incomingIds }
                },
                transaction
            );

            // 2. Update or Create days and track changes
            const dayChanges = {
                added: [],
                removed: []
            };

            for (const day of days) {
                const dayPayload = {
                    ...day,
                    template_id: id,
                    is_off: day.is_off ?? true
                };

                if (day.id) {
                    const existingDay = existingDays.find(d => d.id === day.id);
                    await commonQuery.updateRecordById(WeeklyOffTemplateDay, day.id, dayPayload, transaction);
                    
                    // Track if weekly off status changed
                    if (existingDay && existingDay.is_off !== dayPayload.is_off) {
                        if (dayPayload.is_off) {
                            dayChanges.added.push(dayPayload);
                        } else {
                            dayChanges.removed.push(dayPayload);
                        }
                    }
                } else {
                    await commonQuery.createRecord(WeeklyOffTemplateDay, dayPayload, transaction);
                    if (dayPayload.is_off) {
                        dayChanges.added.push(dayPayload);
                    }
                }
            }

            // 3. Handle AttendanceDay updates for today's date
            const today = dayjs().format('YYYY-MM-DD');
            const todayDayOfWeek = dayjs().day();
            const currentWeekNo = Math.ceil(dayjs().date() / 7);

            if (employeesToSync.length > 0) {
                const employeeIds = employeesToSync.map(emp => emp.id);
                const meta = {
                    user_id: req.user?.id || 0,
                    company_id: employeesToSync[0]?.company_id || 0,
                    branch_id: employeesToSync[0]?.branch_id || 0
                };

                // Handle added weekly offs for today
                for (const change of dayChanges.added) {
                    const shouldApplyToday = 
                        (change.week_no === 0 && change.day_of_week === todayDayOfWeek) || // All weeks
                        (change.week_no === currentWeekNo && change.day_of_week === todayDayOfWeek); // Current week
                    
                    if (shouldApplyToday) {
                        await handleAttendanceDayUpdates(employeeIds, today, true, transaction, meta);
                    }
                }

                // Handle removed weekly offs for today
                for (const change of dayChanges.removed) {
                    const shouldApplyToday = 
                        (change.week_no === 0 && change.day_of_week === todayDayOfWeek) || // All weeks
                        (change.week_no === currentWeekNo && change.day_of_week === todayDayOfWeek); // Current week
                    
                    if (shouldApplyToday) {
                        await handleAttendanceDayUpdates(employeeIds, today, false, transaction, meta);
                    }
                }
            }
        }
        if (employeesToSync.length > 0) {
            const employeeIds = employeesToSync.map(emp => emp.id);
            
            // 1. First sync the weekly off data in bulk (skip rebuild here)
            await EmployeeTemplateService.bulkSyncSpecificTemplate(employeeIds, 'weekly_off_template', id, transaction, { skipRebuild: true });
            
            // 2. Then re-sync their shift template in bulk because shift settings depend on off-days
            const shiftTemplateGroups = {};
            employeesToSync.forEach(emp => {
                if (emp.shift_template) {
                    if (!shiftTemplateGroups[emp.shift_template]) shiftTemplateGroups[emp.shift_template] = [];
                    shiftTemplateGroups[emp.shift_template].push(emp.id);
                }
            });

            for (const [sId, ids] of Object.entries(shiftTemplateGroups)) {
                // Sync shifts in bulk (skip rebuild here too)
                await EmployeeTemplateService.bulkSyncSpecificTemplate(ids, 'shift_template', sId, transaction, { skipRebuild: true });
            }

            // 3. FINALLY: Rebuild attendance for all affected employees ONCE
            // await EmployeeTemplateService.rebuildCurrentMonthAttendance(employeeIds, transaction);
        }

        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_UPDATED, updated);
    } catch (err) {
        if (transaction && !transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete a shift record by ID
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            ids: "Select Data"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        let { ids } = req.body;

        const deleted = await commonQuery.softDeleteById(WeeklyOffTemplate, ids, transaction);
        const deletedDays = await commonQuery.softDeleteById(WeeklyOffTemplateDay, { template_id: { [Op.in]: ids } }, transaction);
        if (!deleted || !deletedDays) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Update Status 
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {

        const { status, ids } = req.body;

        const requiredFields = {
            ids: "Select Any One Data",
            status: "Select Status"
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        // Update only the status field by id
        const updated = await commonQuery.updateRecordById(
            WeeklyOffTemplate,
            ids,
            { status },
            transaction
        );

        const updatedDays = await commonQuery.updateRecordById(
            WeeklyOffTemplateDay,
            { template_id: { [Op.in]: ids } },
            { status },
            transaction
        );

        if (!updated || !updatedDays) {
            if (!transaction.finished) await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.WEEKLY_OFF_UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};


exports.dropdownList = async (req, res) => {
  try {
    const result = await commonQuery.findAllRecords(WeeklyOffTemplate, { status: 0 }, { attributes: ["id", "name"] });
    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};