const { VisitorPass, Employee, CompanyMaster, User, VisitorAttendance } = require("../models");
const commonQuery = require("../helpers/commonQuery");
const { handleError, sequelize, constants, Op, uploadFile, uploadBase64File } = require("../helpers");
const dayjs = require("dayjs");
const notificationService = require("../services/notificationService");

exports.createPass = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const {
      visitor_name,
      visitor_phone,
      visitor_email,
      company_name,
      company_phone,
      purpose,
      scheduled_start_time,
      scheduled_end_time,
      remarks,
      host_employee_id,
      visitor_type,
      valid_from,
      valid_to
    } = req.body;

    const type = visitor_type || "VISITOR";

    let visitorsList = [];
    if (req.body.visitors) {
      try {
        visitorsList = typeof req.body.visitors === "string"
          ? JSON.parse(req.body.visitors)
          : req.body.visitors;
      } catch (err) {
        console.error("Failed to parse visitors JSON in createPass:", err);
      }
    }

    let resolvedVisitorName = visitor_name;
    let resolvedVisitorPhone = visitor_phone;

    if (["CONTRACTOR", "TPI"].includes(type)) {
      if (!valid_from || !valid_to) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "Valid From and Valid To are required for Contractor/TPI");
      }
      if (!Array.isArray(visitorsList) || visitorsList.length === 0) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "At least one crew member is required for Contractor/TPI");
      }
      if (!company_name || !company_phone) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "Company Name and Company Phone are required for Contractor/TPI");
      }
      // Pass identity = the company/vendor, never a specific crew member
      resolvedVisitorName = company_name;
      resolvedVisitorPhone = company_phone;
    }

    if (!resolvedVisitorName || !resolvedVisitorPhone || !purpose) {
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
    let visitorDocument = null;
    let savedFiles = {};
    if (req.file || (req.files && Object.keys(req.files).length > 0)) {
      const uploadResult = await uploadFile(req, res, "visitor_passes", transaction);
      if (uploadResult) {
        savedFiles = uploadResult;
        visitorPhoto = uploadResult.visitor_photo || null;
        visitorDocument = uploadResult.visitor_document || null;
      }
    }

    if (req.body.visitor_photo) {
      visitorPhoto = await uploadBase64File(req.body.visitor_photo, "visitor_passes", transaction);
    }
    if (req.body.visitor_document) {
      visitorDocument = await uploadBase64File(req.body.visitor_document, "visitor_passes", transaction);
    }

    // For Contractor/TPI, resolve first crew member's photo before creating pass
    if (["CONTRACTOR", "TPI"].includes(type) && Array.isArray(visitorsList) && visitorsList.length > 0) {
      const fileKey = `visitors[0][photo]`;
      const fallbackFileKey = `visitors[0].photo`;
      let firstCrewPhoto = savedFiles[fileKey] || savedFiles[fallbackFileKey] || savedFiles[`visitors_photo_0`] || savedFiles[`visitors_photo[0]`] || null;

      if (!firstCrewPhoto && visitorsList[0].photo && visitorsList[0].photo.startsWith("data:")) {
        try {
          firstCrewPhoto = await uploadBase64File(visitorsList[0].photo, "visitor_passes", transaction);
          // Set in visitorsList so we don't re-upload it inside the loop
          visitorsList[0].photo = firstCrewPhoto;
        } catch (uploadErr) {
          console.error("Failed to upload base64 photo for first crew member:", uploadErr);
        }
      } else if (visitorsList[0].photo && !visitorsList[0].photo.startsWith("data:")) {
        firstCrewPhoto = visitorsList[0].photo;
      }

      // Default the main pass photo to the first crew member's photo if not provided
      if (!visitorPhoto) {
        visitorPhoto = firstCrewPhoto;
      }
    }

    const passData = {
      visitor_photo: visitorPhoto,
      visitor_document: visitorDocument,
      pass_code: passCode,
      visitor_name: resolvedVisitorName,
      visitor_phone: resolvedVisitorPhone,
      visitor_email,
      company_name,
      company_phone,
      purpose,
      host_employee_id: resolvedHostEmployeeId,
      scheduled_start_time: scheduled_start_time ? new Date(scheduled_start_time) : null,
      scheduled_end_time: scheduled_end_time ? new Date(scheduled_end_time) : null,
      remarks,
      company_id: req.user?.company_id,
      branch_id: req.user?.branch_id || req.body.branch_id || 0,
      visitor_type: type,
      valid_from: ["CONTRACTOR", "TPI"].includes(type) ? valid_from : null,
      valid_to: ["CONTRACTOR", "TPI"].includes(type) ? valid_to : null,
      status: 0 // Scheduled
    };

    const visitorPass = await commonQuery.createRecord(VisitorPass, passData, transaction);

    // Pre-register individuals
    if (["CONTRACTOR", "TPI"].includes(type) && Array.isArray(visitorsList) && visitorsList.length > 0) {
      for (let i = 0; i < visitorsList.length; i++) {
        const vis = visitorsList[i];
        if (vis.name && vis.phone) {
          // Check if there is an uploaded file for this index
          const fileKey = `visitors[${i}][photo]`;
          const fallbackFileKey = `visitors[${i}].photo`;
          let visPhoto = savedFiles[fileKey] || savedFiles[fallbackFileKey] || savedFiles[`visitors_photo_${i}`] || savedFiles[`visitors_photo[${i}]`] || null;

          if (!visPhoto && vis.photo && vis.photo.startsWith("data:")) {
            try {
              visPhoto = await uploadBase64File(vis.photo, "visitor_passes", transaction);
            } catch (uploadErr) {
              console.error("Failed to upload base64 photo for crew member:", uploadErr);
            }
          }
          await commonQuery.createRecord(VisitorAttendance, {
            visitor_pass_id: visitorPass.id,
            visitor_name: vis.name,
            visitor_phone: vis.phone,
            visitor_photo: visPhoto || (vis.photo && !vis.photo.startsWith("data:") ? vis.photo : null),
            status: 0 // Scheduled / Pending check-in
          }, transaction);
        }
      }
    }

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

    // Auto-expire/cancel passes whose scheduled_end_time has passed and status is still 0 (Scheduled)
    try {
      await VisitorPass.update(
        { status: 4 }, // Cancelled / Expired
        {
          where: {
            company_id: companyId,
            status: 0,
            scheduled_end_time: { [Op.lt]: new Date() }
          }
        }
      );
    } catch (expireErr) {
      console.error("Error auto-expiring visitor passes in getPasses:", expireErr);
    }

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
      const from = new Date(start_date);
      const to   = new Date(end_date);

      // Match either:
      //  (a) Scheduled passes whose scheduled_start_time falls within the selected day, OR
      //  (b) Contractor/TPI passes whose valid_from–valid_to range overlaps the selected day
      whereClause[Op.or] = [
        // (a) normal visitor: scheduled on this day
        { scheduled_start_time: { [Op.between]: [from, to] } },
        // (b) range-based pass: valid_from <= end_of_day AND valid_to >= start_of_day
        {
          valid_from: { [Op.lte]: to },
          valid_to:   { [Op.gte]: from }
        }
      ];
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
        },
        {
          model: VisitorAttendance,
          as: "attendances",
          required: false
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

    // Auto-expire/cancel passes whose scheduled_end_time has passed and status is still 0 (Scheduled)
    try {
      await VisitorPass.update(
        { status: 4 }, // Cancelled / Expired
        {
          where: {
            company_id: companyId,
            status: 0,
            scheduled_end_time: { [Op.lt]: new Date() }
          }
        }
      );
    } catch (expireErr) {
      console.error("Error auto-expiring visitor passes in getPassByCodeOrPhone:", expireErr);
    }

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

    const isMultiEntry = pass.visitor_type === "CONTRACTOR" || pass.visitor_type === "TPI";

    if (isMultiEntry) {
      if (pass.status !== 0 && pass.status !== 1 && pass.status !== 3) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "Visitor pass must be Scheduled, Checked In, or Checked Out to Punch In");
      }
      const today = dayjs().startOf('day');
      const validFrom = pass.valid_from ? dayjs(pass.valid_from).startOf('day') : null;
      const validTo = pass.valid_to ? dayjs(pass.valid_to).startOf('day') : null;

      if (validFrom && validTo) {
        if (today.isBefore(validFrom) || today.isAfter(validTo)) {
          await transaction.rollback();
          return res.error(constants.VALIDATION_ERROR, "Pass has expired or is not yet valid.");
        }
      }
    } else {
      if (pass.status !== 0) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "Visitor pass must be in Scheduled state to Punch In");
      }
    }

    let savedFiles = {};
    if (req.file || (req.files && Object.keys(req.files).length > 0)) {
      const uploadResult = await uploadFile(req, res, "visitor_passes", transaction);
      if (uploadResult) {
        savedFiles = uploadResult;
      }
    }

    let uploadedPhoto = savedFiles.visitor_photo || null;
    if (!uploadedPhoto && req.body.visitor_photo) {
      uploadedPhoto = await uploadBase64File(req.body.visitor_photo, "visitor_passes", transaction);
    }

    const updateData = {
      status: 1 // Checked In
    };
    if (req.body.security_remarks) {
      const newRemarks = req.body.security_remarks.trim();
      if (pass.security_remarks) {
        updateData.security_remarks = `${pass.security_remarks}, ${newRemarks}`;
      } else {
        updateData.security_remarks = newRemarks;
      }
    }
    if (!isMultiEntry) {
      updateData.check_in_time = new Date();
      if (uploadedPhoto) {
        updateData.visitor_photo = uploadedPhoto;
      }
    }

    const updatedPass = await commonQuery.updateRecordById(VisitorPass, { id }, updateData, transaction);

    if (isMultiEntry) {
      let checkedInList = [];
      if (req.body.checked_in_list) {
        try {
          checkedInList = typeof req.body.checked_in_list === "string"
            ? JSON.parse(req.body.checked_in_list)
            : req.body.checked_in_list;
        } catch (e) {
          console.error("Failed to parse checked_in_list:", e);
        }
      }

      // Fallback to single crew member for backward compatibility
      if (!Array.isArray(checkedInList) || checkedInList.length === 0) {
        if (!req.body.visitor_name || !req.body.visitor_phone) {
          await transaction.rollback();
          return res.error(constants.VALIDATION_ERROR, "Visitor name and phone are required for Contractor/TPI punch in.");
        }
        checkedInList = [{
          name: req.body.visitor_name,
          phone: req.body.visitor_phone,
          photo: req.body.visitor_photo || null,
          existing_photo: req.body.existing_photo || null
        }];
      }

      for (let i = 0; i < checkedInList.length; i++) {
        const member = checkedInList[i];
        if (member.name && member.phone) {
          // Check if photo was uploaded as binary
          const fileKey = `crew[${i}][photo]`;
          const fallbackFileKey = `crew[${i}].photo`;
          let memberPhoto = savedFiles[fileKey] || savedFiles[fallbackFileKey] || null;

          if (!memberPhoto && member.photo && member.photo.startsWith("data:")) {
            try {
              memberPhoto = await uploadBase64File(member.photo, "visitor_passes", transaction);
            } catch (uploadErr) {
              console.error("Failed to upload base64 check-in photo:", uploadErr);
            }
          }

          const finalCheckInPhoto = memberPhoto || member.existing_photo || null;

          // Check if already checked in to avoid duplicates
          const activeCheckIn = await commonQuery.findOneRecord(VisitorAttendance, {
            visitor_pass_id: pass.id,
            visitor_phone: member.phone,
            status: 1,
            check_out_time: null
          }, {}, transaction);

          if (!activeCheckIn) {
            const scheduledRecord = await commonQuery.findOneRecord(VisitorAttendance, {
              visitor_pass_id: pass.id,
              visitor_phone: member.phone,
              status: 0
            }, {}, transaction);

            if (scheduledRecord) {
              await commonQuery.updateRecordById(VisitorAttendance, { id: scheduledRecord.id }, {
                visitor_photo: finalCheckInPhoto,
                check_in_time: new Date(),
                security_remarks: req.body.security_remarks || null,
                status: 1
              }, transaction);
            } else {
              await commonQuery.createRecord(VisitorAttendance, {
                visitor_pass_id: pass.id,
                visitor_name: member.name,
                visitor_phone: member.phone,
                visitor_photo: finalCheckInPhoto,
                check_in_time: new Date(),
                security_remarks: req.body.security_remarks || null,
                status: 1
              }, transaction);
            }
          }
        }
      }
    }

    await transaction.commit();

    // Send instant notification to the host user
    try {
      const hostUser = await commonQuery.findOneRecord(User, {
        employee_id: pass.host_employee_id
      });
      if (hostUser && hostUser.id) {
        await notificationService.createNotification({
          user_id: hostUser.id,
          title: "Visitor Checked In",
          message: `${pass.visitor_name} has arrived to meet you.`,
          type: "VISITOR_CHECKED_IN",
          reference_id: pass.id,
          company_id: pass.company_id,
          branch_id: pass.branch_id
        });
      }
    } catch (notifError) {
      console.error("Error sending check-in notification to host:", notifError);
    }

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

    const isMultiEntry = pass.visitor_type === "CONTRACTOR" || pass.visitor_type === "TPI";

    if (pass.status !== 1) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "Visitor must be Checked In to Punch Out");
    }

    const updateData = {
      status: 3 // Checked Out
    };
    if (!isMultiEntry) {
      updateData.check_out_time = new Date();
    }

    const updatedPass = await commonQuery.updateRecordById(VisitorPass, { id }, updateData, transaction);

    if (isMultiEntry) {
      let checkedOutList = [];
      if (req.body.checked_out_list) {
        try {
          checkedOutList = typeof req.body.checked_out_list === "string"
            ? JSON.parse(req.body.checked_out_list)
            : req.body.checked_out_list;
        } catch (e) {
          console.error("Failed to parse checked_out_list:", e);
        }
      }

      if (Array.isArray(checkedOutList) && checkedOutList.length > 0) {
        for (const member of checkedOutList) {
          const activeAttendance = await commonQuery.findOneRecord(VisitorAttendance, {
            visitor_pass_id: pass.id,
            visitor_phone: member.phone,
            status: 1,
            check_out_time: null
          }, {}, transaction);

          if (activeAttendance) {
            await commonQuery.updateRecordById(VisitorAttendance, { id: activeAttendance.id }, {
              status: 3,
              check_out_time: new Date()
            }, transaction);
          }
        }
      } else {
        // Fallback: check out the most recent active check-in
        const activeAttendance = await commonQuery.findOneRecord(VisitorAttendance, {
          visitor_pass_id: pass.id,
          status: 1,
          check_out_time: null
        }, { order: [["check_in_time", "DESC"]] }, transaction);

        if (activeAttendance) {
          await commonQuery.updateRecordById(VisitorAttendance, { id: activeAttendance.id }, {
            status: 3,
            check_out_time: new Date()
          }, transaction);
        }
      }

      // Check if there are still any active checked-in crew members remaining inside
      const remainingActive = await VisitorAttendance.count({
        where: {
          visitor_pass_id: pass.id,
          status: 1,
          check_out_time: null
        },
        transaction
      });

      // If some crew members are still checked in, keep the parent pass status as Checked In (1)
      if (remainingActive > 0) {
        await commonQuery.updateRecordById(VisitorPass, { id }, { status: 1 }, transaction);
      }
    }

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
      company_phone,
      purpose,
      scheduled_start_time,
      scheduled_end_time,
      remarks,
      visitor_type,
      valid_from,
      valid_to
    } = req.body;

    const updateData = {};
    if (visitor_name) updateData.visitor_name = visitor_name;
    if (visitor_phone) updateData.visitor_phone = visitor_phone;
    if (visitor_email !== undefined) updateData.visitor_email = visitor_email;
    if (company_name !== undefined) updateData.company_name = company_name;
    if (company_phone !== undefined) updateData.company_phone = company_phone;
    if (purpose) updateData.purpose = purpose;
    if (scheduled_start_time) updateData.scheduled_start_time = new Date(scheduled_start_time);
    if (scheduled_end_time) updateData.scheduled_end_time = new Date(scheduled_end_time);
    if (remarks !== undefined) updateData.remarks = remarks;
    if (visitor_type) updateData.visitor_type = visitor_type;

    // If the visitor type is being updated to Contractor/TPI, enforce valid_from/to
    const type = visitor_type || pass.visitor_type;

    if (["CONTRACTOR", "TPI"].includes(type)) {
      if (valid_from) updateData.valid_from = valid_from;
      if (valid_to) updateData.valid_to = valid_to;
      if (!updateData.valid_from && !pass.valid_from) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "Valid From is required for Contractor/TPI");
      }
      if (!updateData.valid_to && !pass.valid_to) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "Valid To is required for Contractor/TPI");
      }

      const resolvedCompanyName = company_name !== undefined ? company_name : pass.company_name;
      const resolvedCompanyPhone = company_phone !== undefined ? company_phone : pass.company_phone;
      if (!resolvedCompanyName || !resolvedCompanyPhone) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "Company Name and Company Phone are required for Contractor/TPI");
      }
      updateData.visitor_name = resolvedCompanyName;
      updateData.visitor_phone = resolvedCompanyPhone;

      // Check for crew members
      let visitorsList = [];
      if (req.body.visitors) {
        try {
          visitorsList = typeof req.body.visitors === "string"
            ? JSON.parse(req.body.visitors)
            : req.body.visitors;
        } catch (err) {
          console.error("Failed to parse visitors JSON in updatePass:", err);
        }
      }

      const existingCrewCount = await VisitorAttendance.count({
        where: { visitor_pass_id: id },
        transaction
      });

      const totalCrewCount = existingCrewCount + (Array.isArray(visitorsList) ? visitorsList.length : 0);
      if (totalCrewCount === 0) {
        await transaction.rollback();
        return res.error(constants.VALIDATION_ERROR, "At least one crew member is required for Contractor/TPI");
      }
    } else {
      updateData.valid_from = null;
      updateData.valid_to = null;
    }

    let visitorPhoto = null;
    if (req.file || (req.files && Object.keys(req.files).length > 0)) {
      const uploadResult = await uploadFile(req, res, "visitor_passes", transaction);
      visitorPhoto = (uploadResult && uploadResult.visitor_photo) ? uploadResult.visitor_photo : uploadResult;
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

exports.getPublicPass = async (req, res) => {
  try {
    const { id } = req.params;
    const pass = await commonQuery.findOneRecord(VisitorPass, { id }, {
      include: [
        {
          model: Employee,
          as: "host",
          attributes: ["id", "first_name", "employee_code"]
        }
      ]
    }, null, false, false);

    if (!pass) {
      return res.error(constants.NOT_FOUND, "Visitor pass not found");
    }

    return res.success("Visitor pass found", pass);
  } catch (error) {
    console.error("Error in getPublicPass:", error);
    return handleError(error, req, res);
  }
};

exports.sendPass = async (req, res) => {
  try {
    const { id } = req.params;
    const pass = await commonQuery.findOneRecord(VisitorPass, {
      id,
      company_id: req.user?.company_id
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

    const hostName = pass.host?.first_name || "Employee";
    const startTimeFormatted = pass.scheduled_start_time ? dayjs(pass.scheduled_start_time).format("DD-MM-YYYY hh:mm A") : "N/A";
    const publicLink = `${process.env.FRONTEND_URL || "http://localhost:5173/"}visitor/pass/${pass.id}`;

    const message = `Hello ${pass.visitor_name},
Your visitor pass for meeting ${hostName} has been generated.
Scheduled Time: ${startTimeFormatted}
Pass Code: ${pass.pass_code}

Please download your pass using the link below:
${publicLink}`;

    // Send WhatsApp
    const { sendWhatsappMessage } = require("../helpers/whatsappService");
    await sendWhatsappMessage(pass.visitor_phone, message);

    // Send SMS (Log to console)
    console.log(`\n--- [SMS SEND LOG] ---`);
    console.log(`To: ${pass.visitor_phone}`);
    console.log(`Message: ${message}`);
    console.log(`----------------------\n`);

    return res.success("Visitor pass sent successfully", { message });
  } catch (error) {
    console.error("Error in sendPass:", error);
    return handleError(error, req, res);
  }
};

