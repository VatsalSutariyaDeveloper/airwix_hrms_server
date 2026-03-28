const { validateRequest, commonQuery, handleError, Op } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { sequelize, OnDutyRequest, User, Employee, EmployeeAttendanceTemplate, AttendanceTemplate, LeaveTemplate } = require("../../models");
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
        if (template && template.enble_on_duty === false) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "On Duty requests are disabled for this employee's template." });
        }

        // Check if on_duty_approval_level is null, then set approval_status to 3 (APPROVED) directly
        let approvalStatus = constants.ON_DUTY_STATUS.PENDING; // Default to pending
        if (template && template.on_duty_approval_level === null) {
            approvalStatus = constants.ON_DUTY_STATUS.APPROVED; // Set to approved (3)
        }

        let { start_date, end_date, start_session, end_session } = req.body;
        const employee_id = req.body.employee_id;

        // 0=Full Day, 1=Session 1, 2=Session 2
        start_session = parseInt(start_session) || 0;
        end_session = parseInt(end_session) || 0;

        // Check for Overlapping On Duty Requests
        const overlap = await commonQuery.findOneRecord(OnDutyRequest, {
            employee_id,
            approval_status: { [Op.notIn]: [constants.ON_DUTY_STATUS.REJECTED, constants.ON_DUTY_STATUS.CANCELLED, constants.ON_DUTY_STATUS.DELETED] },
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [start_date, end_date] } },
                { end_date: { [Op.between]: [start_date, end_date] } },
                { [Op.and]: [{ start_date: { [Op.lte]: start_date } }, { end_date: { [Op.gte]: end_date } }] }
            ]
        }, {}, transaction);

        if (overlap) {
            await transaction.rollback();
            return res.error("OVERLAP", { message: `Selected dates overlap with an existing on-duty request (${dayjs(overlap.start_date).format('YYYY-MM-DD')} to ${dayjs(overlap.end_date).format('YYYY-MM-DD')})` });
        }

        await commonQuery.createRecord(
            OnDutyRequest,
            { ...req.body, start_session, end_session, approval_status: approvalStatus },
            transaction
        )

        await transaction.commit();
        return res.success(constants.SUCCESS, { message: "On duty request created successfully" });
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

    const data = await commonQuery.fetchPaginatedData(
        OnDutyRequest, 
        {...req.body}, 
        fieldConfig, 
        {
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
        const onDutyRequest = await commonQuery.findOneRecord(OnDutyRequest, { id },{
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

        if (!onDutyRequest) return res.error(constants.NOT_FOUND);

        return res.ok(onDutyRequest);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update On Duty Request
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

        const onDutyRequest = await commonQuery.findOneRecord(OnDutyRequest, { id }, {}, transaction);
        if (!onDutyRequest || onDutyRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        if (onDutyRequest.approval_status !== constants.ON_DUTY_STATUS.PENDING && onDutyRequest.approval_status !== constants.ON_DUTY_STATUS.PARTIALLY_APPROVED) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: "Only pending or partially approved requests can be updated" });
        }

        let { start_date, end_date, start_session, end_session } = req.body;
        const employee_id = onDutyRequest.employee_id;

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
        if (template && template.enble_on_duty === false) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, { message: "On Duty requests are disabled for this employee's template." });
        }

        // Check for Overlapping On Duty Requests (excluding current request)
        const overlap = await commonQuery.findOneRecord(OnDutyRequest, {
            employee_id,
            id: { [Op.ne]: id },
            approval_status: { [Op.notIn]: [constants.ON_DUTY_STATUS.REJECTED, constants.ON_DUTY_STATUS.CANCELLED, constants.ON_DUTY_STATUS.DELETED] },
            status: 0,
            [Op.or]: [
                { start_date: { [Op.between]: [start_date, end_date] } },
                { end_date: { [Op.between]: [start_date, end_date] } },
                { [Op.and]: [{ start_date: { [Op.lte]: start_date } }, { end_date: { [Op.gte]: end_date } }] }
            ]
        }, {}, transaction);

        if (overlap) {
            await transaction.rollback();
            return res.error("OVERLAP", { message: `Selected dates overlap with an existing on-duty request (${dayjs(overlap.start_date).format('YYYY-MM-DD')} to ${dayjs(overlap.end_date).format('YYYY-MM-DD')})` });
        }

        const PUT = { 
            ...req.body, 
            start_session,
            end_session
        };

        await commonQuery.updateRecordById(OnDutyRequest, id, PUT, transaction);

        await transaction.commit();
        return res.success("ON_DUTY_UPDATED");
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get Pending Approvals
exports.getPendingApprovals = async (req, res) => {
    try {
        // Fetch all pending on-duty requests with employee and template details
        const requests = await commonQuery.findAllRecords(
            OnDutyRequest, 
            {
                approval_status: { [Op.in]: [constants.ON_DUTY_STATUS.PENDING, constants.ON_DUTY_STATUS.PARTIALLY_APPROVED] },
                status: 0
            },
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
            }
        );

        // Apply authorization logic - only return requests user can approve
        const pendingForUser = [];
        for (const request of requests) {
            const employee = request.employee;
            if (!employee) continue;

            // Get leave template if employee has one (on-duty uses same template as leave)
            const template = employee?.leaveTemplate;
            const currentLevel = request.current_on_duty_level;
            const config = template ? (template.approval_config || []) : [];

            let currentStage = config.find(c => c.level === currentLevel);
            if (!currentStage) currentStage = { type: "ANYONE" };

            // Reset authorization for each request to prevent cross-contamination
            let isAuthorized = false;
            
            console.log("OnDuty Request:", request.id, "Employee:", employee.id, 
                       "User ID:", req.user.id, "Role:", req.user.role_id,
                       "Stage:", currentStage.type, "Config:", currentStage);
            
            if (req.user.is_super_admin) {
                isAuthorized = true;
            } else {
                switch (currentStage.type) {
                    case 'REPORTING_MANAGER':
                        if (req.user.role_id === constants.REPORTING_MANAGER_ROLE_ID && employee.reporting_manager === req.user.id) isAuthorized = true;
                        break;
                    case 'ATTENDANCE_SUPERVISOR':
                        if (req.user.role_id === constants.ATTENDANCE_SUPERVISOR_ROLE_ID && employee.attendance_supervisor === req.user.id) isAuthorized = true;
                        break;
                    case 'ADMIN':
                        if (req.user.is_admin) isAuthorized = true;
                        break;
                    case 'EMPLOYER':
                        isAuthorized = true;
                        break;
                    case 'ANYONE':
                        if (employee.reporting_manager === req.user.id ||
                            employee.attendance_supervisor === req.user.id ||
                            req.user.is_admin) {
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

        const onDutyRequest = await commonQuery.findOneRecord(OnDutyRequest, { id }, {
            include: [{ model: Employee, as: "employee" }]
        }, transaction);
        if (!onDutyRequest) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        let newStatus = approval_status;
        let newLevel = onDutyRequest.current_on_duty_level;

        // Multi-level Approval Logic
        if (approval_status === constants.ON_DUTY_STATUS.APPROVED) {
            const employee = await commonQuery.findOneRecord(Employee, onDutyRequest.employee_id, {
                include: [
                    { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
                ]
            }, transaction);

            const template = employee?.employeeAttendanceTemplate;
            const maxLevel = template ? (template.on_duty_approval_level || 1) : 1;
            
            if (req.user.is_super_admin) {
                newStatus = constants.ON_DUTY_STATUS.APPROVED;
                newLevel = maxLevel;
            } else if (onDutyRequest.current_on_duty_level < maxLevel) {
                newStatus = constants.ON_DUTY_STATUS.PARTIALLY_APPROVED;
                newLevel = onDutyRequest.current_on_duty_level + 1;
            }
        }

        const history = onDutyRequest.approval_history || [];
        history.push({
            level: onDutyRequest.current_on_duty_level,
            action: approval_status === constants.ON_DUTY_STATUS.APPROVED ? "APPROVED" : "REJECTED",
            by: req.user.id,
            at: new Date(),
            remarks: remarks || ""
        });

        await commonQuery.updateRecordById(OnDutyRequest, id, {
            approval_status: newStatus,
            current_on_duty_level: newLevel,
            approval_history: history,
            approved_by: req.user.id,
            approval_remark: remarks || ""
        }, transaction);

        // Send Notification to Employee
        const user = await commonQuery.findOneRecord(User, { employee_id: onDutyRequest.employee_id }, {}, transaction);
        if (user) {
            await notificationService.createNotification({
                user_id: user.id,
                title: newStatus === constants.ON_DUTY_STATUS.APPROVED ? "On Duty Approved" : (newStatus === constants.ON_DUTY_STATUS.REJECTED ? "On Duty Rejected" : "On Duty Status Updated"),
                message: newStatus === constants.ON_DUTY_STATUS.APPROVED 
                    ? `Your On Duty request from ${dayjs(onDutyRequest.start_date).format('DD MMM')} to ${dayjs(onDutyRequest.end_date).format('DD MMM')} has been approved.` 
                    : `Your On Duty request has been ${newStatus === constants.ON_DUTY_STATUS.REJECTED ? 'rejected' : 'updated'}. ${remarks ? 'Remarks: ' + remarks : ''}`,
                type: "ON_DUTY",
                reference_id: id,
                status_code: newStatus === constants.ON_DUTY_STATUS.REJECTED ? 2 : 0,
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

// Cancel On Duty Request
exports.cancelLeave = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const employeeId = req.user.employee_id;

        // 1. Fetch Request
        const onDutyRequest = await commonQuery.findOneRecord(OnDutyRequest, { id }, {}, transaction);
        if (!onDutyRequest || onDutyRequest.status === 2) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        // 2. Authorization Check (Only owner can cancel via this API)
        if (onDutyRequest.employee_id !== employeeId && !req.user.is_super_admin) {
            await transaction.rollback();
            return res.error("UNAUTHORIZED", { message: "You can only cancel your own on duty requests" });
        }

        // 3. Status Check
        if (
            Number(onDutyRequest.approval_status) === constants.ON_DUTY_STATUS.CANCELLED ||
            Number(onDutyRequest.approval_status) === constants.ON_DUTY_STATUS.REJECTED
        ) {
            await transaction.rollback();
            return res.error("INVALID_OPERATION", { message: `Request is already processed` });
        }

        // 4. Update Status to Cancelled
        await commonQuery.updateRecordById(OnDutyRequest, id, {
            approval_status: constants.ON_DUTY_STATUS.CANCELLED
        }, transaction);

        await transaction.commit();
        return res.success(constants.UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Get On Duty Summary (History)
 * Grouped by Month for History
 */
exports.getOnDutySummary = async (req, res) => {
  try {
    let { employee_id } = req.body;
    if(!employee_id){
      employee_id = req.user.employee_id;
    }

    if (!employee_id) {
       return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
    }

    // 1. Fetch On Duty Requests for History (Ordered by date)
    const history = await commonQuery.findAllRecords(OnDutyRequest, {
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
    history.forEach(onDuty => {
      const monthYear = dayjs(onDuty.start_date).format("MMM, YYYY");
      let group = groupedHistory.find(g => g.month_label === monthYear);
      
      if (!group) {
        group = {
          month_label: monthYear,
          total_days: 0,
          on_duties: []
        };
        groupedHistory.push(group);
      }

      group.total_days += parseFloat(onDuty.total_days || 0);
      
      const start = dayjs(onDuty.start_date);
      const end = dayjs(onDuty.end_date);
      const dateRange = `${start.format("D MMM, ddd")} - ${end.format("D MMM, ddd")}`;

      const statusMap = {
        [constants.ON_DUTY_STATUS.PENDING]: "PENDING",
        [constants.ON_DUTY_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
        [constants.ON_DUTY_STATUS.APPROVED]: "APPROVED",
        [constants.ON_DUTY_STATUS.REJECTED]: "REJECTED",
        [constants.ON_DUTY_STATUS.CANCELLED]: "CANCELLED",
        [constants.ON_DUTY_STATUS.DELETED]: "DELETED",
      };

      const colorMap = {
        [constants.ON_DUTY_STATUS.APPROVED]: "#10B981",
        [constants.ON_DUTY_STATUS.REJECTED]: "#EF4444",
        [constants.ON_DUTY_STATUS.PENDING]: "#F59E0B",
        [constants.ON_DUTY_STATUS.PARTIALLY_APPROVED]: "#3B82F6",
        [constants.ON_DUTY_STATUS.CANCELLED]: "#6B7280",
        [constants.ON_DUTY_STATUS.DELETED]: "#9CA3AF",
      };

      group.on_duties.push({
        id: onDuty.id,
        date_range: dateRange,
        duration_display: `${parseFloat(onDuty.total_days).toFixed(1)} Days | On Duty`,
        reason: onDuty.reason || "",
        status_id: onDuty.approval_status,
        status: statusMap[onDuty.approval_status],
        status_color: colorMap[onDuty.approval_status] || "#F59E0B",
        approved_by: onDuty.approvedBy?.user_name || null,
        approval_remark: onDuty.approval_remark || ""
      });
    });

    // Calculate totals
    let totalUsed = 0;
    history.forEach(onDuty => {
      totalUsed += parseFloat(onDuty.total_days || 0);
    });

    return res.ok({
      on_duty_summary: {
        total_days_text: `${totalUsed.toFixed(1)} Days`,
        total_requests: history.length
      },
      on_duty_history: groupedHistory
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};
