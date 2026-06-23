const { VisitorPass, Employee, CompanyMaster } = require("../models");
const commonQuery = require("../helpers/commonQuery");
const { handleError, sequelize, constants, Op, uploadFile, uploadBase64File } = require("../helpers");
const dayjs = require("dayjs");

exports.createPass = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const {
      visitor_name,
      visitor_phone,
      visitor_email,
      company_name,
      purpose,
      scheduled_start_time,
      scheduled_end_time,
      remarks,
      host_employee_id
    } = req.body;

    if (!visitor_name || !visitor_phone || !purpose) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "Missing required fields");
    }

    // Resolve host employee: employees can only host for themselves, admins/security/hr can host for anyone
    let resolvedHostEmployeeId = req.user?.employee_id;
    const isSecurityOrAdmin = req.user?.is_super_admin || (req.user?.RolePermission?.role_key && ["admin", "security", "hr"].includes(req.user.RolePermission.role_key.toLowerCase()));
    if (host_employee_id && (isSecurityOrAdmin || !resolvedHostEmployeeId)) {
      resolvedHostEmployeeId = host_employee_id;
    }

    if (!resolvedHostEmployeeId) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "A host employee is required");
    }

    // Generate unique pass code
    const datePart = dayjs().format("YYYYMMDD");
    const randPart = Math.floor(1000 + Math.random() * 9000);
    const passCode = `VP-${datePart}-${randPart}`;

    let visitorPhoto = null;
    if (req.file) {
      visitorPhoto = await uploadFile(req, res, "visitor_passes", transaction);
    } else if (req.body.visitor_photo) {
      visitorPhoto = await uploadBase64File(req.body.visitor_photo, "visitor_passes", transaction);
    }

    const passData = {
      visitor_photo: visitorPhoto,
      pass_code: passCode,
      visitor_name,
      visitor_phone,
      visitor_email,
      company_name,
      purpose,
      host_employee_id: resolvedHostEmployeeId,
      scheduled_start_time: scheduled_start_time ? new Date(scheduled_start_time) : null,
      scheduled_end_time: scheduled_end_time ? new Date(scheduled_end_time) : null,
      remarks,
      company_id: req.user?.company_id,
      branch_id: req.user?.branch_id || req.body.branch_id || 0,
      status: 0 // Scheduled
    };

    const visitorPass = await commonQuery.createRecord(VisitorPass, passData, transaction);
    await transaction.commit();

    return res.success("Visitor pass created successfully", visitorPass);
  } catch (error) {
    await transaction.rollback();
    console.error("Error in createPass:", error);
    return handleError(error, req, res);
  }
};

exports.getPasses = async (req, res) => {
  try {
    const { status, search, start_date, end_date } = req.query;
    const companyId = req.user?.company_id;

    const whereClause = {
      company_id: companyId
    };

    // If logged in user is a regular employee (not admin/security/HR), only show their hosted passes
    // Let's check role: if they have employee panel access, check if role is normal staff
    // For simplicity, we filter by host_employee_id if employee_id exists and user is not super admin
    const isSecurityOrAdmin = req.user?.is_super_admin || (req.user?.RolePermission?.role_key && ["admin", "security", "hr"].includes(req.user.RolePermission.role_key.toLowerCase()));
    
    if (!isSecurityOrAdmin && req.user?.employee_id) {
      whereClause.host_employee_id = req.user.employee_id;
    }

    if (status !== undefined && status !== "") {
      whereClause.status = parseInt(status);
    }

    if (start_date && end_date) {
      whereClause.scheduled_start_time = {
        [Op.between]: [new Date(start_date), new Date(end_date)]
      };
    }

    if (search) {
      whereClause[Op.or] = [
        { pass_code: { [Op.like]: `%${search}%` } },
        { visitor_name: { [Op.like]: `%${search}%` } },
        { visitor_phone: { [Op.like]: `%${search}%` } }
      ];
    }

    const passes = await commonQuery.findAllRecords(VisitorPass, whereClause, {
      include: [
        {
          model: Employee,
          as: "host",
          attributes: ["id", "first_name", "employee_code"]
        }
      ],
      order: [["scheduled_start_time", "DESC"]]
    });

    return res.success("Visitor passes fetched successfully", passes);
  } catch (error) {
    console.error("Error in getPasses:", error);
    return handleError(error, req, res);
  }
};

exports.getPassByCodeOrPhone = async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.error(constants.VALIDATION_ERROR, "Search query is required");
    }

    const companyId = req.user?.company_id;
    const pass = await commonQuery.findOneRecord(VisitorPass, {
      company_id: companyId,
      [Op.or]: [
        { pass_code: query },
        { visitor_phone: query }
      ]
    }, {
      include: [
        {
          model: Employee,
          as: "host",
          attributes: ["id", "first_name", "employee_code"]
        }
      ]
    });

    if (!pass) {
      return res.error(constants.NOT_FOUND, "Visitor pass not found");
    }

    return res.success("Visitor pass found", pass);
  } catch (error) {
    console.error("Error in getPassByCodeOrPhone:", error);
    return handleError(error, req, res);
  }
};

exports.punchIn = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const pass = await commonQuery.findOneRecord(VisitorPass, {
      id,
      company_id: req.user?.company_id
    }, {}, transaction);

    if (!pass) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, "Visitor pass not found");
    }

    if (pass.status !== 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "Visitor pass must be in Scheduled state to Punch In");
    }

    let visitorPhoto = pass.visitor_photo;
    if (req.file) {
      visitorPhoto = await uploadFile(req, res, "visitor_passes", transaction);
    } else if (req.body.visitor_photo) {
      visitorPhoto = await uploadBase64File(req.body.visitor_photo, "visitor_passes", transaction);
    }

    const updateData = {
      status: 1, // Checked In
      check_in_time: new Date()
    };
    if (visitorPhoto) {
      updateData.visitor_photo = visitorPhoto;
    }
    if (req.body.security_remarks) {
      updateData.security_remarks = req.body.security_remarks;
    }

    const updatedPass = await commonQuery.updateRecordById(VisitorPass, { id }, updateData, transaction);
    await transaction.commit();

    return res.success("Visitor checked in successfully", updatedPass);
  } catch (error) {
    await transaction.rollback();
    console.error("Error in punchIn:", error);
    return handleError(error, req, res);
  }
};

exports.punchOut = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const pass = await commonQuery.findOneRecord(VisitorPass, {
      id,
      company_id: req.user?.company_id
    }, {}, transaction);

    if (!pass) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, "Visitor pass not found");
    }

    if (pass.status !== 1) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "Visitor must be Checked In to Punch Out");
    }

    const updatedPass = await commonQuery.updateRecordById(VisitorPass, { id }, {
      status: 3, // Checked Out
      check_out_time: new Date()
    }, transaction);

    await transaction.commit();
    return res.success("Visitor checked out successfully", updatedPass);
  } catch (error) {
    await transaction.rollback();
    console.error("Error in punchOut:", error);
    return handleError(error, req, res);
  }
};

exports.updatePass = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const pass = await commonQuery.findOneRecord(VisitorPass, {
      id,
      company_id: req.user?.company_id
    }, {}, transaction);

    if (!pass) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, "Visitor pass not found");
    }

    const isSecurityOrAdmin = req.user?.is_super_admin || (req.user?.RolePermission?.role_key && ["admin", "security", "hr"].includes(req.user.RolePermission.role_key.toLowerCase()));
    if (!isSecurityOrAdmin && pass.host_employee_id !== req.user?.employee_id) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, "You do not have permission to edit this visitor pass");
    }

    if (pass.status !== 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "Only scheduled visitor passes can be edited");
    }

    const {
      visitor_name,
      visitor_phone,
      visitor_email,
      company_name,
      purpose,
      scheduled_start_time,
      scheduled_end_time,
      remarks
    } = req.body;

    const updateData = {};
    if (visitor_name) updateData.visitor_name = visitor_name;
    if (visitor_phone) updateData.visitor_phone = visitor_phone;
    if (visitor_email !== undefined) updateData.visitor_email = visitor_email;
    if (company_name !== undefined) updateData.company_name = company_name;
    if (purpose) updateData.purpose = purpose;
    if (scheduled_start_time) updateData.scheduled_start_time = new Date(scheduled_start_time);
    if (scheduled_end_time) updateData.scheduled_end_time = new Date(scheduled_end_time);
    if (remarks !== undefined) updateData.remarks = remarks;

    let visitorPhoto = null;
    if (req.file) {
      visitorPhoto = await uploadFile(req, res, "visitor_passes", transaction);
      updateData.visitor_photo = visitorPhoto;
    } else if (req.body.visitor_photo) {
      visitorPhoto = await uploadBase64File(req.body.visitor_photo, "visitor_passes", transaction);
      updateData.visitor_photo = visitorPhoto;
    }

    const updatedPass = await commonQuery.updateRecordById(VisitorPass, { id }, updateData, transaction);
    await transaction.commit();
    return res.success("Visitor pass updated successfully", updatedPass);
  } catch (error) {
    await transaction.rollback();
    console.error("Error in updatePass:", error);
    return handleError(error, req, res);
  }
};

exports.deletePass = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const pass = await commonQuery.findOneRecord(VisitorPass, {
      id,
      company_id: req.user?.company_id
    }, {}, transaction);

    if (!pass) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, "Visitor pass not found");
    }

    const isSecurityOrAdmin = req.user?.is_super_admin || (req.user?.RolePermission?.role_key && ["admin", "security", "hr"].includes(req.user.RolePermission.role_key.toLowerCase()));
    if (!isSecurityOrAdmin && pass.host_employee_id !== req.user?.employee_id) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, "You do not have permission to delete this visitor pass");
    }

    const updatedPass = await commonQuery.updateRecordById(VisitorPass, { id }, { status: 2 }, transaction);
    await transaction.commit();
    return res.success("Visitor pass deleted successfully", updatedPass);
  } catch (error) {
    await transaction.rollback();
    console.error("Error in deletePass:", error);
    return handleError(error, req, res);
  }
};

exports.cancelPass = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const pass = await commonQuery.findOneRecord(VisitorPass, {
      id,
      company_id: req.user?.company_id
    }, {}, transaction);

    if (!pass) {
      await transaction.rollback();
      return res.error(constants.NOT_FOUND, "Visitor pass not found");
    }

    const isSecurityOrAdmin = req.user?.is_super_admin || (req.user?.RolePermission?.role_key && ["admin", "security", "hr"].includes(req.user.RolePermission.role_key.toLowerCase()));
    if (!isSecurityOrAdmin && pass.host_employee_id !== req.user?.employee_id) {
      await transaction.rollback();
      return res.error(constants.FORBIDDEN, "You do not have permission to cancel this visitor pass");
    }

    if (pass.status !== 0) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "Only scheduled visitor passes can be cancelled");
    }

    const updatedPass = await commonQuery.updateRecordById(VisitorPass, { id }, { status: 4 }, transaction);
    await transaction.commit();
    return res.success("Visitor pass cancelled successfully", updatedPass);
  } catch (error) {
    await transaction.rollback();
    console.error("Error in cancelPass:", error);
    return handleError(error, req, res);
  }
};
