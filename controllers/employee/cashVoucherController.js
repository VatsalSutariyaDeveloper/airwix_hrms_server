const dayjs = require("dayjs");
const { commonQuery, handleError, Op } = require("../../helpers");
const { AttendanceDay, Employee, AttendanceTemplate, CashVoucher } = require("../../models");


exports.getEmployeesByMonthYear = async (req, res) => {
    try {
        const { month, year } = req.body;
        if (!month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Month and Year are required" });
        }

        const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
        const endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

        // Configuration for searchable and sortable fields
        const fieldConfig = [
            ['attendance_date', false, true],
            ['employee.first_name', true, true],
            ['employee.employee_code', true, true]
        ];

        const paginatedData = await commonQuery.fetchPaginatedData(
            AttendanceDay,
            { 
                ...req.body,
                startDate,
                endDate,
                limit: 'all'
            },
            fieldConfig,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["first_name", "employee_code"],
                        include: [
                            {
                                model: AttendanceTemplate,
                                as: "attendanceTemplate",
                                where: { include_overtime_in_total: false },
                                required: true,
                                attributes:[]
                            }
                        ],
                        required: true
                    }
                ],
                attributes:[
                    "id",
                    "employee_id",
                    "attendance_date",
                    "status",
                    "overtime_minutes",
                    "overtime_data"
                ],
                raw: true,
                nest: true
            },
            true, // requireTenantFields
            "attendance_date", // dateField
            { overtime_data: { [Op.ne]: null } } // customWhere
        );

        const items = paginatedData.items;
        const groupedMap = new Map();

        items.forEach(item => {
            const empId = item.employee_id;
            const lateOtAmount = item.overtime_data?.late_ot?.amount || 0;
            const earlyOtAmount = item.overtime_data?.early_ot?.amount || 0;
            const totalDayAmount = parseFloat((lateOtAmount + earlyOtAmount).toFixed(2));

            if (!groupedMap.has(empId)) {
                groupedMap.set(empId, {
                    employee_id: empId,
                    first_name: item.employee.first_name,
                    employee_code: item.employee.employee_code,
                    total_overtime_minutes: 0,
                    total_overtime_amount: 0,
                    overtime_history: []
                });
            }

            const { employee, ...historyItem } = item;
            
            // Filter overtime_data to remove entries with minutes: 0
            if (historyItem.overtime_data) {
                const filteredOtData = {};
                if (historyItem.overtime_data.late_ot && historyItem.overtime_data.late_ot.minutes > 0) {
                    filteredOtData.late_ot = historyItem.overtime_data.late_ot;
                }
                if (historyItem.overtime_data.early_ot && historyItem.overtime_data.early_ot.minutes > 0) {
                    filteredOtData.early_ot = historyItem.overtime_data.early_ot;
                }
                historyItem.overtime_data = filteredOtData;
            }

            const group = groupedMap.get(empId);
            group.total_overtime_minutes += (item.overtime_minutes || 0);
            group.total_overtime_amount = parseFloat((group.total_overtime_amount + totalDayAmount).toFixed(2));
            group.overtime_history.push(historyItem);
        });

        const groupedItems = Array.from(groupedMap.values());

        // Check for existing CashVouchers for each employee
        const employeeIds = groupedItems.map(item => item.employee_id);
        const existingVouchers = await commonQuery.findAllRecords(
            CashVoucher,
            {
                employee_id: { [Op.in]: employeeIds },
                attendance_date: {
                    [Op.between]: [startDate, endDate]
                },
                voucher_type: "OVERTIME"
            },
            {
                attributes: ["id", "employee_id", "attendance_date"],
                raw: true
            },
            null,
            true
        );

        // Create a map of employee_id to voucher_id
        const voucherMap = new Map();
        existingVouchers.forEach(voucher => {
            voucherMap.set(voucher.employee_id, voucher.id);
        });

        // Add cash_voucher_id to each employee item
        groupedItems.forEach(item => {
            item.cash_voucher_id = voucherMap.get(item.employee_id) || null;
        });

        // Manual Pagination
        const page = Math.max(parseInt(req.body.page) || 1, 1);
        const limit = parseInt(req.body.limit) || 10;
        const total = groupedItems.length;
        const totalPages = Math.ceil(total / limit);
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedItems = groupedItems.slice(startIndex, endIndex);

        return res.ok({
            items: paginatedItems,
            total,
            currentPage: page,
            pageSize: limit,
            totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
            appliedFilters: paginatedData.appliedFilters
        });
    } catch (err) {
        return handleError(err, res, req);
    }
}

exports.getCashVoucherById = async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) {
            return res.error("VALIDATION_ERROR", { message: "Voucher ID is required" });
        }

        const voucher = await commonQuery.findOneRecord(
            CashVoucher,
            id,
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "branch_id", "company_id"]
                    }
                ],
                attributes: [
                    "id", "employee_id", "attendance_day_id", "attendance_date", 
                    "voucher_type", "overtime_minutes", "amount", "overtime_data", 
                    "note", "status", "user_id", "branch_id", "company_id", 
                    "created_at", "updated_at"
                ]
            },
            null,
            true
        );

        if (!voucher) {
            return res.error("NOT_FOUND", { message: "Cash voucher not found" });
        }

        return res.ok({ voucher });
    } catch (err) {
        return handleError(err, res, req);
    }
}

exports.calculateCashVoucher = async (req, res) => {
    try {
        const { employee_id, month, year } = req.body;
        if (!employee_id || !month || !year) {
            return res.error("VALIDATION_ERROR", { message: "Employee ID, Month and Year are required" });
        }

        const startDate = dayjs(`${year}-${month}-01`).startOf('month').format('YYYY-MM-DD');
        const endDate = dayjs(`${year}-${month}-01`).endOf('month').format('YYYY-MM-DD');

        const attendanceDays = await commonQuery.findAllRecords(
            AttendanceDay,
            { // Filters
                employee_id,
                attendance_date: {
                    [Op.between]: [startDate, endDate]
                },
                overtime_data: { [Op.ne]: null }
            },
            { // Options
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        include: [
                            {
                                model: AttendanceTemplate,
                                as: "attendanceTemplate",
                                where: { include_overtime_in_total: false },
                                required: true,
                                attributes: ["id", "name", "include_overtime_in_total"]
                            }
                        ],
                        required: true,
                        attributes: ["id", "first_name", "employee_code", "branch_id", "company_id"]
                    }
                ],
                attributes: ["id", "employee_id", "attendance_date", "overtime_minutes", "overtime_data"],
                order: [["attendance_date", "ASC"]],
                raw: true,
                nest: true
            },
            null, // transaction
            true  // requireTenantFields
        );

        if (!attendanceDays.length) {
            return res.ok({ message: "No overtime records found or employee not eligible for cash vouchers", vouchers: [] });
        }

        // Process overtime data and filter out zero-minute entries
        const overtimeHistory = [];
        let totalOvertimeMinutes = 0;
        let totalAmount = 0;

        for (const day of attendanceDays) {
            const dayOtData = {
                attendance_date: day.attendance_date
            };

            let dayHasValidOvertime = false;

            // Process late_ot
            if (day.overtime_data?.late_ot && day.overtime_data.late_ot.minutes > 0) {
                dayOtData.late_ot = day.overtime_data.late_ot;
                totalAmount += parseFloat(day.overtime_data.late_ot.amount) || 0;
                totalOvertimeMinutes += day.overtime_data.late_ot.minutes || 0;
                dayHasValidOvertime = true;
            }

            // Process early_ot
            if (day.overtime_data?.early_ot && day.overtime_data.early_ot.minutes > 0) {
                dayOtData.early_ot = day.overtime_data.early_ot;
                totalAmount += parseFloat(day.overtime_data.early_ot.amount) || 0;
                totalOvertimeMinutes += day.overtime_data.early_ot.minutes || 0;
                dayHasValidOvertime = true;
            }

            if (dayHasValidOvertime) {
                overtimeHistory.push(dayOtData);
            }
        }

        if (overtimeHistory.length === 0) {
            return res.ok({ message: "No valid overtime records found", voucher: null });
        }

        // Create single CashVoucher record for the month
        const voucher = await commonQuery.createRecord(
            CashVoucher, {
                employee_id,
                attendance_day_id: attendanceDays[0].id,
                attendance_date: startDate,
                voucher_type: "OVERTIME",
                overtime_minutes: totalOvertimeMinutes,
                amount: parseFloat(totalAmount.toFixed(2)),
                overtime_data: overtimeHistory,
            }
        );
        
        return res.ok({cash_voucher_id:voucher.id});
    } catch (err) {
        return handleError(err, res, req);
    }
}