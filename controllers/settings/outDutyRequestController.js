const { validateRequest, commonQuery, handleError, Op, formatDateTime } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { sequelize, OutDutyRequest, User, Employee, EmployeeAttendanceTemplate, AttendanceTemplate, LeaveTemplate } = require("../../models");
const dayjs = require("dayjs");
const notificationService = require("../../services/notificationService");


exports.create = async (req, res) => {
const transaction = await sequelize.transaction();    
  try{

     const requiredFields = {
            employee_id: "Employee ID",
            start_date: "Start Date",
            end_date: "End Date",
            total_days: "Total Days",
        };

        if (!req.body.employee_id) {
            req.body.employee_id = req.user.employee_id
        }

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        // Check Employee's Attendance Template Settings
        const employee = await commonQuery.findOneRecord(Employee, req.body.employee_id, {
            include: [
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, transaction);

        const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
        if (template && template.enble_out_duty === false) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Out Duty requests are disabled for this employee's template." });
        }

        // Check if out_duty_approval_level is null, then set approval_status to 3 (APPROVED) directly
        let approvalStatus = constants.OUT_DUTY_STATUS.PENDING; // Default to pending
        if (template && template.out_duty_approval_level === null) {
            approvalStatus = constants.OUT_DUTY_STATUS.APPROVED; // Set to approved (3)
        }

        let { start_date, end_date, start_session, end_session } = req.body;
        const employee_id = req.body.employee_id;

        // 0=Full Day, 1=Session 1, 2=Session 2
        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;

        // Check for Overlapping Out Duty Requests
        const overlap = await commonQuery.findOneRecord(OutDutyRequest, {
            employee_id,
            approval_status: { [Op.notIn]: [constants.OUT_DUTY_STATUS.REJECTED, constants.OUT_DUTY_STATUS.CANCELLED, constants.OUT_DUTY_STATUS.DELETED] },
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [start_date, end_date] } },
                { end_date: { [Op.between]: [start_date, end_date] } },
                { [Op.and]: [{ start_date: { [Op.lte]: start_date } }, { end_date: { [Op.gte]: end_date } }] }
            ]
        }, {}, transaction);

        if (overlap) {
            await transaction.rollback();
            return res.error("OVERLAP", { message: `Selected dates overlap with an existing out-duty request (${formatDateTime(overlap.start_date)} to ${formatDateTime(overlap.end_date)})` });
        }

        await commonQuery.createRecord(
            OutDutyRequest,
            { ...req.body, start_session, end_session, approval_status: approvalStatus },
            transaction
        )

        await transaction.commit();
        return res.success(constants.SUCCESS, { message: "Out Duty request created successfully" });
  }
  catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
}

exports.getAll = async (req, res) => {
  try {

    const fieldConfig = [
    ["employee_id", true, true],
    ["start_date", true, true],
    ["end_date", true, true],
    ["total_days", false, true],
  ];

    // Add date filtering based on payload
    let whereClause = {};
    const leaveFilter = req.body?.leave_filter;
    
    if (leaveFilter) {
        const today = dayjs().toDate();
        
        switch (leaveFilter) {
            case 'previous':
                // Previous: ended before today
                whereClause.end_date = { [Op.lt]: today };
                break;
            case 'upcoming':
                // Upcoming: ends today or later
                whereClause.end_date = { [Op.gte]: today };
                break;
        }
    }

    const employeeWhere = { status: { [Op.in]: [0, 1, 2] } };

    if (!req.user.is_super_admin && !req.user.is_admin) {
        employeeWhere[Op.or] = [
            { attendance_supervisor: req.user.id },
            { reporting_manager: req.user.id }
        ];
    }

    const data = await commonQuery.fetchPaginatedData(
        OutDutyRequest, 
        {...req.body}, 
        fieldConfig, 
        {
          include: [
            {
              model: Employee,
              as: "employee",
              attributes: ["id", "first_name", "employee_code"],
              where: employeeWhere,
              required: true
            },
            {
              model: User,
              as: "approvedBy",
              attributes: ["id", "user_name"],
              required: false
            }
          ]
        },
        true, // requireTenantFields
        'created_at', // dateField
        whereClause // customWhere
    );
    
    return res.ok(data);
  } catch (err) {
    return handleError(err, res, req);
  }
}

// Get Single Request Details
exports.getById = async (req, res) => {
    try {
        const { id } = req.params;
        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id },{
          include: [
            {
              model: Employee,
              as: "employee",
              attributes: ["id", "first_name", "employee_code"],
              required: false
            },
            {
              model: User,
              as: "approvedBy",
              attributes: ["id", "user_name"],
              required: false
            }
          ]
        });

        if (!outDutyRequest) return res.error(constants.NOT_FOUND);

        return res.ok(outDutyRequest);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update Out Duty Request
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const requiredFields = {
            start_date: "Start Date",
            end_date: "End Date",
            total_days: "Total Days",
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {}, transaction);
        if (!outDutyRequest || outDutyRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (outDutyRequest.approval_status !== constants.OUT_DUTY_STATUS.PENDING && outDutyRequest.approval_status !== constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        let { start_date, end_date, start_session, end_session } = req.body;
        const employee_id = outDutyRequest.employee_id;

        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;
        const requestedTotal = parseFloat(req.body.total_days || 0);

        // Check Employee's Attendance Template Settings
        const employee = await commonQuery.findOneRecord(Employee, employee_id, {
            include: [
                { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
            ]
        }, transaction);

        const template = employee?.employeeAttendanceTemplate || employee?.attendanceTemplate;
        if (template && template.enble_out_duty === false) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "Out Duty requests are disabled for this employee's template." });
        }

        // Check for Overlapping Out Duty Requests (excluding current request)
        const overlap = await commonQuery.findOneRecord(OutDutyRequest, {
            employee_id,
            id: { [Op.ne]: id },
            approval_status: { [Op.notIn]: [constants.OUT_DUTY_STATUS.REJECTED, constants.OUT_DUTY_STATUS.CANCELLED, constants.OUT_DUTY_STATUS.DELETED] },
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [start_date, end_date] } },
                { end_date: { [Op.between]: [start_date, end_date] } },
                { [Op.and]: [{ start_date: { [Op.lte]: start_date } }, { end_date: { [Op.gte]: end_date } }] }
            ]
        }, {}, transaction);

        if (overlap) {
            await transaction.rollback();
            return res.error("OVERLAP", { message: `Selected dates overlap with an existing out-duty request (${formatDateTime(overlap.start_date)} to ${formatDateTime(overlap.end_date)})` });
        }

        const PUT = { 
            ...req.body, 
            start_session,
            end_session
        };

        await commonQuery.updateRecordById(OutDutyRequest, id, PUT, transaction);

        await transaction.commit();
        return res.success("OUT_DUTY_UPDATED");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get Pending Approvals
exports.getPendingApprovals = async (req, res) => {
    try {
        // Fetch all pending out-duty requests with employee and template details
        const requests = await commonQuery.fetchPaginatedData(
            OutDutyRequest, 
            req.body,
            [
                ["employee.first_name", true, true],
            ],
            {
                include: [
                    {
                        model: Employee,
                        as: "employee",
                        attributes: ["id", "first_name", "employee_code", "reporting_manager", "attendance_supervisor", "leave_template"],
                        include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
                    },
                    {
                        model: User,
                        as: "approvedBy",
                        attributes: ["id", "user_name"],
                        required: false
                    }
                ]
            },
            true,
            'created_at',
            {
                approval_status: { [Op.in]: [constants.OUT_DUTY_STATUS.PENDING, constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED] },
                status: 0
            }
        );

        // Apply authorization logic - only return requests user can approve
        const pendingForUser = [];
        for (const request of requests.items) {
            const employee = request.employee;
            if (!employee) continue;

            // Get leave template if employee has one (out-duty uses same template as leave)
            const template = employee?.leaveTemplate;
            const currentLevel = request.current_out_duty_level;
            const config = template ? (template.approval_config || []) : [];

            let currentStage = config.find(c => c.level === currentLevel);
            if (!currentStage) currentStage = { type: "ANYONE" };

            // Reset authorization for each request to prevent cross-contamination
            let isAuthorized = false;
            const isOwnRequest = (request.employee_id === req.user.employee_id);
            
            console.log("OutDuty Request:", request.id, "Employee:", employee.id, 
                       "User ID:", req.user.id, "Role:", req.user.role_id,
                       "Stage:", currentStage.type, "Config:", currentStage);
            
            if (req.user.is_super_admin && !isOwnRequest) {
                isAuthorized = true;
            } else {
                switch (currentStage.type) {
                    case 'REPORTING_MANAGER':
                        if ((req.user.role_key === constants.ROLE_KEYS.REPORTING_MANAGER || req.user.is_reporting_manager) && employee.reporting_manager === req.user.id) isAuthorized = true;
                        break;
                    case 'ATTENDANCE_SUPERVISOR':
                        if ((req.user.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR || req.user.is_attendance_supervisor) && employee.attendance_supervisor === req.user.id) isAuthorized = true;
                        break;
                    case 'ADMIN':
                        if (req.user.is_admin || req.user.is_super_admin) isAuthorized = true;
                        break;
                    case 'EMPLOYER':
                        if (req.user.is_admin || req.user.is_super_admin) isAuthorized = true;
                        break;
                    case 'ANYONE':
                        if (employee.reporting_manager === req.user.id ||
                            employee.attendance_supervisor === req.user.id ||
                            req.user.is_admin ||
                            req.user.is_super_admin) {
                            isAuthorized = true;
                        }
                        break;
                }
            }
            
            console.log("Request", request.id, "Authorized:", isAuthorized);
            
            if (isAuthorized) {
                const raw = request.get({ plain: true });
                raw.approved_by_name = raw.approvedBy?.user_name || null;
                pendingForUser.push(raw);
            }
        }

        return res.ok(pendingForUser);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update Status (Approve/Reject)
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { approval_status, remarks } = req.body;

        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {
            include: [{ model: Employee, as: "employee" }]
        }, transaction);
        if (!outDutyRequest) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        let newStatus = approval_status;
        let newLevel = outDutyRequest.current_out_duty_level;

        // Multi-level Approval Logic
        if (approval_status === constants.OUT_DUTY_STATUS.APPROVED) {
            const employee = await commonQuery.findOneRecord(Employee, outDutyRequest.employee_id, {
                include: [
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                ]
            }, transaction);

            const template = employee?.employeeAttendanceTemplate;
            const maxLevel = template ? (template.out_duty_approval_level || 1) : 1;
            
            if (req.user.is_super_admin) {
                newStatus = constants.OUT_DUTY_STATUS.APPROVED;
                newLevel = maxLevel;
            } else if (outDutyRequest.current_out_duty_level < maxLevel) {
                newStatus = constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED;
                newLevel = outDutyRequest.current_out_duty_level + 1;
            }
        }

        const history = outDutyRequest.approval_history || [];
        history.push({
            level: outDutyRequest.current_out_duty_level,
            action: approval_status === constants.OUT_DUTY_STATUS.APPROVED ? "APPROVED" : "REJECTED",
            by: req.user.id,
            at: new Date(),
            remarks: remarks || ""
        });

        await commonQuery.updateRecordById(OutDutyRequest, id, {
            approval_status: newStatus,
            current_out_duty_level: newLevel,
            approval_history: history,
            approved_by: req.user.id,
            approval_remark: remarks || ""
        }, transaction);

        // Send Notification to Employee
        const user = await commonQuery.findOneRecord(User, { employee_id: outDutyRequest.employee_id }, {}, transaction);
        if (user) {
            await notificationService.createNotification({
                user_id: user.id,
                title: newStatus === constants.OUT_DUTY_STATUS.APPROVED ? "Out Duty Approved" : (newStatus === constants.OUT_DUTY_STATUS.REJECTED ? "Out Duty Rejected" : "Out Duty Status Updated"),
                message: newStatus === constants.OUT_DUTY_STATUS.APPROVED 
                    ? `Your Out Duty request from ${formatDateTime(outDutyRequest.start_date, 'DD MMM')} to ${formatDateTime(outDutyRequest.end_date, 'DD MMM')} has been approved.` 
                    : `Your Out Duty request has been ${newStatus === constants.OUT_DUTY_STATUS.REJECTED ? 'rejected' : 'updated'}. ${remarks ? 'Remarks: ' + remarks : ''}`,
                type: "OUT_DUTY",
                reference_id: id,
                status_code: newStatus === constants.OUT_DUTY_STATUS.REJECTED ? 2 : 0,
                company_id: req.user.company_id,
                branch_id: req.user.branch_id
            }, transaction);
        }

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Cancel Out Duty Request
exports.cancelLeave = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const employeeId = req.user.employee_id;

        // 1. Fetch Request
        const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, { id }, {}, transaction);
        if (!outDutyRequest || outDutyRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 2. Authorization Check (Only owner can cancel via this API)
        if (outDutyRequest.employee_id !== employeeId && !req.user.is_super_admin) {
            await transaction.rollback();
            return res.error("UNAUTHORIZED", { message: "You can only cancel your own out duty requests" });
        }

        // 3. Status Check
        if (
            Number(outDutyRequest.approval_status) === constants.OUT_DUTY_STATUS.CANCELLED ||
            Number(outDutyRequest.approval_status) === constants.OUT_DUTY_STATUS.REJECTED
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: `Request is already processed` });
        }

        // 4. Update Status to Cancelled
        await commonQuery.updateRecordById(OutDutyRequest, id, {
            approval_status: constants.OUT_DUTY_STATUS.CANCELLED
        }, transaction);

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Get Out Duty Summary (History)
 * Grouped by Month for History
 */
exports.getOutDutySummary = async (req, res) => {
  try {
    let { employee_id } = req.body;
    if(!employee_id){
      employee_id = req.user.employee_id;
    }

    if (!employee_id) {
       return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
    }

    // 1. Fetch Out Duty Requests for History (Ordered by date)
    const history = await commonQuery.findAllRecords(OutDutyRequest, {
      employee_id,
      status: 0
    }, {
      include: [
        // Include approver user so we can show name in history
        {
          model: User,
          as: "approvedBy",
          attributes: ["id", "user_name"],
          required: false
        }
      ],
      order: [["start_date", "DESC"]]
    });

    // 2. Group History by Month
    const groupedHistory = [];
    history.forEach(outDuty => {
      const monthYear = formatDateTime(outDuty.start_date, "MMM, YYYY");
      let group = groupedHistory.find(g => g.month_label === monthYear);
      
      if (!group) {
        group = {
          month_label: monthYear,
          total_days: 0,
          out_duties: []
        };
        groupedHistory.push(group);
      }

      group.total_days += parseFloat(outDuty.total_days || 0);
      
      const start = dayjs(outDuty.start_date);
      const end = dayjs(outDuty.end_date);
      const dateRange = `${formatDateTime(outDuty.start_date, "D MMM, ddd")} - ${formatDateTime(outDuty.end_date, "D MMM, ddd")}`;

      const statusMap = {
        [constants.OUT_DUTY_STATUS.PENDING]: "PENDING",
        [constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
        [constants.OUT_DUTY_STATUS.APPROVED]: "APPROVED",
        [constants.OUT_DUTY_STATUS.REJECTED]: "REJECTED",
        [constants.OUT_DUTY_STATUS.CANCELLED]: "CANCELLED",
        [constants.OUT_DUTY_STATUS.DELETED]: "DELETED",
      };

      const colorMap = {
        [constants.OUT_DUTY_STATUS.APPROVED]: "#10B981",
        [constants.OUT_DUTY_STATUS.REJECTED]: "#EF4444",
        [constants.OUT_DUTY_STATUS.PENDING]: "#F59E0B",
        [constants.OUT_DUTY_STATUS.PARTIALLY_APPROVED]: "#3B82F6",
        [constants.OUT_DUTY_STATUS.CANCELLED]: "#6B7280",
        [constants.OUT_DUTY_STATUS.DELETED]: "#9CA3AF",
      };

      group.out_duties.push({
        id: outDuty.id,
        date_range: dateRange,
        duration_display: `${parseFloat(outDuty.total_days).toFixed(1)} Days | Out Duty`,
        reason: outDuty.reason || "",
        status_id: outDuty.approval_status,
        status: statusMap[outDuty.approval_status],
        status_color: colorMap[outDuty.approval_status] || "#F59E0B",
        approved_by: outDuty.approvedBy?.user_name || null,
        approval_remark: outDuty.approval_remark || ""
      });
    });

    // Calculate totals
    let totalUsed = 0;
    history.forEach(outDuty => {
      totalUsed += parseFloat(outDuty.total_days || 0);
    });

    return res.ok({
      out_duty_summary: {
        total_days_text: `${totalUsed.toFixed(1)} Days`,
        total_requests: history.length
      },
      out_duty_history: groupedHistory
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};

// Delete Out Duty Requests
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
        let { ids } = req.body; // Accept array of ids

        // Validate that ids is an array and not empty
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_ID);
        }

        const deleted = await commonQuery.hardDeleteRecords(OutDutyRequest, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }
        await transaction.commit();
        return res.success(constants.DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};