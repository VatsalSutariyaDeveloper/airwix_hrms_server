const { commonQuery, validateRequest, getCompanySetting } = require('../../helpers');
const { constants } = require('../../helpers/constants');
const { AttendanceApproval, CompanyConfigration, Employee, User, sequelize, Sequelize } = require('../../models');
const attendanceController = require('./attendanceController');
const { isUserAuthorizedForStage, resolvePendingApprovers } = require('../../helpers/approvalHelper');
const { Op } = Sequelize;

async function getAttendanceApprovalConfig(companyId) {
  const companySettings = await getCompanySetting(companyId);
  let maxLevel = 1;
  let configArray = [];

  if (companySettings) {
    let hasLevel =
      companySettings.attendance_approval_level !== undefined &&
      companySettings.attendance_approval_level !== null &&
      companySettings.attendance_approval_level !== '';

    if (hasLevel) {
      maxLevel = Number(companySettings.attendance_approval_level);
    }

    let config = companySettings.attendance_approval_config;
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        config = [];
      }
    }
    if (config && !Array.isArray(config) && typeof config === 'object' && Array.isArray(config.approval_config)) {
      config = config.approval_config;
    }
    if (Array.isArray(config)) {
      configArray = config;
    }

    if (!hasLevel && configArray.length > 0) {
      maxLevel = Math.max(...configArray.map(c => Number(c.level || 0)), 1);
    }
  }

  return { maxLevel, config: configArray };
}

async function checkAuthForAction(req, approvalReq) {
  const employee = approvalReq.employee;
  if (!employee) return false;
  const currentLevel = approvalReq.current_level || 1;
  const configData = await getAttendanceApprovalConfig(employee.company_id || req.user.company_id);
  const config = configData.config;

  let currentStage = config.find(c => parseInt(c.level, 10) === currentLevel);
  if (!currentStage) currentStage = { type: 'ANYONE' };

  let stageType = (currentStage.type || '').toString().toUpperCase();
  if (stageType === '3') stageType = 'REPORTING_MANAGER';
  if (stageType === '4') stageType = 'ATTENDANCE_SUPERVISOR';

  const isOwnRequest = approvalReq.employee_id === req.user.employee_id;
  return isUserAuthorizedForStage({
    user: req.user,
    employee,
    stageType,
    isOwnRequest,
  });
}

exports.listApprovals = async (req, res) => {
  try {
    const tab = req.body.tab || req.body.statusFilter || 'All';
    const filterStatus = req.body.filter?.approval_status;

    // Determine which approval_status values to fetch based on tab
    let approvalStatusFilter;
    if (tab === 'History') {
      approvalStatusFilter = { [Op.in]: [3, 4] }; // Approved + Rejected
    } else if (tab === 'Approved' || filterStatus === 3) {
      approvalStatusFilter = 3;
    } else if (tab === 'Rejected' || filterStatus === 4) {
      approvalStatusFilter = 4;
    } else if (tab === 'Pending' || filterStatus === 0) {
      approvalStatusFilter = { [Op.in]: [0, 1] }; // Pending + Partially Approved
    } else {
      // "All" tab — show everything except deleted
      approvalStatusFilter = { [Op.in]: [0, 1, 3, 4] };
    }

    const isHistory = tab === 'History' || tab === 'Approved' || tab === 'Rejected' || tab === 'All';
    let condition = {
      company_id: req.user.company_id,
      status: 0,
      approval_status: approvalStatusFilter,
    };

    const rows = await commonQuery.findAllRecords(AttendanceApproval, condition, {
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: [
            'id',
            'first_name',
            'employee_code',
            'profile_image',
            'reporting_manager',
            'attendance_supervisor',
            'company_id',
          ],
        },
        {
          model: User,
          as: 'approvedBy',
          attributes: ['id', 'user_name'],
          required: false,
        },
      ],
      order: [['created_at', 'DESC']],
      // Fetch all for in-memory filtering since it's dependent on multi-level config
    });

    // Apply authorization logic - only return requests user can approve
    const pendingForUser = [];
    for (const request of rows) {
      const employee = request.employee;
      if (!employee) continue;

      const raw = request.get({ plain: true });
      raw.approved_by_name = raw.approvedBy?.user_name || null;

      const { AttendanceDay } = require('../../models');
      const actualDay = await commonQuery.findOneRecord(AttendanceDay, {
        employee_id: request.employee_id,
        attendance_date: request.attendance_date
      });
      raw.actual_attendance_data = actualDay ? (typeof actualDay.get === 'function' ? actualDay.get({ plain: true }) : actualDay) : null;

      const currentLevel = request.current_level || 1;
      const configData = await getAttendanceApprovalConfig(employee.company_id || req.user.company_id);
      const config = configData.config;

      let currentStage = config.find(c => parseInt(c.level, 10) === currentLevel);
      if (!currentStage) currentStage = { type: 'ANYONE' };

      // Normalize stage type
      let stageType = (currentStage.type || '').toString().toUpperCase();
      if (stageType === '3') stageType = 'REPORTING_MANAGER';
      if (stageType === '4') stageType = 'ATTENDANCE_SUPERVISOR';

      const isOwnRequest = request.employee_id === req.user.employee_id;
      const isAuthorized = isUserAuthorizedForStage({
        user: req.user,
        employee,
        stageType,
        isOwnRequest,
      });

      // Resolve pending approver details
      const pendingDetails = await resolvePendingApprovers(raw, 'ATTENDANCE_APPROVAL');
      raw.pending_with = pendingDetails.pending_with;

      raw.is_pending_for_current_user = isAuthorized;

      if (isHistory) {
        const hasApprovedPreviously = raw.approval_history && raw.approval_history.some(h => h.user_id === req.user.id);
        const isSuperAdmin = (req.user.role_key === 'BUSINESS_ADMIN' && req.user.is_superadmin) || req.user.is_superadmin;
        const isAdmin = req.user.role_key === 'ADMIN' || req.user.is_admin || isSuperAdmin;

        if (isAuthorized || hasApprovedPreviously || isOwnRequest || isAdmin) {
          pendingForUser.push(raw);
        }
      } else {
        if (isAuthorized) {
          pendingForUser.push(raw);
        }
      }
    }

    return res.ok(pendingForUser);
  } catch (error) {
    console.error('listApprovals Error: ', error);
    return res.error(constants.SERVER_ERROR, error.message);
  }
};

exports.approveRequest = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const requiredFields = { request_id: 'Request ID' };
    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const approvalReq = await commonQuery.findOneRecord(
      AttendanceApproval,
      { id: req.body.request_id, company_id: req.user.company_id },
      {
        include: [
          {
            model: Employee,
            as: 'employee',
          },
        ],
      },
      t,
    );
    if (!approvalReq || ![0, 1].includes(approvalReq.approval_status)) {
      await t.rollback();
      return res.error(constants.NOT_FOUND_ERROR, 'Request not found or already processed');
    }

    const isAuthorized = await checkAuthForAction(req, approvalReq);
    if (!isAuthorized) {
      await t.rollback();
      return res.error(constants.UNAUTHORIZED_ERROR || 403, 'You are not authorized to approve this request at its current stage.');
    }

    // Fetch config for total levels
    const config = await commonQuery.findOneRecord(
      CompanyConfigration,
      {
        company_id: req.user.company_id,
        setting_key: 'attendance_approval_level',
      },
      {},
      t,
    );

    const maxLevel = config && config.setting_value ? parseInt(config.setting_value) : 1;
    const currentLevel = approvalReq.current_level || 1;

    let history = approvalReq.approval_history || [];
    history.push({
      level: currentLevel,
      user_id: req.user.id,
      date: new Date(),
      remark: req.body.remark || '',
    });

    let newStatus = currentLevel >= maxLevel ? 3 : 1; // 3 = APPROVED, 1 = PARTIALLY_APPROVED

    const dataupdate = await commonQuery.updateRecordById(
      AttendanceApproval,
      approvalReq.id,
      {
        approval_status: newStatus,
        current_level: currentLevel + 1,
        approval_history: history,
        approved_by: req.user.id,
        approval_remark: req.body.remark || '',
        ...(req.body.proposed_attendance_data && { proposed_attendance_data: req.body.proposed_attendance_data }),
      },
      t,
    );

    await t.commit();

    // Apply the JSON
    const finalProposedData = req.body.proposed_attendance_data || approvalReq.proposed_attendance_data;
    if (newStatus === 3 && finalProposedData) {
      // We simulate a request to updateAttendanceDay
      let simReq = {
        body: {
          ...finalProposedData,
          employee_id: approvalReq.employee_id || finalProposedData.employee_id,
          attendance_date: approvalReq.attendance_date || finalProposedData.attendance_date,
          is_approved_request: true,
        },
        user: { ...req.user },
        files: req.files || {},
      };

      let simRes = {
        success: (data, msg) => {
          console.log('Applied:', msg);
        },
        error: (code, err) => {
          console.error('Error applying:', err);
        },
      };

      const attendanceupdate = await attendanceController.updateAttendanceDay(simReq, simRes);

      try {
        const { rebuildAttendanceDay } = require('../../helpers/attendanceHelper');
        await rebuildAttendanceDay(
          approvalReq.employee_id,
          approvalReq.attendance_date,
          {
            user_id: req.user.id,
            company_id: req.user.company_id,
            branch_id: approvalReq.employee?.branch_id || req.user.branch_id
          }
        );
        console.log(`[ApprovalRebuild] Successfully rebuilt day for Employee ID ${approvalReq.employee_id} on ${approvalReq.attendance_date}`);
      } catch (rebuildErr) {
        console.error("[ApprovalRebuild] Failed to rebuild day:", rebuildErr.message);
      }
    }

    return res.success({}, 'Request approved successfully');
  } catch (error) {
    await t.rollback();
    console.error('approveRequest Error: ', error);
    return res.error(constants.SERVER_ERROR, error.message);
  }
};

exports.rejectRequest = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const requiredFields = { request_id: 'Request ID' };
    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const approvalReq = await commonQuery.findOneRecord(
      AttendanceApproval,
      { id: req.body.request_id, company_id: req.user.company_id },
      {
        include: [
          {
            model: Employee,
            as: 'employee',
          },
        ],
      },
      t,
    );

    if (!approvalReq || ![0, 1].includes(approvalReq.approval_status)) {
      await t.rollback();
      return res.error(constants.NOT_FOUND_ERROR, 'Request not found or already processed');
    }

    const isAuthorized = await checkAuthForAction(req, approvalReq);
    if (!isAuthorized) {
      await t.rollback();
      return res.error(constants.UNAUTHORIZED_ERROR || 403, 'You are not authorized to reject this request at its current stage.');
    }

    let history = approvalReq.approval_history || [];
    history.push({
      level: approvalReq.current_level,
      user_id: req.user.id,
      date: new Date(),
      remark: req.body.remark || 'Rejected',
    });

    await commonQuery.updateRecordById(
      AttendanceApproval,
      approvalReq.id,
      {
        approval_status: 4, // 4 = REJECTED
        approval_history: history,
        approved_by: req.user.id,
        approval_remark: req.body.remark || 'Rejected',
      },
      t,
    );

    await t.commit();
    return res.success({}, 'Request rejected successfully');
  } catch (error) {
    await t.rollback();
    console.error('rejectRequest Error: ', error);
    return res.error(constants.SERVER_ERROR, error.message);
  }
};
