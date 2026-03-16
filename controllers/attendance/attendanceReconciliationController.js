const { validateRequest, commonQuery, handleError } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { sequelize, AttendanceReconciliation, User, Employee, EmployeeAttendanceTemplate, AttendanceTemplate } = require("../../models");
const { rebuildAttendanceDay } = require("../../helpers/attendanceHelper");
const dayjs = require("dayjs");

// 1. Create Attendance Reconciliation Request
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();    
    try {
        const requiredFields = {
            employee_id: "Employee ID",
            attendance_date: "Attendance Date"
        };

        if (!req.body.employee_id) {
            req.body.employee_id = req.user.employee_id;
        }

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        await commonQuery.createRecord(
            AttendanceReconciliation,
            req.body,
            transaction
        );

        await transaction.commit();
        return res.success(constants.SUCCESS);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// 2. Get Attendance Reconciliation Summary (History)
exports.getAttendanceReconciliationSummary = async (req, res) => {
    try {
        let { employee_id } = req.body;
        if (!employee_id) {
            employee_id = req.user.employee_id;
        }

        if (!employee_id) {
            return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
        }

        // Fetch Requests for History (Ordered by date)
        const history = await commonQuery.findAllRecords(AttendanceReconciliation, {
            employee_id,
            status: 0
        }, {
            include: [
                {
                    model: User,
                    as: "approvedBy",
                    attributes: ["id", "user_name"],
                    required: false
                }
            ],
            order: [["attendance_date", "DESC"]]
        });

        // Group History by Month
        const groupedHistory = [];
        history.forEach(request => {
            const monthYear = dayjs(request.attendance_date).format("MMM, YYYY");
            let group = groupedHistory.find(g => g.month_label === monthYear);
            
            if (!group) {
                group = {
                    month_label: monthYear,
                    total_requests: 0,
                    reconciliations: []
                };
                groupedHistory.push(group);
            }

            group.total_requests += 1;
            
            const dateStr = dayjs(request.attendance_date).format("D MMM, ddd");

            const statusMap = {
                [constants.ATTENDANCE_RECONCILIATION_STATUS.PENDING]: "PENDING",
                [constants.ATTENDANCE_RECONCILIATION_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
                [constants.ATTENDANCE_RECONCILIATION_STATUS.APPROVED]: "APPROVED",
                [constants.ATTENDANCE_RECONCILIATION_STATUS.REJECTED]: "REJECTED",
                [constants.ATTENDANCE_RECONCILIATION_STATUS.CANCELLED]: "CANCELLED",
                [constants.ATTENDANCE_RECONCILIATION_STATUS.DELETED]: "DELETED",
            };

            group.reconciliations.push({
                id: request.id,
                date: dateStr,
                date_display: dateStr,
                reason: request.reason || "",
                status_id: request.approval_status,
                status: statusMap[request.approval_status],
                approved_by: request.approvedBy?.user_name || null
            });
        });

        return res.ok({
            reconciliation_summary: {
                total_requests_text: `${history.length} Requests`,
                total_requests: history.length
            },
            reconciliation_history: groupedHistory
        });

    } catch (err) {
        return handleError(err, res, req);
    }
};

// 3. Update Status (Approve/Reject)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, remarks } = req.body;

        const request = await commonQuery.findOneRecord(AttendanceReconciliation, { id }, {
            include: [{ model: Employee, as: "employee" }]
        }, transaction);

        if (!request) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        let newStatus = approval_status;
        let newLevel = request.current_level || 1;

        // Multi-level Approval Logic (Assuming same pattern if template defines it)
        if (Number(approval_status) === constants.ATTENDANCE_RECONCILIATION_STATUS.APPROVED) {
            const employee = await commonQuery.findOneRecord(Employee, request.employee_id, {
                include: [
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                    { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
                ]
            }, transaction);

            const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
            const maxLevel = template ? (template.attendance_reconciliation_approval_level || 1) : 1;

            if ((request.current_level || 1) < maxLevel) {
                newStatus = constants.ATTENDANCE_RECONCILIATION_STATUS.PARTIALLY_APPROVED;
                newLevel = (request.current_level || 1) + 1;
            }
        }

        const history = request.approval_history || [];
        history.push({
            level: request.current_level || 1,
            action: (Number(approval_status) === constants.ATTENDANCE_RECONCILIATION_STATUS.APPROVED) ? "APPROVED" : "REJECTED",
            by: req.user.id,
            at: new Date(),
            remarks: remarks || ""
        });

        await commonQuery.updateRecordById(AttendanceReconciliation, id, {
            approval_status: newStatus,
            current_level: newLevel,
            approval_history: history,
            approved_by: req.user.id
        }, transaction);

        // Rebuild attendance day if fully approved just like leave-request
        if (Number(newStatus) === constants.ATTENDANCE_RECONCILIATION_STATUS.APPROVED || newStatus === "APPROVED") {
            const attDate = dayjs(request.attendance_date).format('YYYY-MM-DD');
            await rebuildAttendanceDay(request.employee_id, attDate, { user_id: req.user?.id }, transaction);
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};
