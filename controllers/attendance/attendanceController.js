const { punch, manualPunch, rebuildAttendanceDay, getOrCreateAttendanceDay, syncAttendanceToLeaveBalance, bulkSyncAttendanceDays } = require("../../helpers/attendanceHelper");
const { validateRequest, commonQuery, handleError, uploadFile, uploadBase64File } = require("../../helpers");
const { constants } = require("../../helpers/constants");
const { Employee, AttendanceDay, AttendancePunch, LeaveRequest, LeaveTemplateCategory, Sequelize, sequelize, ShiftTemplate, EmployeeHoliday, User, RolePermission, EmployeeWeeklyOff, EmployeeLeaveBalance, ShiftBreak, EmployeeAttendanceTemplate, AttendanceTemplate, LeaveTemplate, HolidayTransaction, WeeklyOffTemplateDay, DeviceMaster, OutDutyRequest, Department, DesignationMaster, BranchMaster, Holiday, EmployeeSalaryTemplate, FaceRecognitionError, CompanyMaster, AttendanceRegularization, AttendanceApproval, CompanyConfigration, CompanySettings } = require("../../models");
const fs = require("fs");
const path = require("path");
const { Op } = Sequelize;
const dayjs = require("dayjs");
const customParseFormat = require('dayjs/plugin/customParseFormat');
const LeaveBalanceService = require("../../services/leaveBalanceService");
const notificationService = require("../../services/notificationService");
const { getCompanySetting } = require("../../helpers");

dayjs.extend(customParseFormat);
const syncedTenants = new Set();
async function ensureFaceRecognitionErrorSynced(tenantPrefix) {
  const cacheKey = `${tenantPrefix || 'default'}_FaceRecognitionError`;
  if (!syncedTenants.has(cacheKey)) {
    try {
      await FaceRecognitionError.sync({ alter: true });
      syncedTenants.add(cacheKey);
    } catch (syncErr) {
      console.error("Failed to sync FaceRecognitionError table on demand:", syncErr.message);
    }
  }
}


// Cosine similarity (0..1) for two equal-length numeric vectors.
function adaptiveCosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─────────────────────────────────────────────────────────────────────────────
// ALIGNED FACE TEMPLATES (v2 devices) — stored in employees.aligned_face_templates
// (own JSONB column; face_descriptor is never touched by this flow)
// ─────────────────────────────────────────────────────────────────────────────
const ALIGNED_TEMPLATES = {
  maxPerEmployee: 8,   // server keeps more than the device cap (5) as shared pool
  dupSimilarity: 0.97, // skip near-identical vectors
};

// Lazy column creation — no migration needed, idempotent per tenant DB.
async function ensureAlignedTemplatesColumn() {
  await sequelize.query(
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS aligned_face_templates JSONB'
  );
  await sequelize.query(
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS aligned_face_images JSONB'
  );
}

/**
 * SYNC ALIGNED FACE TEMPLATES (v2 attendance devices)
 * Multipart: templates[i][employee_id], templates[i][vector] (JSON string),
 *            templates[i][image] (optional face image for audit trail)
 */
exports.saveFaceTemplates = async (req, res) => {
  try {
    await ensureAlignedTemplatesColumn();
  } catch (colErr) {
    console.error("ensureAlignedTemplatesColumn failed:", colErr.message);
  }
  try {
    // Parse indexed form fields: templates[0][employee_id], templates[0][vector], etc.
    const items = [];
    if (Array.isArray(req.body.templates)) {
      // Standard JSON array (backward compat)
      for (const t of req.body.templates) items.push(t);
    } else if (req.body.templates && typeof req.body.templates === 'object') {
      // Indexed form fields → object keyed by index
      for (const idx of Object.keys(req.body.templates)) {
        items.push(req.body.templates[idx]);
      }
    } else {
      // Flat indexed fields like templates[0][employee_id] parsed by body-parser
      const map = {};
      for (const key of Object.keys(req.body)) {
        const m = key.match(/^templates\[(\d+)]\[(\w+)]$/);
        if (m) {
          const i = m[1];
          if (!map[i]) map[i] = {};
          map[i][m[2]] = req.body[key];
        }
      }
      for (const idx of Object.keys(map)) items.push(map[idx]);
    }

    if (items.length === 0) {
      return res.error(constants.VALIDATION_ERROR, { message: "No templates provided" });
    }

    // Build a lookup for uploaded images: fieldname → file buffer
    const imageMap = {};
    const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : [];
    for (const file of files) {
      imageMap[file.fieldname] = file;
    }

    let saved = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const empId = parseInt(item.employee_id);
      let vec = item.vector;
      if (typeof vec === 'string') {
        try { vec = JSON.parse(vec); } catch (e) { vec = null; }
      }
      if (!empId || !Array.isArray(vec) || vec.length < 10 || Array.isArray(vec[0])) continue;

      const employee = await commonQuery.findOneRecord(Employee, { id: empId }, {}, null, false, {});
      if (!employee) continue;

      let list = Array.isArray(employee.aligned_face_templates)
        ? [...employee.aligned_face_templates] : [];
      let imgList = Array.isArray(employee.aligned_face_images)
        ? [...employee.aligned_face_images] : [];
      // Ensure parallel arrays are same length (pad with null if out of sync)
      while (imgList.length < list.length) imgList.push(null);

      let dup = false;
      for (const t of list) {
        if (adaptiveCosineSim(vec, t) >= ALIGNED_TEMPLATES.dupSimilarity) { dup = true; break; }
      }
      if (dup) continue;

      // Save the face image for audit trail
      let savedFilename = null;
      const imageFile = imageMap[`templates[${i}][image]`];
      const destDir = path.join(process.cwd(), "uploads", constants.EMPLOYEE_IMG_FOLDER || "employee/images/");
      if (imageFile && imageFile.buffer && imageFile.buffer.length > 0) {
        const ext = path.extname(imageFile.originalname || '.jpg').toLowerCase() || '.jpg';
        savedFilename = `${Date.now()}_aligned_${empId}${ext}`.replace(/[\/:*?"<>|]/g, "_");
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, savedFilename), imageFile.buffer);
        console.log(`[AlignedTemplates] 📸 Emp #${empId}: saved audit image ${savedFilename}`);
      }

      list.push(vec);
      imgList.push(savedFilename);

      // Evict oldest when over cap — delete the evicted image from disk
      while (list.length > ALIGNED_TEMPLATES.maxPerEmployee) {
        list.shift();
        const evictedImg = imgList.shift();
        if (evictedImg) {
          const evictPath = path.join(destDir, evictedImg);
          try {
            if (fs.existsSync(evictPath)) {
              fs.unlinkSync(evictPath);
              console.log(`[AlignedTemplates] 🗑️ Emp #${empId}: evicted image ${evictedImg}`);
            }
          } catch (e) {
            console.error(`[AlignedTemplates] Failed to delete evicted image ${evictedImg}:`, e.message);
          }
        }
      }

      const empUpdateData = {
        aligned_face_templates: list,
        aligned_face_images: imgList,
      };
      employee.changed('aligned_face_templates', true);
      employee.changed('aligned_face_images', true);

      await employee.update(empUpdateData);
      saved++;
      console.log(`[AlignedTemplates] ✅ Emp #${empId} (${employee.first_name || ''}): template saved — now ${list.length}/${ALIGNED_TEMPLATES.maxPerEmployee}${list.length >= 2 ? ' (MIGRATED to aligned matching)' : ''}`);
    }

    return res.success(constants.ACTION_SUCCESSFUL, { saved });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * PUNCH (IN/OUT)
 */
exports.attendancePunch = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const requiredFields = {
      employee_id: "Employee"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    // Handle image upload if provided
    let punchImage = null;
    if (req.files && (req.files.image || req.files['image'])) {
      const savedFiles = await uploadFile(
        req,
        res,
        constants.ATTENDANCE_FOLDER,
        t
      );
      punchImage = savedFiles.image || savedFiles['image'];

      if (!punchImage) {
        await t.rollback();
        return res.error(constants.SERVER_ERROR, { message: "Image upload failed" });
      }
    }

    // --- [FIX] Resolve Device ID for Attendance Devices ---
    let resolvedDeviceId = req.body.device_id || null;
    if (req.user && ['attendance', 'canteen'].includes(req.user.access)) {
      const device = await commonQuery.findOneRecord(DeviceMaster, { user_id: req.user.id }, { attributes: ["id"] }, t, false, {});
      resolvedDeviceId = device ? device.id : req.user.id; // Fallback to User ID if not found
    }

    let companyId = req.user?.company_id || req.body.company_id || null;
    let branchId = req.user?.branch_id || req.body.branch_id || null;

    if (!companyId || !branchId) {
      const emp = await commonQuery.findOneRecord(Employee, { id: req.body.employee_id }, { attributes: ["company_id", "branch_id"] }, t, false, {});
      if (emp) {
        if (!companyId) companyId = emp.company_id;
        if (!branchId) branchId = emp.branch_id;
      }
    }

    const result = await punch(
      req.body.employee_id,
      {
        ...req.body,
        user_id: req.user?.access === 'attendance' ? null : (req.user?.id || null),
        company_id: companyId,
        branch_id: branchId,
        ip_address: req.ip,
        latitude: req.body.latitude || null,
        longitude: req.body.longitude || null,
        device_id: resolvedDeviceId,
        image_name: punchImage,
        access: req.user?.access || 'master-admin'
      }, t);

    await t.commit();
    return res.success(constants.ACTION_SUCCESSFUL, result);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * SYNC PUNCHES (Offline Sync)
 */
exports.syncPunches = async (req, res) => {
  await ensureFaceRecognitionErrorSynced(req.tenantPrefix);
  const transaction = await sequelize.transaction();
  try {
    const { punches } = req.body;

    if (!punches || !Array.isArray(punches)) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, "Punches array is required");
    }

    console.log(`[SyncPunches] Received ${punches.length} punches from device/app.`);
    console.log(`[SyncPunches] User Context: ID=${req.user?.id}, Access=${req.user?.access}, Company=${req.user?.company_id}`);

    // Resolve Device ID once for the entire sync batch
    let resolvedDeviceId = null;
    console.log("req.user", req.user)
    if (req.user?.access && ['attendance', 'canteen'].includes(req.user.access)) {
      const device = await commonQuery.findOneRecord(DeviceMaster, { user_id: req.user.id }, { attributes: ["id"] }, transaction, false, {});
      resolvedDeviceId = device ? device.id : req.user.id;
      console.log(`[SyncPunches] Resolved DeviceMaster ID: ${resolvedDeviceId} from User ID: ${req.user.id}`);
    }

    // Sort punches by time to ensure sequential processing (crucial for auto-toggle logic and night shifts)
    const sortedPunches = punches
      .filter(p => p.employee_id && p.punch_time)
      .sort((a, b) => dayjs(a.punch_time).valueOf() - dayjs(b.punch_time).valueOf());

    console.log(`[SyncPunches] After filtering/sorting: ${sortedPunches.length} valid punches to process.`);

    const results = [];
    for (const punchData of sortedPunches) {
      delete punchData.punch_type;
      console.log(`\n--- [Sync] Processing Punch: Emp=${punchData.employee_id}, Time=${punchData.punch_time} ---`);
      console.log(`\n--- [Sync] Processing Punch:`, punchData);

      try {
        // Check if a punch with the exact same time already exists for this employee to prevent duplicate syncs
        const targetPunchTime = new Date(punchData.punch_time);
        const existingPunch = await commonQuery.findOneRecord(AttendancePunch, {
          employee_id: punchData.employee_id,
          punch_time: targetPunchTime,
          status: { [Op.ne]: 2 }
        }, {}, transaction, false, {});

        // if (existingPunch) {
        //   console.log(`[SyncPunches] Duplicate punch detected and skipped: Emp=${punchData.employee_id}, Time=${punchData.punch_time}`);
        //   results.push({
        //     employee_id: punchData.employee_id,
        //     punch_time: punchData.punch_time,
        //     success: true,
        //     punch_id: existingPunch.id,
        //     type: existingPunch.punch_type,
        //     ignoredAsDuplicate: true
        //   });
        //   continue;
        // }

        // Handle sync image if provided (usually as base64 in offline sync)
        let punchImage = null;
        if (punchData.image && punchData.image.trim() !== "") {
          punchImage = await uploadBase64File(punchData.image, constants.ATTENDANCE_FOLDER, transaction);
        }

        let punchCompanyId = req.user?.company_id || req.body.company_id || punchData.company_id || null;
        let punchBranchId = req.user?.branch_id || req.body.branch_id || punchData.branch_id || null;

        if (!punchCompanyId || !punchBranchId) {
          const emp = await commonQuery.findOneRecord(Employee, { id: punchData.employee_id }, { attributes: ["company_id", "branch_id"] }, transaction, false, {});
          if (emp) {
            if (!punchCompanyId) punchCompanyId = emp.company_id;
            if (!punchBranchId) punchBranchId = emp.branch_id;
          }
        }

        const result = await punch(
          punchData.employee_id,
          {
            ...punchData,
            user_id: req.user?.access === 'attendance' ? null : (req.user?.id || null),
            company_id: punchCompanyId,
            branch_id: punchBranchId,
            ip_address: punchData.ip_address || req.ip,
            latitude: punchData.latitude || null,
            longitude: punchData.longitude || null,
            device_id: resolvedDeviceId || (punchData.device_id || null),
            image_name: punchImage,
            face_descriptor: punchData.face_vector || punchData.face_descriptor || null,
            match_score: punchData.match_score || null,
            bypassGapCheck: true,
            skipRebuild: false,
            access: req.user?.access || 'master-admin'
          },
          transaction
        );

        // Store face recognition error if flag is present
        console.log(`[SyncPunches] Face Recognition Error detected for Emp=${punchData.employee_id}. Storing in FaceRecognitionError...`);

        let faceErrorImage = null;
        if (punchImage) {
          try {
            const srcPath = path.join(process.cwd(), "uploads", constants.ATTENDANCE_FOLDER, punchImage);
            const destDir = path.join(process.cwd(), "uploads", constants.FACE_ERROR_FOLDER || "employee/face_errors/");
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true, mode: 0o777 });
            }
            const destPath = path.join(destDir, punchImage);
            fs.copyFileSync(srcPath, destPath);
            faceErrorImage = punchImage;
            console.log(`[SyncPunches] Successfully copied punch image to face recognition errors folder: ${punchImage}`);
          } catch (copyErr) {
            console.error("[SyncPunches] Failed to copy punch image, falling back to base64 upload:", copyErr.message);
          }
        }

        if (!faceErrorImage && punchData.image && punchData.image.trim() !== "") {
          faceErrorImage = await uploadBase64File(punchData.image, constants.FACE_ERROR_FOLDER || "employee/face_errors/", transaction);
        }

        await commonQuery.createRecord(FaceRecognitionError, {
          image: faceErrorImage || punchImage,
          accuracy: punchData.match_score || punchData.accuracy || null,
          time: punchData.punch_time ? dayjs(punchData.punch_time).toDate() : new Date(),
          company_id: req.user.company_id || punchData.company_id || 0,
          branch_id: req.user.branch_id || punchData.branch_id || 0,
          employee_id: punchData.employee_id || null,
          latitude: punchData.latitude ? parseFloat(punchData.latitude) : null,
          longitude: punchData.longitude ? parseFloat(punchData.longitude) : null,
          status: 1,
          matches: punchData.matches ? (typeof punchData.matches === 'string' ? JSON.parse(punchData.matches) : punchData.matches) : null,
          message: punchData.message || null
        }, transaction);

        console.log(`[SyncPunches] ✅ Stored FaceRecognitionError as Resolved for Emp=${punchData.employee_id}`);

        results.push({
          employee_id: punchData.employee_id,
          punch_time: punchData.punch_time,
          success: true,
          punch_id: result.punchId,
          type: result.punchType
        });
        console.log(`[SyncPunches] ✅ Success for Emp: ${punchData.employee_id} - PunchID: ${result.punchId}, Type: ${result.punchType}`);
      } catch (punchErr) {
        console.error(`[SyncPunches] ❌ FAILED for Emp: ${punchData.employee_id}:`, punchErr);
        const errMsg = String(punchErr.message || "");

        // Classified by TYPE, not message: Sequelize/DB errors are transient
        // system failures → fail the batch so the device retries everything.
        const isSystemError = punchErr.name && String(punchErr.name).startsWith("Sequelize");
        if (isSystemError) {
          await transaction.rollback();
          return handleError(punchErr, res, req);
        }

        // Everything else is a business rejection (Already Punched, shift
        // window, cooldown, leave block, ...). These are NOT face recognition
        // errors — the face was recognized fine, the punch was just blocked
        // for operational reasons. Don't pollute the face errors table.
        console.warn(`[SyncPunches] ⛔ REJECTED punch for Emp ${punchData.employee_id}: ${errMsg}`);
        results.push({
          employee_id: punchData.employee_id,
          punch_time: punchData.punch_time,
          success: false,
          error: errMsg,
          code: "REJECTED"
        });
        continue;
      }
    }

    await transaction.commit();
    return res.success(constants.ACTION_SUCCESSFUL, {
      sync_summary: {
        total_received: punches.length,
        total_processed: results.length,
        success_count: results.filter(r => r.success).length,
        fail_count: results.filter(r => !r.success).length
      },
      results
    });
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * GET SUMMARY for a specific date
 */
exports.getAttendanceSummary = async (req, res) => {
  try {

    const requiredFields = {
      date: "Date",
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { date, staff_type, shift_id, page, limit, search, filter } = req.body;
    const targetDate = date || dayjs().format("YYYY-MM-DD");
    const effectiveStatus = filter?.attendance_status !== undefined ? filter.attendance_status : -1;

    const consolidatedFilter = { ...(filter || {}) };
    delete consolidatedFilter.attendance_status;

    // Filter by role
    if (req.user.is_attendance_supervisor === true) {
      consolidatedFilter.attendance_supervisor = req.user.id;
    }

    if (req.user.is_reporting_manager === true) {
      consolidatedFilter.reporting_manager = req.user.id;
    }

    // 1. Prepare base filters for Employee list
    if (staff_type) consolidatedFilter.employee_type = staff_type;
    if (shift_id) consolidatedFilter.shift_template = shift_id;

    const joiningDateFilter = {
      [Op.and]: [
        {
          [Op.or]: [
            { joining_date: { [Op.lte]: targetDate } },
            { joining_date: null }
          ]
        }
      ]
    };

    if (effectiveStatus === 14) {
      joiningDateFilter[Op.and].push({
        [Op.or]: [
          { '$attendanceDays.status$': 14 },
          { '$attendanceDays.status$': null },
          { '$attendanceDays.id$': null }
        ]
      });
    }

    // Create a shared employee filter for all summary queries
    const employeeWhere = {
      ...consolidatedFilter,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id,
      [Op.and]: [...joiningDateFilter[Op.and]]
    };

    if (search) {
      employeeWhere[Op.and].push({
        [Op.or]: [
          { first_name: { [Op.iLike]: `%${search}%` } },
          { employee_code: { [Op.iLike]: `%${search}%` } }
        ]
      });
    }

    // 1.5 AUTO-SYNC: Create records for WO/Holiday/Leave if missing
    // This allows them to show up in summary and list immediately.

    // try {
    //     const isPastOrToday = dayjs(targetDate).isBefore(dayjs().add(1, 'day'), 'day');
    //     if (isPastOrToday) {
    //         const employeesToSync = await commonQuery.findAllRecords(
    //             Employee,
    //             employeeWhere,
    //             { attributes: ['id', 'company_id', 'branch_id', "joining_date"] },
    //             null,
    //         );


    //         if (employeesToSync.length > 0) {
    //           await bulkSyncAttendanceDays(
    //             employeesToSync.map(e => e.id),
    //             targetDate,
    //             {
    //               user_id: req.user.id,
    //               company_id: req.user.company_id,
    //               branch_id: req.user.branch_id
    //             }
    //           );
    //         }
    //     }
    // } catch (syncErr) {
    //     console.error("Attendance Auto-Sync Error:", syncErr);
    // }

    // 2. FETCH PAGINATED LIST & SUMMARY (Combined using window functions)
    const summaryAttributes = [
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status IN (0, 7, 12) THEN 1 END) OVER()`), 'summary_present'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status IN (1, 13) THEN 1 END) OVER()`), 'summary_halfday'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status = 3 THEN 1 END) OVER()`), 'summary_weeklyoff'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status = 4 THEN 1 END) OVER()`), 'summary_holiday'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status = 6 THEN 1 END) OVER()`), 'summary_leave'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status = 5 THEN 1 END) OVER()`), 'summary_absent'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status = 9 THEN 1 END) OVER()`), 'summary_incomplete'],
      [sequelize.literal(`SUM(COALESCE("attendanceDays".overtime_minutes, 0)) OVER()`), 'summary_total_ot'],
      [sequelize.literal(`SUM(COALESCE("attendanceDays".fine_minutes, 0)) OVER()`), 'summary_total_fine'],
      [sequelize.literal(`SUM(COALESCE("attendanceDays".fine_amount, 0)) OVER()`), 'summary_total_fine_amount'],
      [sequelize.literal(`SUM(COALESCE("attendanceDays".overtime_amount, 0)) OVER()`), 'summary_total_overtime_amount'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".first_in IS NOT NULL THEN 1 END) OVER()`), 'summary_punched_in'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".last_out IS NOT NULL THEN 1 END) OVER()`), 'summary_punched_out'],
      [sequelize.literal(`COUNT(CASE WHEN "attendanceDays".status = 0 AND "attendanceDays".first_in IS NOT NULL THEN 1 END) OVER()`), 'summary_short_presence'],
      [sequelize.literal(`COUNT("attendanceDays".id) OVER()`), 'summary_total_accounted'],
    ];

    const fieldConfig = [
      ["first_name", true, true],
      ["employee_code", true, true],
    ];

    const employeesResult = await commonQuery.fetchPaginatedData(
      Employee,
      { ...req.body, status: 0, filter: consolidatedFilter },
      fieldConfig,
      {
        include: [
          {
            model: AttendanceDay,
            as: "attendanceDays",
            required: effectiveStatus !== -1 && effectiveStatus !== 14,
            where: {
              attendance_date: targetDate,
              ...(effectiveStatus === -1
                ? { status: { [Op.ne]: 2 } }
                : effectiveStatus === 14
                  ? {}
                  : { status: effectiveStatus }),
            },
            duplicating: false,
            include: [
              {
                model: AttendancePunch,
                as: "attendancePunches",
                include: [
                  {
                    model: BranchMaster,
                    as: "branch",
                    attributes: ["id", "branch_name"]
                  }
                ],
                required: false,
                separate: true,
                order: [["punch_time", "ASC"]]
              },
              {
                model: LeaveTemplateCategory,
                as: "leaveCategory",
                attributes: ["id", "leave_category_name"],
                required: false
              },
              {
                model: ShiftTemplate,
                as: "shiftTemplate",
                attributes: ["id", "shift_name", "start_time", "end_time"],
                include: [{ model: ShiftBreak, as: "ShiftBreaks" }]
              },
              {
                model: BranchMaster,
                as: "branch",
                attributes: ["id", "branch_name"]
              }
            ]
          },
          {
            model: ShiftTemplate,
            as: "shiftTemplate",
            attributes: ["id", "shift_name", "start_time", "end_time"],
            include: [{ model: ShiftBreak, as: "ShiftBreaks" }]
          },
          { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
          { model: AttendanceTemplate, as: "attendanceTemplate", required: false }
        ],
        order: [
          [sequelize.literal(`"attendanceDays"."updated_at"`), 'DESC NULLS LAST'],
          ['first_name', 'ASC']
        ],
        attributes: [
          'id', 'first_name', 'profile_image', 'employee_code', 'employee_type', 'worker_type', 'shift_template', 'status', 'holiday_template', 'weekly_off_template', "branch_id", "access_branches",
          ...summaryAttributes
        ],
        subQuery: false // Required for window functions to work correctly with pagination
      },
      { company_id: true },
      "createdAt",
      joiningDateFilter
    );

    // 2.5 Identify WO/Holiday for the paginated items
    const itemIds = employeesResult.items.map(e => e.id);
    if (itemIds.length > 0) {
      const dayOfWeek = dayjs(targetDate).day();
      const weekNo = Math.ceil(dayjs(targetDate).date() / 7);

      const [itemHolidays, itemWeeklyOffs, itemOutDuties, itemLeaves, itemApprovals] = await Promise.all([
        commonQuery.findAllRecords(EmployeeHoliday, {
          employee_id: { [Op.in]: itemIds },
          date: targetDate,
          status: 0
        }),
        commonQuery.findAllRecords(EmployeeWeeklyOff, {
          employee_id: { [Op.in]: itemIds },
          day_of_week: dayOfWeek,
          status: 0,
          is_off: true,
          [Op.or]: [{ week_no: 0 }, { week_no: weekNo }]
        }),
        commonQuery.findAllRecords(OutDutyRequest, {
          employee_id: { [Op.in]: itemIds },
          approval_status: constants.OUT_DUTY_STATUS.APPROVED,
          start_date: { [Op.lte]: targetDate },
          end_date: { [Op.gte]: targetDate },
          status: 0
        }),
        commonQuery.findAllRecords(LeaveRequest, {
          employee_id: { [Op.in]: itemIds },
          approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
          start_date: { [Op.lte]: targetDate },
          end_date: { [Op.gte]: targetDate },
          request_type: 'DEBIT',
          is_encashment: false,
          status: 0
        }, {
          include: [{ model: LeaveTemplateCategory, as: 'category', attributes: ['id', 'leave_category_name'] }]
        }),
        commonQuery.findAllRecords(AttendanceApproval, {
          employee_id: { [Op.in]: itemIds },
          attendance_date: targetDate,
          company_id: req.user.company_id,
          status: 0
        })
      ]);

      const itemHolidayMap = new Set(itemHolidays.map(h => h.employee_id));
      const itemWeeklyOffMap = new Set(itemWeeklyOffs.map(w => w.employee_id));
      const itemOutDutyMap = new Set(itemOutDuties.map(o => o.employee_id));
      const itemApprovalsMap = new Map(itemApprovals.map(a => [a.employee_id, a]));

      employeesResult.items.forEach(emp => {
        if (emp.profile_image) {
          emp.setDataValue('profile_image_url', `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${emp.profile_image}`);
        } else {
          emp.setDataValue('profile_image_url', null);
        }

        const approval = itemApprovalsMap.get(emp.id);
        if (approval) {
          emp.setDataValue('approval_status', approval.approval_status);
          emp.setDataValue('approval_id', approval.id);
          emp.setDataValue('approval_reason', approval.reason);
          emp.setDataValue('proposed_attendance_data', approval.proposed_attendance_data);
        }

        const day = emp.attendanceDays?.[0];
        if (day) {
          const isOutDutyApproved = itemOutDutyMap.has(emp.id);
          const approvedLeave = itemLeaves.find(l => l.employee_id === emp.id);

          day.setDataValue('is_scheduled_holiday', itemHolidayMap.has(emp.id));
          day.setDataValue('is_scheduled_weekly_off', itemWeeklyOffMap.has(emp.id));
          day.setDataValue('is_out_duty_approved', isOutDutyApproved);
          day.setDataValue('is_leave_approved', !!approvedLeave);
          day.setDataValue('branch_name', day.branch?.branch_name);

          // Enhanced Status Text logic (Same as monthly summary)
          const statusMap = { 0: "Present", 1: "Half Day", 3: "Weekly Off", 4: "Holiday", 5: "Absent", 6: "Leave", 7: "Overtime", 10: "Miss Punch", 12: "Out Duty", 13: "Half Out Duty", 14: "Not Marked" };
          let statusText = statusMap[day.status] || "Pending";

          if (isOutDutyApproved && approvedLeave) {
            const leaveCategoryName = approvedLeave.category?.leave_category_name || "Leave";
            statusText = `Out Duty / ${leaveCategoryName}`;
            day.setDataValue('leaveCategory', approvedLeave.category);
          } else if (isOutDutyApproved) {
            statusText = "Out Duty";
          } else {
            if (day.status === 4) {
              const h = itemHolidays.find(h => h.employee_id === emp.id);
              statusText = h ? h.name : "Holiday";
            } else if (day.status === 6) {
              statusText = day.leaveCategory?.leave_category_name || "Leave";
            } else if (day.status === 1 && day.leaveCategory?.leave_category_name) {
              statusText = `Half Day / ${day.leaveCategory.leave_category_name}`;
            } else if (day.status === 0 && day.leaveCategory?.leave_category_name) {
              statusText = day.leaveCategory.leave_category_name;
            }
          }
          day.setDataValue('status_text', statusText);

          // Map employee and worker type labels
          const employeeTypeMap = { 1: "Staff", 2: "Worker", 3: "Contractor" };
          const workerTypeMap = { 1: "On-role", 2: "Off-role" };
          emp.setDataValue('employee_type_label', employeeTypeMap[emp.employee_type] || 'N/A');
          emp.setDataValue('worker_type_label', workerTypeMap[emp.worker_type] || 'N/A');

          if (day.first_in) {
            const punches = day.attendancePunches || [];
            const firstInPunch = punches.find(p => p.punch_type === 'IN' && dayjs(p.punch_time).format('HH:mm:ss') === day.first_in);
            day.first_in_full = firstInPunch ? firstInPunch.punch_time : dayjs(`${day.attendance_date} ${day.first_in}`).toDate();
          }
          if (day.last_out) {
            const punches = day.attendancePunches || [];
            const lastOutPunch = [...punches].reverse().find(p => p.punch_type === 'OUT' && dayjs(p.punch_time).format('HH:mm:ss') === day.last_out);
            day.last_out_full = lastOutPunch ? lastOutPunch.punch_time : dayjs(`${day.attendance_date} ${day.last_out}`).toDate();
          }
          if (day.attendancePunches) {
            day.attendancePunches.sort((a, b) => new Date(a.punch_time) - new Date(b.punch_time));
          }
        }
      });
    }

    // 3. EXTRACT SUMMARY FROM RESULTS
    const totalStaff = employeesResult.total;
    const firstItem = employeesResult.items[0];

    let summary = {
      totalStaff,
      present: parseInt(firstItem?.getDataValue('summary_present') || 0),
      absent: parseInt(firstItem?.getDataValue('summary_absent') || 0),
      halfDay: parseInt(firstItem?.getDataValue('summary_halfday') || 0),
      weeklyOff: parseInt(firstItem?.getDataValue('summary_weeklyoff') || 0),
      holiday: parseInt(firstItem?.getDataValue('summary_holiday') || 0),
      leave: parseInt(firstItem?.getDataValue('summary_leave') || 0),
      shortPresence: parseInt(firstItem?.getDataValue('summary_short_presence') || 0),
      currentlyWorking: 0,
      pendingPunch: 0,
      overtimeHours: "0h 0m",
      fineHours: "0h 0m",
      fineAmount: parseFloat(firstItem?.getDataValue('summary_total_fine_amount') || 0),
      overtimeAmount: parseFloat(firstItem?.getDataValue('summary_total_overtime_amount') || 0),
      punchedIn: parseInt(firstItem?.getDataValue('summary_punched_in') || 0),
      punchedOut: parseInt(firstItem?.getDataValue('summary_punched_out') || 0),
      incomplete: parseInt(firstItem?.getDataValue('summary_incomplete') || 0)
    };

    const totalAccounted = parseInt(firstItem?.getDataValue('summary_total_accounted') || 0);
    const totalOvertimeMins = parseInt(firstItem?.getDataValue('summary_total_ot') || 0);
    const totalFineMins = parseInt(firstItem?.getDataValue('summary_total_fine') || 0);

    summary.pendingPunch = Math.max(0, totalStaff - totalAccounted);
    summary.currentlyWorking = Math.max(0, summary.punchedIn - summary.punchedOut);
    summary.overtimeHours = `${Math.floor(totalOvertimeMins / 60)}h ${totalOvertimeMins % 60}m`;
    summary.fineHours = `${Math.floor(totalFineMins / 60)}h ${totalFineMins % 60}m`;

    return res.ok({
      summary,
      items: employeesResult.items,
      total: employeesResult.total,
      currentPage: employeesResult.currentPage,
      pageSize: employeesResult.pageSize,
      totalPages: employeesResult.totalPages
    });

  } catch (err) {
    return handleError(err, res, req);
  }
}

/**
 * UPDATE ATTENDANCE DAY (Manual Entry)
 */
exports.updateAttendanceDay = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const requiredFields = {
      employee_id: "Employee",
      attendance_date: "Date",
    };

    const emp = await commonQuery.findOneRecord(Employee, { id: req.body.employee_id }, {
      include: [
        { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
        { model: AttendanceTemplate, as: "attendanceTemplate", required: false },
        { model: ShiftTemplate, as: "shiftTemplate", required: false },
        { model: EmployeeSalaryTemplate, as: "employeeSalaryTemplate", where: { status: 0 }, required: false },
        { model: EmployeeWeeklyOff, as: "employeeWeeklyOffs", where: { status: 0, is_off: true }, required: false },
        { model: EmployeeHoliday, as: "employeeHolidays", where: { status: 0, date: req.body.attendance_date }, required: false }
      ]
    }, t, false, { company_id: true });

    // Check if employee exists
    if (!emp) {
      await t.rollback();
      return res.error(constants.NOT_FOUND_ERROR, "Employee not found");
    }

    const template = emp.employeeAttendanceTemplate || emp.attendanceTemplate;
    const isTrackInOutOn = template ? template.track_in_out : true;

    // Get shift_id from employee if available
    const shift_id = emp && emp.shift_template ? emp.shift_template : null;

    // Add conditional required fields based on status
    if ([0, 12].includes(req.body.status)) {
      if (!req.body.note && isTrackInOutOn) {
        // requiredFields.first_in = "In Time";
      }
    } else if ([1, 6, 13].includes(req.body.status)) {
      if (!req.body.note && isTrackInOutOn) {
        // requiredFields.first_in = "In Time";
        // requiredFields.last_out = "Out Time";
      }
      if ([1, 6].includes(req.body.status)) {
        requiredFields.leave_category_id = "Leave Category";
      }
    }

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    // --- ATTENDANCE APPROVAL INTERCEPTION LOGIC ---
    // Note: Checking req.user.role_id, req.user.is_superadmin, req.user.is_admin
    const settings = await getCompanySetting(req.user.company_id);
    console.log("Attendance Approval Settings:", settings);
    let approvalRequired = false;
    let exemptRoles = [];
    if (settings.attendance_approval_level != null && settings.attendance_approval_level !== 'null') approvalRequired = true;
    if (settings.attendance_approval_exempt_roles) {
      exemptRoles = typeof settings.attendance_approval_exempt_roles === 'string' ? JSON.parse(settings.attendance_approval_exempt_roles) : settings.attendance_approval_exempt_roles;
    }
    console.log("settings.attendance_approval_level:", settings.attendance_approval_level, "settings.attendance_approval_exempt_roles:", settings.attendance_approval_exempt_roles);
    console.log("User Role ID:", req.user.role_id, "Is Superadmin:", req.user.is_superadmin, "Is Admin:", req.user.is_admin);
    console.log("Approval Required:", approvalRequired, "Exempt Roles:", exemptRoles);
    const isExempt = exemptRoles.includes(String(req.user.role_id)) || exemptRoles.includes(Number(req.user.role_id));
    const isSuperAdmin = !!(
      req.user?.is_super_admin ||
      req.user?.role_key === 'BUSINESS_ADMIN' ||
      req.user?.role_id === 1
    );

    if (approvalRequired && !isExempt && !isSuperAdmin && !req.body.is_approved_request) {
      // Look for an existing pending request for this employee on this date
      const existingReq = await commonQuery.findOneRecord(
        AttendanceApproval,
        {
          employee_id: req.body.employee_id,
          attendance_date: req.body.attendance_date,
          approval_status: { [Op.in]: [0, 1] } // PENDING or PARTIALLY_APPROVED
        },
        {}, t
      );

      if (existingReq) {
        // Update the existing request with the newly proposed changes
        await commonQuery.updateRecordById(
          AttendanceApproval,
          existingReq.id,
          {
            proposed_attendance_data: req.body,
            reason: req.body.note || req.body.reason || existingReq.reason
          },
          t
        );
      } else {
        // Create a new request
        await commonQuery.createRecord(AttendanceApproval, {
          employee_id: req.body.employee_id,
          attendance_date: req.body.attendance_date,
          proposed_attendance_data: req.body,
          reason: req.body.note || req.body.reason || null,
          approval_status: 0,
          current_level: 1,
          user_id: req.user.id,
          company_id: req.user.company_id
        }, t);
      }
      await t.commit();
      return res.success({}, "Attendance update sent for approval.");
    }
    // --- END ATTENDANCE APPROVAL INTERCEPTION LOGIC ---

    let {
      employee_id,
      attendance_date,
      status,
      first_in,
      last_out,
      fine_minutes,
      late_minutes,
      early_out_minutes,
      worked_minutes,
      overtime_minutes,
      total_break_minutes,
      fine_amount,
      leave_category_id,
      leave_session,
      overtime_data,
      overtime_amount,
      fine_data,
      is_locked,
      note,
    } = req.body;

    const day = await getOrCreateAttendanceDay(
      employee_id,
      attendance_date,
      {
        user_id: req.user.id,
        company_id: req.user.company_id,
        branch_id: req.body.branch_id || req.user.branch_id,
      },
      t
    );

    // [COMBINED HOLIDAY AND WEEKLY OFF LOGIC (OVERTIME AND Comp-Off Leave)]
    const salaryTemplate = emp?.employeeSalaryTemplate;
    const holidayPolicy = template ? template.holiday_policy : 'BLOCK_ATTENDANCE';
    const lwpBasis = salaryTemplate ? salaryTemplate.lwp_calculation_basis : 'WORKING_DAYS';

    // Determine effective status evaluating if explicitly passed or inherited
    const effectiveStatusForProcessing = (status !== undefined && status !== null) ? Number(status) : Number(day.status);

    if (effectiveStatusForProcessing === 0) {
      const targetDateJS = dayjs(attendance_date);
      const dayOfWeek = targetDateJS.day();
      const weekNo = Math.ceil(targetDateJS.date() / 7);

      const isHL = (emp.employeeHolidays || []).length > 0;
      const isWO = (emp.employeeWeeklyOffs || []).find(wo =>
        wo.day_of_week === dayOfWeek &&
        (wo.week_no === 0 || wo.week_no === weekNo)
      );

      if (isHL || isWO) {
        // 1. Extra Overtime Logic
        if (holidayPolicy === 'ALLOW_NORMAL') {
          if (salaryTemplate) {
            const salaryType = (salaryTemplate.salary_type || 'Monthly').toString();
            const daysInCalc = lwpBasis === 'FIXED_30_DAYS' ? 30 : targetDateJS.daysInMonth();
            const monthlyGross = parseFloat(salaryTemplate.ctc_monthly || 0);

            let daySalaryAddress = 0;
            if (salaryType === 'Hourly') {
              const hourlyRate = parseFloat(salaryTemplate.hourly_rate || 0);
              let effectiveWorkedMinutes = parseFloat((worked_minutes !== undefined && worked_minutes !== null) ? worked_minutes : (day.worked_minutes || 0)) || 0;

              if (!(effectiveWorkedMinutes > 0)) {
                const calcFirstIn = first_in !== undefined ? first_in : day.first_in;
                const calcLastOut = last_out !== undefined ? last_out : day.last_out;
                const breakMins = parseFloat((total_break_minutes !== undefined && total_break_minutes !== null) ? total_break_minutes : (day.total_break_minutes || 0)) || 0;
                if (calcFirstIn && calcLastOut) {
                  let inTime = dayjs(calcFirstIn);
                  let outTime = dayjs(calcLastOut);
                  if (outTime.isBefore(inTime)) {
                    outTime = outTime.add(1, 'day');
                  }
                  const diffMins = outTime.diff(inTime, 'minute');
                  effectiveWorkedMinutes = Math.max(0, diffMins - breakMins);
                }
              }

              let hoursForPay = effectiveWorkedMinutes / 60;
              if (!(hoursForPay > 0)) {
                const shift = emp?.shiftTemplate;
                if (shift) {
                  const payableMins = parseFloat(shift.total_payable_hours || 0) || parseFloat(shift.min_full_day_minutes || 0) || 0;
                  if (payableMins > 0) hoursForPay = payableMins / 60;
                }
              }
              if (!(hoursForPay > 0)) hoursForPay = 8;

              if (hourlyRate > 0) {
                daySalaryAddress = hourlyRate * hoursForPay;
              } else {
                daySalaryAddress = monthlyGross / (daysInCalc || 30);
              }
            } else if (salaryType === 'Daily') {
              const dailyRate = parseFloat(salaryTemplate.daily_rate || 0);
              daySalaryAddress = dailyRate > 0 ? dailyRate : (monthlyGross / (daysInCalc || 30));
            } else {
              const dailyRate = parseFloat(salaryTemplate.daily_rate || 0);
              daySalaryAddress = dailyRate > 0 ? dailyRate : (monthlyGross / (daysInCalc || 30));
            }

            const currentOvertime = parseFloat(overtime_amount || 0);
            overtime_amount = (currentOvertime + daySalaryAddress).toFixed(2);
          }
        }
      }
    }

    let needsPunchUpdate = false;
    let effectiveFirstIn = first_in;
    let effectiveLastOut = last_out;

    // Determine Effective Status (Current DB status if not changing)
    // let effectiveStatus = status !== undefined ? status : day.status;

    // Determine if times are explicitly provided (User modifying Time)
    const isTimeUpdate = (first_in !== undefined || last_out !== undefined);

    const statusProvided = (status !== undefined && status !== null);
    const hasPunchesArray = Array.isArray(req.body.punches);
    // Only preserve/force status when explicitly requested (to allow recalculation on punch updates)
    const shouldPreserveStatus = statusProvided && req.body.force_status === true;

    // Default: respect provided status; will be recalculated later if not preserved
    let effectiveStatus = statusProvided ? Number(status) : day.status;

    // Check if status is non-working (3: WEEKLY_OFF, 4: HOLIDAY, 5: ABSENT, 6: LEAVE)
    const isNonWorkingStatus = [3, 4, 5, 6].includes(effectiveStatus);

    if (isTimeUpdate || req.body.punches || (status !== undefined && status !== null)) {
      needsPunchUpdate = true;
    }

    if (isNonWorkingStatus) {
      // Only clear punches if they are NOT being explicitly updated for WO(3) or HL(4)
      const isPunchAllowed = [3, 4].includes(effectiveStatus) && isTimeUpdate;

      if (!isPunchAllowed) {
        effectiveFirstIn = null;
        effectiveLastOut = null;
        needsPunchUpdate = true;
      }
    }

    // 🔄 Auto-calculate Times if Overtime/Fine is Adjusted (and Times are NOT explicitly provided and Status IS provided)
    // We only auto-calculate if status is being set/updated as per user request to avoid touching punches on detail-only updates.
    if (!isNonWorkingStatus && !isTimeUpdate && (status !== undefined && status !== null) && day.shift_id && (overtime_minutes !== undefined || fine_minutes !== undefined)) {
      const shift = await commonQuery.findOneRecord(ShiftTemplate, { id: day.shift_id });
      if (shift) {
        needsPunchUpdate = true;

        const firstInPunch = await commonQuery.findOneRecord(AttendancePunch, {
          day_id: day.id,
          punch_type: 'IN',
          status: 0
        }, { order: [['punch_time', 'ASC']] }, t, true, { company_id: true });

        const lastOutPunch = await commonQuery.findOneRecord(AttendancePunch, {
          day_id: day.id,
          punch_type: 'OUT',
          status: 0
        }, { order: [['punch_time', 'DESC']] }, t, true, { company_id: true });

        // 1. LATE ENTRY (Affects First In)
        if (fine_minutes !== undefined) {
          const baseIn = firstInPunch ? dayjs(firstInPunch.punch_time) : dayjs(`${attendance_date} ${shift.start_time}`);
          effectiveFirstIn = baseIn.add(fine_minutes, 'minute').format("YYYY-MM-DD HH:mm:ss");
        }

        // 2. LATE OVERTIME or EARLY EXIT (Affects Last Out)
        if (overtime_minutes !== undefined) {
          let shiftEnd = dayjs(`${attendance_date} ${shift.end_time}`);
          if (shift.is_night_shift || shift.end_time < shift.start_time) {
            shiftEnd = shiftEnd.add(1, 'day');
          }

          let baseOut = lastOutPunch ? dayjs(lastOutPunch.punch_time) : shiftEnd;

          if (overtime_minutes !== undefined) {
            const lateOvertime = parseFloat(overtime_minutes || 0);
            effectiveLastOut = baseOut.add(lateOvertime, 'minute').format("YYYY-MM-DD HH:mm:ss");
          }
        }
      }
    }

    // Only trigger punch update if strictly needed
    if (needsPunchUpdate) {
      console.log(
        "[updateAttendanceDay] manualPunch start",
        JSON.stringify({
          employee_id,
          attendance_date,
          effectiveFirstIn,
          effectiveLastOut,
          statusProvided,
          preserveStatus: shouldPreserveStatus,
          hasPunchesArray,
          force_status: req.body.force_status === true
        })
      );

      // Check if today is a holiday - if so, store working hours as overtime
      let isTodayHoliday = false;
      if (emp.holiday_template) {
        const holidayRecord = await commonQuery.findOneRecord(
          HolidayTransaction,
          {
            template_id: emp.holiday_template,
            date: attendance_date,
            status: 0
          },
          {},
          t
        );
        isTodayHoliday = !!holidayRecord;
      }

      // Check if today is a weekly off
      let isTodayWeeklyOff = false;
      const woDateJS = dayjs(attendance_date);
      const woDayOfWeek = woDateJS.day();
      const woWeekNo = Math.ceil(woDateJS.date() / 7);
      if (emp.employeeWeeklyOffs && emp.employeeWeeklyOffs.length > 0) {
        isTodayWeeklyOff = !!(emp.employeeWeeklyOffs || []).find(wo =>
          wo.day_of_week === woDayOfWeek &&
          (wo.week_no === 0 || wo.week_no === woWeekNo)
        );
      }

      const isNonWorkingForPolicy = isTodayHoliday || isTodayWeeklyOff;

      await manualPunch(employee_id, attendance_date, effectiveFirstIn, effectiveLastOut, {
        user_id: req.user.id,
        company_id: req.user.company_id,
        branch_id: req.body.branch_id || req.user.branch_id,
        shift_id: shift_id,
        preserveStatus: shouldPreserveStatus,
        bypassShiftRestrictions: true,
        employee: emp, // Pass pre-fetched employee
        existingDay: day, // Pass pre-fetched day
        punches: req.body.punches, // Pass punches array if provided
        forcedStatus: effectiveStatus, // Pass forced status to ensure it's respected during rebuild
        leave_category_id: leave_category_id,
        leave_session: leave_session,
        isHoliday: (holidayPolicy !== 'COMP_OFF') ? isNonWorkingForPolicy : false, // ALLOW_NORMAL + BLOCK: all time → overtime
        isHolidayAllowNormal: (holidayPolicy === 'ALLOW_NORMAL') ? isNonWorkingForPolicy : false, // ALLOW_NORMAL: status = Present (not Holiday)
        isHolidayCompOff: (holidayPolicy === 'COMP_OFF') ? isNonWorkingForPolicy : false // COMP_OFF: all time → worked_minutes, no overtime
      }, t);
      console.log("[updateAttendanceDay] manualPunch done");
    }

    // If status wasn't explicitly provided, use the recalculated status from rebuildAttendanceDay
    if (!shouldPreserveStatus) {
      const refreshedDay = await commonQuery.findOneRecord(AttendanceDay, { id: day.id }, {}, t);
      console.log(
        "[updateAttendanceDay] refreshed status",
        JSON.stringify({
          day_id: day.id,
          refreshed_status: refreshedDay ? refreshedDay.status : null,
          refreshed_worked_minutes: refreshedDay ? refreshedDay.worked_minutes : null,
        })
      );
      if (refreshedDay && refreshedDay.status !== undefined && refreshedDay.status !== null) {
        effectiveStatus = refreshedDay.status;
      }
    }

    const payload = {
      employee_id,
      attendance_date,
      status: effectiveStatus,
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.body.branch_id || req.user.branch_id,
      late_minutes: late_minutes !== undefined ? late_minutes : (day ? day.late_minutes : 0),
      early_out_minutes: early_out_minutes !== undefined ? early_out_minutes : (day ? day.early_out_minutes : 0),
    };

    if (shift_id) payload.shift_id = shift_id;

    // Clear data for non-working statuses
    if ([3, 4, 5, 6].includes(effectiveStatus)) {
      // ALLOW overtime/punch for WO(3) and HL(4) if times are explicitly provided
      const isPunchAllowed = [3, 4].includes(effectiveStatus) && (payload.first_in || payload.last_out || overtime_minutes);

      if (!isPunchAllowed) {
        payload.first_in = null;
        payload.last_out = null;
        payload.shift_id = null;
        payload.worked_minutes = 0;
        payload.total_break_minutes = 0;
        payload.overtime_minutes = 0;
        payload.overtime_data = null;
        payload.overtime_amount = 0; // Ensure amount is cleared
      } else {
        // If Allowed, we KEEP first_in, last_out, worked_minutes, overtime_minutes
        if (first_in !== undefined) payload.first_in = first_in;
        if (last_out !== undefined) payload.last_out = last_out;
        if (worked_minutes !== undefined) payload.worked_minutes = worked_minutes;

        // Re-calculate Overtime from Data if provided
        if (overtime_data !== undefined) {
          const finalOTData = (overtime_data === 'null' || overtime_data === null) ? null : overtime_data;
          payload.overtime_data = finalOTData;
          if (finalOTData && typeof finalOTData === 'object') {
            const calcOTAmount = parseFloat((parseFloat(finalOTData.late_ot?.amount || 0) + parseFloat(finalOTData.early_ot?.amount || 0)).toFixed(2));
            const calcOTMinutes = parseInt(finalOTData.late_ot?.minutes || 0) + parseInt(finalOTData.early_ot?.minutes || 0);

            // Prioritize calculated values if provided summary is 0/null
            payload.overtime_amount = (!overtime_amount) ? calcOTAmount : overtime_amount;
            payload.overtime_minutes = (!overtime_minutes) ? calcOTMinutes : overtime_minutes;
          } else {
            payload.overtime_amount = 0;
            payload.overtime_minutes = 0;
          }
        } else {
          if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
          if (overtime_amount !== undefined) payload.overtime_amount = overtime_amount;
        }
      }

      // For Absent (5): preserve the absent fine computed by rebuildAttendanceDay OR manual override
      // For Weekly Off (3), Holiday (4), Leave (6): always clear fines
      if (effectiveStatus === 5) {
        // Re-fetch the rebuilt day so the absent fine is carried into the payload
        const rebuiltDay = await commonQuery.findOneRecord(AttendanceDay, { id: day.id }, {}, t);
        console.log(`[updateAttendanceDay] Absent status - rebuiltDay fine_data=${JSON.stringify(rebuiltDay?.fine_data)} fine_amount=${rebuiltDay?.fine_amount}`);

        if (fine_data !== undefined) {
          // Use explicitly provided fine data (manual override from adjustment modal)
          const finalFineData = (fine_data === 'null' || fine_data === null) ? null : fine_data;
          payload.fine_data = finalFineData;
          payload.fine_amount = fine_amount !== undefined ? fine_amount : (rebuiltDay?.fine_amount ?? 0);
          payload.fine_minutes = fine_minutes !== undefined ? fine_minutes : (rebuiltDay?.fine_minutes ?? 0);
        } else if (rebuiltDay) {
          payload.fine_data = rebuiltDay.fine_data ?? null;
          payload.fine_amount = rebuiltDay.fine_amount ?? 0;
          payload.fine_minutes = rebuiltDay.fine_minutes ?? 0;
        }
      } else {
        payload.fine_minutes = 0;
        payload.fine_data = null;
        payload.fine_amount = 0;
      }

      if (effectiveStatus !== 6) {
        payload.leave_category_id = null;
        payload.leave_session = null;
      } else {
        // For LEAVE (6), we MUST assign the category/session if provided
        if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
        if (leave_session !== undefined) payload.leave_session = leave_session;
        if (overtime_data !== undefined) {
          const finalOTData = (overtime_data === 'null' || overtime_data === null) ? null : overtime_data;
          payload.overtime_data = finalOTData;
          if (finalOTData && typeof finalOTData === 'object') {
            const calcOTAmount = parseFloat((parseFloat(finalOTData.late_ot?.amount || 0) + parseFloat(finalOTData.early_ot?.amount || 0)).toFixed(2));
            const calcOTMinutes = parseInt(finalOTData.late_ot?.minutes || 0) + parseInt(finalOTData.early_ot?.minutes || 0);

            // Prioritize calculated values if provided summary is 0/null
            payload.overtime_amount = (!overtime_amount) ? calcOTAmount : overtime_amount;
            payload.overtime_minutes = (!overtime_minutes) ? calcOTMinutes : overtime_minutes;
          } else {
            payload.overtime_amount = 0;
            payload.overtime_minutes = 0;
          }
        } else {
          if (overtime_amount !== undefined) payload.overtime_amount = overtime_amount;
          if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
        }
      }
    } else {
      // Skip fine and overtime calculations for out-duty days (status 12 and 13)
      const isOutDutyStatus = [12, 13].includes(effectiveStatus);

      if (first_in !== undefined) payload.first_in = first_in;
      if (last_out !== undefined) payload.last_out = last_out;

      if (worked_minutes !== undefined) payload.worked_minutes = worked_minutes;

      // Only calculate fine/overtime if NOT out-duty status
      if (!isOutDutyStatus) {
        const finesAllowed = template ? (template.fines_allowed !== false) : true;
        if (fine_minutes !== undefined && finesAllowed) payload.fine_minutes = fine_minutes;

        // Re-calculate Overtime from Data if provided
        if (overtime_data !== undefined) {
          const finalOTData = (overtime_data === 'null' || overtime_data === null) ? null : overtime_data;
          payload.overtime_data = finalOTData;
          if (finalOTData && typeof finalOTData === 'object') {
            const calcOTAmount = parseFloat((parseFloat(finalOTData.late_ot?.amount || 0) + parseFloat(finalOTData.early_ot?.amount || 0)).toFixed(2));
            const calcOTMinutes = parseInt(finalOTData.late_ot?.minutes || 0) + parseInt(finalOTData.early_ot?.minutes || 0);

            // Prioritize calculated values if provided summary is 0/null
            payload.overtime_amount = (!overtime_amount) ? calcOTAmount : overtime_amount;
            payload.overtime_minutes = (!overtime_minutes) ? calcOTMinutes : overtime_minutes;
          } else {
            payload.overtime_amount = 0;
            payload.overtime_minutes = 0;
          }
        } else {
          if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
          if (overtime_amount !== undefined) payload.overtime_amount = overtime_amount;
        }

        // Re-calculate Fine from Data if provided
        if (!finesAllowed) {
          payload.fine_data = null;
          payload.fine_amount = 0;
          payload.fine_minutes = 0;
        } else if (fine_data !== undefined) {
          const finalFineData = (fine_data === 'null' || fine_data === null) ? null : fine_data;
          payload.fine_data = finalFineData;
          if (finalFineData && typeof finalFineData === 'object') {
            const calcFineAmount = parseFloat((
              parseFloat(finalFineData.late_entry?.amount || 0) +
              parseFloat(finalFineData.early_exit?.amount || 0) +
              parseFloat(finalFineData.excess_breaks?.amount || 0)
            ).toFixed(2));
            const calcFineMinutes = parseInt(finalFineData.late_entry?.minutes || 0) +
              parseInt(finalFineData.early_exit?.minutes || 0) +
              parseInt(finalFineData.excess_breaks?.minutes || 0);

            // Prioritize calculated values if provided summary is 0/null
            payload.fine_amount = (!fine_amount) ? calcFineAmount : fine_amount;
            payload.fine_minutes = (!fine_minutes) ? calcFineMinutes : fine_minutes;
          } else {
            payload.fine_data = null;
            payload.fine_amount = 0;
            payload.fine_minutes = 0;
          }
        } else {
          if (fine_minutes !== undefined) payload.fine_minutes = fine_minutes;
          if (fine_amount !== undefined) payload.fine_amount = fine_amount;
        }
      } else {
        // Clear fine and overtime for out-duty days
        payload.fine_minutes = 0;
        payload.fine_data = null;
        payload.fine_amount = 0;
        payload.overtime_minutes = 0;
        payload.overtime_data = null;
        payload.overtime_amount = 0;
      }

      if (total_break_minutes !== undefined) payload.total_break_minutes = total_break_minutes;
      if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
      if (leave_session !== undefined) payload.leave_session = leave_session;
    }

    // If status is not Half Day(1) or Leave(6) or Half OD (13), explicitly clear leave category/session
    if (effectiveStatus !== undefined && ![1, 6, 13].includes(effectiveStatus)) {
      payload.leave_category_id = null;
      payload.leave_session = null;
    }

    if (is_locked !== undefined) payload.is_locked = is_locked;

    // Clear system-generated note if status is changing and no new note is provided
    const isSystemGeneratedNote = (n) => {
      if (!n || typeof n !== 'string') return false;
      const trimmed = n.trim();
      return trimmed.startsWith("System:") ||
        trimmed.startsWith("Auto Absent:") ||
        trimmed.startsWith("Incomplete:") ||
        trimmed.startsWith("Leave approved:") ||
        trimmed.startsWith("Penalty:") ||
        trimmed.startsWith("Penalty (");
    };

    if (note !== undefined) {
      payload.note = note;
    } else if (day && isSystemGeneratedNote(day.note)) {
      payload.note = null;
    }

    // Fetch refreshed day to get recalculated worked_minutes, punches, etc. from manualPunch/rebuild
    const refreshedDay = await commonQuery.findOneRecord(AttendanceDay, { id: day.id }, {}, t);
    const newDayPayload = refreshedDay ? { ...refreshedDay.get({ plain: true }), ...payload } : payload;

    // Synchronize leave balance based on status changes (Half Day/Leave)
    const balanceError = await syncAttendanceToLeaveBalance(employee_id, day, newDayPayload, t, emp);
    if (balanceError) {
      await t.rollback();
      return res.error(constants.LEAVE_BALANCE_ERROR, balanceError);
    }

    const result = await commonQuery.updateRecordById(AttendanceDay, { id: day.id }, payload, t, false, {});

    // --- LATE CHECK: SHORT LEAVE DEDUCTION ---
    // If employee is 120+ minutes late and has a last out time, deduct 1 from Short Leave.
    // if (emp.leave_template) {
    //   // Refresh day record to get latest recalculated values (from manualPunch/rebuildAttendanceDay)
    //   const currentDay = await commonQuery.findOneRecord(AttendanceDay, { id: day.id }, {}, t);

    //   const shortLeaveCategory = await commonQuery.findOneRecord(LeaveTemplateCategory, {
    //     leave_template_id: emp.leave_template,
    //     leave_category_name: "Short Leave",
    //     status: 0
    //   }, {}, t, false, false); // requireTenantFields: false to find company-wide categories

    //   if (shortLeaveCategory && currentDay) {
    //     const AUTO_REASON_LATE = "Auto-generated Short Leave (Late Check)";
    //     const currentFineMinutes = currentDay.fine_minutes || 0;
    //     const currentLastOut = currentDay.last_out;

    //     const totalMissedMinutes = currentFineMinutes;
    //     const isLateForShortLeave = currentLastOut && totalMissedMinutes >= 120;

    //     const existingShortLeave = await commonQuery.findOneRecord(LeaveRequest, {
    //       employee_id: employee_id,
    //       start_date: attendance_date,
    //       leave_category_id: shortLeaveCategory.id,
    //       reason: AUTO_REASON_LATE,
    //       status: 0
    //     }, {}, t);

    //     if (isLateForShortLeave) {
    //       if (!existingShortLeave) {
    //         // Check balance before deducting
    //         const balance = await commonQuery.findOneRecord(EmployeeLeaveBalance, {
    //           employee_id: employee_id,
    //           leave_category_id: shortLeaveCategory.id,
    //           status: 0
    //         }, {}, t, false, { company_id: true });


    //         if (balance && parseFloat(balance.pending_leaves || 0) >= 1) {
    //           const leaveError = await LeaveBalanceService.syncLeaveRecord(employee_id, attendance_date, shortLeaveCategory.id, 1.0, t, emp);
    //           if (leaveError) {
    //             console.error(`[ShortLeaveLog] syncLeaveRecord Error: ${leaveError}`);
    //             await t.rollback();
    //             return res.error(constants.LEAVE_BALANCE_ERROR, leaveError);
    //           }
    //           await LeaveRequest.update({ reason: AUTO_REASON_LATE }, {
    //             where: {
    //               employee_id: employee_id,
    //               start_date: attendance_date,
    //               leave_category_id: shortLeaveCategory.id,
    //               reason: "Auto-generated from Attendance"
    //             },
    //             transaction: t
    //           });
    //         }
    //       }
    //     } else if (existingShortLeave) {
    //       // Reverse deduction if conditions are no longer met
    //       const leaveError = await LeaveBalanceService.syncLeaveRecord(employee_id, attendance_date, shortLeaveCategory.id, 0, t, emp);
    //       if (leaveError) {
    //         await t.rollback();
    //         return res.error(constants.LEAVE_BALANCE_ERROR, leaveError);
    //       }
    //     }
    //   }
    // }

    await t.commit();
    return res.success(constants.ATTENDANCE_UPDATED, result);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * DELETE INDIVIDUAL PUNCH
 */
exports.deletePunch = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.body;
    if (!id) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "Punch ID is required");
    }

    const punchRecord = await commonQuery.findOneRecord(AttendancePunch, { id }, {}, t, true, { company_id: true });
    if (!punchRecord) {
      await t.rollback();
      return res.error(constants.NOT_FOUND, "Punch not found");
    }

    const employeeId = punchRecord.employee_id;
    const punchDate = new Date(punchRecord.punch_time).toISOString().split("T")[0];

    await commonQuery.softDeleteById(AttendancePunch, { id }, t, { company_id: true });

    // After deleting a punch, we MUST rebuild the day summary
    await rebuildAttendanceDay(employeeId, punchDate, {
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id
    }, t);

    await t.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * DELETE ATTENDANCE DAY (and all its punches)
 */
exports.deleteAttendanceDay = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { employee_id, attendance_date } = req.body;
    if (!employee_id || !attendance_date) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "Employee ID and Date are required");
    }

    // 1. Fetch the day(s) to get ID
    const days = await commonQuery.findAllRecords(AttendanceDay, {
      employee_id,
      attendance_date,
    }, {}, t, {});

    for (const day of days) {
      // 1.5 Synchronize leave balance before deletion (Refund if Half Day/Leave)
      let balanceError;
      try {
        balanceError = await syncAttendanceToLeaveBalance(employee_id, day, null, t);
      } catch (balErr) {
        await t.rollback();
        return res.error(constants.VALIDATION_ERROR, { message: balErr.message || "Leave balance error occurred." });
      }
      if (balanceError) {
        await t.rollback();
        return res.error(constants.VALIDATION_ERROR, { message: balanceError });
      }

      // 2. Delete punches by day_id specifically
      await commonQuery.hardDeleteRecords(AttendancePunch, {
        day_id: day.id
      }, t, {});

      // 3. Delete the day summary
      await commonQuery.hardDeleteRecords(AttendanceDay, {
        id: day.id
      }, t, {});
    }

    // If no AttendanceDay record was found, we still clear any auto-generated leaves
    if (days.length === 0) {
      await LeaveBalanceService.syncLeaveRecord(employee_id, attendance_date, 0, 0, t);
    }

    // REMOVE ANY PENDING Comp-Off Leave CREDIT REQUESTS FOR THIS DAY
    await LeaveRequest.destroy({
      where: {
        employee_id,
        start_date: attendance_date,
        request_type: "CREDIT",
        status: 0
      },
      transaction: t
    });

    // 4. ALWAYS delete all punches for this employee on this date (handles unassigned punches)
    await commonQuery.hardDeleteRecords(AttendancePunch, {
      employee_id,
      punch_time: {
        [Op.between]: [`${attendance_date} 00:00:00`, `${attendance_date} 23:59:59`]
      }
    }, t, {});

    // 5. Rebuild attendance day to restore default statuses (Holiday, Weekly Off, etc.)
    // await rebuildAttendanceDay(employee_id, attendance_date, {
    //   user_id: req.user.id,
    //   company_id: req.user.company_id,
    //   branch_id: req.body.branch_id || req.user.branch_id
    // }, t);

    await t.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * BULK UPDATE ATTENDANCE DAY
 */
exports.bulkUpdateAttendanceDay = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const {
      employee_ids,
      attendance_date,
      status,
      first_in,
      last_out,
      leave_category_id,
      leave_session,
      overtime_data,
      fine_data,
      overtime_minutes,
      fine_amount,
      note
    } = req.body;

    if (!employee_ids || !Array.isArray(employee_ids) || !attendance_date) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "Employee IDs array and Date are required");
    }

    // Pre-fetch all employees to avoid redundant queries in the loop
    const employees = await commonQuery.findAllRecords(Employee, { id: { [Op.in]: employee_ids } }, {
      include: [
        { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
        { model: AttendanceTemplate, as: "attendanceTemplate", required: false },
        { model: ShiftTemplate, as: "shiftTemplate", required: false }
      ]
    }, t, { company_id: true });
    const empMap = new Map(employees.map(e => [e.id, e]));

    for (const employee_id of employee_ids) {
      const emp = empMap.get(employee_id);

      // Get shift_id from employee if available
      const employee_shift_id = emp && emp.shift_template ? emp.shift_template : null;

      let existingRecord = await commonQuery.findOneRecord(AttendanceDay, {
        employee_id,
        attendance_date,
      }, {}, t, false, { company_id: true });

      if (existingRecord) {
        await syncAttendanceToLeaveBalance(employee_id, existingRecord, null, t, emp);
        await AttendanceDay.destroy({
          where: { id: existingRecord.id },
          transaction: t
        });
        existingRecord = null;
      }

      // Reuse manualPunch if times are provided
      if (first_in || last_out) {
        await manualPunch(employee_id, attendance_date, first_in, last_out, {
          user_id: req.user.id,
          company_id: req.user.company_id,
          branch_id: req.body.branch_id || req.user.branch_id,
          shift_id: employee_shift_id,
          employee: emp, // Pass pre-fetched employee
          existingDay: existingRecord // Pass pre-fetched day
        }, t);
        // Refresh after manualPunch (which calls rebuild)
        existingRecord = await commonQuery.findOneRecord(AttendanceDay, {
          employee_id,
          attendance_date,
        }, {}, t, false, { company_id: true });
      } else if ([0, 1, 12, 13].includes(status)) {
        // If marking present/working without providing times, trigger a rebuild to process any existing punches
        await rebuildAttendanceDay(employee_id, attendance_date, {
          user_id: req.user.id,
          company_id: req.user.company_id,
          branch_id: req.body.branch_id || req.user.branch_id,
          shift_id: employee_shift_id,
          employee: emp,
          forcedStatus: status // [NEW] Pass status to ensure leave adjustment during rebuild
        }, t);
        // Refresh after rebuild
        existingRecord = await commonQuery.findOneRecord(AttendanceDay, {
          employee_id,
          attendance_date,
        }, {}, t, false, { company_id: true });
      }

      const payload = {
        employee_id,
        attendance_date,
        status,
        user_id: req.user.id,
        company_id: req.user.company_id,
        branch_id: req.body.branch_id || req.user.branch_id
      };

      if (status !== undefined) payload.status = status;
      if (first_in !== undefined) payload.first_in = first_in;
      if (last_out !== undefined) payload.last_out = last_out;
      if (employee_shift_id) payload.shift_id = employee_shift_id;

      // Clear non-working data for status 3,4,5,6 if no times provided
      if ([3, 4, 5, 6].includes(status)) {
        const isTimeProvided = first_in !== undefined || last_out !== undefined;
        if (!isTimeProvided) {
          payload.first_in = null;
          payload.last_out = null;
          payload.shift_id = null;
          payload.worked_minutes = 0;
          payload.overtime_minutes = 0;
        }

        // Also clear punches
        await commonQuery.updateRecordById(AttendancePunch, {
          employee_id,
          day_id: existingRecord?.id,
          status: 0
        }, { status: 2 }, t, { company_id: true });
      }

      if (leave_category_id !== undefined) payload.leave_category_id = leave_category_id;
      if (leave_session !== undefined) payload.leave_session = leave_session;
      if (overtime_data !== undefined) {
        payload.overtime_data = overtime_data;
        if (payload.overtime_data && typeof payload.overtime_data === 'object') {
          payload.overtime_amount = parseFloat((parseFloat(payload.overtime_data.late_ot?.amount || 0) + parseFloat(payload.overtime_data.early_ot?.amount || 0)).toFixed(2));
        } else if (payload.overtime_data === null) {
          payload.overtime_amount = 0;
        }
      }
      if (fine_data !== undefined) payload.fine_data = fine_data;
      if (overtime_minutes !== undefined) payload.overtime_minutes = overtime_minutes;
      if (fine_amount !== undefined) payload.fine_amount = fine_amount;
      if (note !== undefined) payload.note = note;

      const newDayPayload = existingRecord ? { ...existingRecord.get({ plain: true }), ...payload } : payload;

      // Synchronize leave balance based on status changes (Half Day/Leave)
      const balanceError = await syncAttendanceToLeaveBalance(employee_id, existingRecord, newDayPayload, t, emp);
      if (balanceError) {
        await t.rollback();
        return res.error(balanceError);
      }

      if (existingRecord) {
        await commonQuery.updateRecordById(AttendanceDay, {
          id: existingRecord.id,
        }, payload, t, false, { company_id: true });
      } else {
        await commonQuery.createRecord(AttendanceDay, payload, t);
      }
    }

    await t.commit();
    return res.success(constants.ACTION_SUCCESSFUL);
  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * GET ATTENDANCE DAY DETAILS
 * Fetches details for a specific employee and date, including raw punches.
 */
exports.getAttendanceDayDetails = async (req, res) => {
  try {
    const requiredFields = {
      employee_id: "Employee",
      attendance_date: "Date"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const { employee_id, attendance_date } = req.body;

    let isOwnRequest = employee_id == req.user?.employee_id;
    const tenantOptionsEmpty = isOwnRequest ? { applyHierarchy: false } : {};

    // 1. Fetch the AttendanceDay record
    const attendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
      employee_id,
      attendance_date,
    }, {
      include: [
        {
          model: ShiftTemplate,
          as: "shiftTemplate",
          attributes: ["id", "shift_name", "start_time", "end_time"]
        },
        {
          model: Employee,
          as: "employee",
          attributes: ["id", "first_name", "employee_code", "attendance_setting_template"],
          include: [
            {
              model: EmployeeAttendanceTemplate,
              as: "employeeAttendanceTemplate",
              where: { status: 0 },
              required: false
            },
            {
              model: AttendanceTemplate,
              as: "attendanceTemplate",
              required: false
            }
          ]
        },
        {
          model: LeaveTemplateCategory,
          as: "leaveCategory",
          attributes: ["id", "leave_category_name"],
          required: false
        },
        {
          model: AttendancePunch,
          as: "attendancePunches",
          include: [
            {
              model: BranchMaster,
              as: "branch",
              attributes: ["branch_name"]
            },
            {
              model: DeviceMaster,
              as: "device",
              attributes: ["device_name"]
            }
          ],
          required: false,
          order: [["punch_time", "ASC"]]
        }
      ]
    }, null, false, tenantOptionsEmpty);

    // 2. Fetch all raw punches for this day
    // const punches = await commonQuery.findAllRecords(AttendancePunch, {
    //   employee_id,
    //   punch_time: {
    //     [Op.between]: [`${attendance_date} 00:00:00`, `${attendance_date} 23:59:59`]
    //   },
    //   status: 0
    // }, {
    //   order: [["punch_time", "ASC"]]
    // });

    // 3. Process AttendanceDay and add image URLs to punches
    let attendanceDayJson = null;
    let punchesWithImages = [];
    let employeeDetails = null;

    if (attendanceDay) {
      attendanceDayJson = attendanceDay.get ? attendanceDay.toJSON() : attendanceDay;
      employeeDetails = attendanceDayJson.employee ? attendanceDayJson.employee : null;

      // Enrich with schedule flags
      const dayOfWeek = dayjs(attendance_date).day();
      const weekNo = Math.ceil(dayjs(attendance_date).date() / 7);

      let [isHoliday, isWeeklyOff] = await Promise.all([
        commonQuery.findOneRecord(EmployeeHoliday, {
          employee_id,
          date: attendance_date,
          status: 0
        }),
        commonQuery.findOneRecord(EmployeeWeeklyOff, {
          employee_id,
          day_of_week: dayOfWeek,
          status: 0,
          is_off: true,
          [Op.or]: [{ week_no: 0 }, { week_no: weekNo }]
        })
      ]);

      // Fallback to Master Templates
      if (!isHoliday && attendanceDay?.employee?.holiday_template) {
        isHoliday = await commonQuery.findOneRecord(HolidayTransaction, {
          template_id: attendanceDay.employee.holiday_template,
          date: attendance_date,
          status: 0
        });
      }
      if (!isWeeklyOff && attendanceDay?.employee?.weekly_off_template) {
        isWeeklyOff = await commonQuery.findOneRecord(WeeklyOffTemplateDay, {
          template_id: attendanceDay.employee.weekly_off_template,
          day_of_week: dayOfWeek,
          [Op.or]: [{ week_no: 0 }, { week_no: weekNo }],
          is_off: true,
          status: 0
        });
      }

      attendanceDayJson.is_scheduled_holiday = !!isHoliday;
      attendanceDayJson.is_scheduled_weekly_off = !!isWeeklyOff;

      if (attendanceDayJson.attendancePunches) {
        punchesWithImages = attendanceDayJson.attendancePunches.map(punch => {
          // Add full image URL if image_name exists
          if (punch.image_name) {
            punch.image_url = `${process.env.FILE_SERVER_URL}${constants.ATTENDANCE_FOLDER}${punch.image_name}`;
          } else {
            punch.image_url = null;
          }
          punch.latitude = punch.latitude || null;
          punch.longitude = punch.longitude || null;
          punch.ip_address = punch.ip_address || null;
          return punch;
        });

        // Re-assign processed punches to the day object
        attendanceDayJson.attendancePunches = punchesWithImages;
        attendanceDayJson.attendancePunches.sort((a, b) => new Date(a.punch_time) - new Date(b.punch_time));
      }
    }

    if (!attendanceDayJson) {
      const employee = await commonQuery.findOneRecord(Employee, { id: employee_id }, {
        attributes: ['id', 'first_name', 'employee_code', 'attendance_setting_template'],
        include: [
          {
            model: EmployeeAttendanceTemplate,
            as: "employeeAttendanceTemplate",
            where: { status: 0 },
            required: false
          },
          {
            model: AttendanceTemplate,
            as: "attendanceTemplate",
            required: false
          }
        ]
      });
      employeeDetails = employee ? (employee.get ? employee.toJSON() : employee) : null;
    }

    let attendanceTemplateObj = {
      allow_multiple_punches: true
    };

    if (employeeDetails) {
      const template = employeeDetails.employeeAttendanceTemplate || employeeDetails.attendanceTemplate;
      if (template) {
        attendanceTemplateObj = {
          allow_multiple_punches: template.allow_multiple_punches !== undefined ? template.allow_multiple_punches : true
        };
      }
    }

    return res.ok({
      attendanceDay: attendanceDayJson,
      employee: attendanceDayJson ? undefined : employeeDetails,
      employeeAttendanceTemplate: attendanceTemplateObj
      // punches: punchesWithImages
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET MONTHLY ATTENDANCE WITH PUNCHES
 * Fetches attendance records and punches for an employee for a specific month.
 * Expected month_year format: \"Jan 2026\", \"January 2026\", or \"2026-01\"
 */
exports.getMonthlyAttendance = async (req, res) => {
  try {
    const requiredFields = {
      // employee_id: "Employee",
      month_year: "Month & Year"
    };

    const errors = await validateRequest(req.body, requiredFields);
    if (errors) {
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    let { employee_id, month_year } = req.body;
    if (!employee_id) {
      employee_id = req.user?.employee_id;
    }

    if (!employee_id) {
      return res.error(constants.VALIDATION_ERROR, { message: "Employee ID is required" });
    }

    let isOwnRequest = employee_id == req.user?.employee_id;
    const tenantOptions = isOwnRequest ? { company_id: true, branch_id: true, user_id: true, applyHierarchy: false } : true;
    const tenantOptionsEmpty = isOwnRequest ? { applyHierarchy: false } : {};

    // Normalize input (e.g., "jan 2026" -> "Jan 2026")
    const normalizedMonthYear = month_year.trim().replace(/\b[a-z]/g, l => l.toUpperCase());

    // Parse the date using various formats
    const date = dayjs(normalizedMonthYear, ["MMM YYYY", "MMMM YYYY", "YYYY-MM", "MM-YYYY", "YYYY-M", "M-YYYY"]);

    if (!date.isValid()) {
      return res.error(constants.VALIDATION_ERROR, "Invalid month and year format. Use 'Jan 2026' or 'January 2026'");
    }

    const startDate = date.startOf('month').format('YYYY-MM-DD');
    const endDate = date.endOf('month').format('YYYY-MM-DD');

    // 1. Fetch employee details
    const employee = await commonQuery.findOneRecord(Employee, { id: employee_id }, {
      attributes: ['id', 'first_name', 'profile_image', 'employee_code', 'employee_type', 'shift_template', 'leave_template', 'holiday_template', 'weekly_off_template', 'joining_date', 'access_branches'],
      include: [
        { model: EmployeeAttendanceTemplate, as: "employeeAttendanceTemplate", where: { status: 0 }, required: false },
        { model: AttendanceTemplate, as: "attendanceTemplate", required: false },
        { model: ShiftTemplate, as: "shiftTemplate", required: false }
      ]
    }, null, false, tenantOptions);

    if (!employee) {
      return res.error(constants.NOT_FOUND, "Employee not found");
    }

    if (employee.profile_image) {
      employee.setDataValue('profile_image_url', `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${employee.profile_image}`);
    } else {
      employee.setDataValue('profile_image_url', null);
    }

    // 1.1 Check for Approved Out Duty Request for TODAY
    const todayStr = dayjs().format('YYYY-MM-DD');
    const outDutyRequest = await commonQuery.findOneRecord(OutDutyRequest, {
      employee_id: employee_id,
      start_date: { [Op.lte]: todayStr },
      end_date: { [Op.gte]: todayStr },
      approval_status: 3, // APPROVED
      status: 0
    }, {}, null, false, tenantOptions);

    // 2. Fetch AttendanceDay records for the month
    const attendanceDays = await commonQuery.findAllRecords(AttendanceDay, {
      employee_id,
      attendance_date: {
        [Op.between]: [startDate, endDate]
      },
    }, {
      include: [
        {
          model: AttendancePunch,
          as: "attendancePunches",
          required: false,
          where: { status: 0 },
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'user_name']
            },
            {
              model: DeviceMaster,
              as: 'device',
              attributes: ['id', 'device_name']
            },
            {
              model: BranchMaster,
              as: 'branch',
              attributes: ['id', 'branch_name']
            }
          ],
          order: [["punch_time", "ASC"]]
        },
        {
          model: ShiftTemplate,
          as: "shiftTemplate"
        },
        {
          model: LeaveTemplateCategory,
          as: "leaveCategory"
        },
        {
          model: BranchMaster,
          as: "branch",
          attributes: ["id", "branch_name"]
        }
      ],
      order: [["attendance_date", "ASC"]]
    }, null, tenantOptionsEmpty);

    // 2.1 Fetch Holidays for the month
    let employeeHolidays = await commonQuery.findAllRecords(EmployeeHoliday, {
      employee_id,
      date: { [Op.between]: [startDate, endDate] },
      status: 0
    }, {}, null, tenantOptions);
    // Fallback to Master Template
    if (employeeHolidays.length === 0 && employee.holiday_template) {
      employeeHolidays = await commonQuery.findAllRecords(HolidayTransaction, {
        template_id: employee.holiday_template,
        date: { [Op.between]: [startDate, endDate] },
        status: 0
      }, {}, null, tenantOptions);
    }

    // 2.2 Fetch Weekly Offs for the employee
    let employeeWeeklyOffs = await commonQuery.findAllRecords(EmployeeWeeklyOff, {
      employee_id,
      status: 0,
      is_off: true
    }, {}, null, tenantOptions);
    // Fallback to Master Template
    if (employeeWeeklyOffs.length === 0 && employee.weekly_off_template) {
      employeeWeeklyOffs = await commonQuery.findAllRecords(WeeklyOffTemplateDay, {
        template_id: employee.weekly_off_template,
        is_off: true,
        status: 0
      }, {}, null, tenantOptions);
    }
    const [monthlyOutDuties, monthlyLeaves] = await Promise.all([
      commonQuery.findAllRecords(OutDutyRequest, {
        employee_id,
        approval_status: constants.OUT_DUTY_STATUS.APPROVED,
        start_date: { [Op.lte]: endDate },
        end_date: { [Op.gte]: startDate },
        status: 0
      }, {}, null, tenantOptions),
      commonQuery.findAllRecords(LeaveRequest, {
        employee_id,
        approval_status: constants.LEAVE_APPROVAL_STATUS.APPROVED,
        start_date: { [Op.lte]: endDate },
        end_date: { [Op.gte]: startDate },
        request_type: 'DEBIT',
        is_encashment: false,
        status: 0
      }, {
        include: [{ model: LeaveTemplateCategory, as: 'category', attributes: ['id', 'leave_category_name'] }]
      }, null, tenantOptions)
    ]);

    const approvalRequests = await commonQuery.findAllRecords(AttendanceApproval, {
      employee_id,
      attendance_date: { [Op.between]: [startDate, endDate] },
      status: 0
    }, {}, null, tenantOptions);

    const summary = {
      present: 0,
      halfDay: 0,
      absent: 0,
      leave: 0,
      fine: 0,
      fineAmount: 0,
      overtime: 0,
      overtimeAmount: 0
    };

    let totalFineMins = 0;
    let totalOvertimeMins = 0;

    const allDays = [];
    const daysInMonth = date.daysInMonth();

    const today = dayjs().format('YYYY-MM-DD');
    for (let d = 1; d <= daysInMonth; d++) {
      const curDate = date.date(d).format('YYYY-MM-DD');
      const dayObj = dayjs(curDate);

      // Stop if date is in the future
      if (dayObj.isAfter(dayjs(), 'day')) continue;

      // Stop if date is before joining_date
      if (employee.joining_date && dayObj.isBefore(dayjs(employee.joining_date), 'day')) continue;

      const attendanceDay = attendanceDays.find(ad => ad.attendance_date === curDate);
      // const dayPunches = attendanceDay?.attendancePunches ? [...attendanceDay.attendancePunches].sort((a,b) => new Date(a.punch_time) - new Date(b.punch_time)) : [];
      const dayPunches = attendanceDay?.attendancePunches || [];

      const isOutDutyApproved = !!monthlyOutDuties.find(od => curDate >= od.start_date && curDate <= od.end_date);
      const approvedLeave = monthlyLeaves.find(l => curDate >= l.start_date && curDate <= l.end_date);

      let dayData = {
        date_display: dayObj.format("DD MMM"),
        day_display: dayObj.format("dddd"),
        attendance_date: curDate,
        shift_id: null,
        shift_name: "N/A",
        shift_time: "0:00 Hrs",
        time_range: undefined,
        day_status: null, // Default Not Marked
        status: "Not Marked",
        note: null,
        is_out_duty_approved: isOutDutyApproved,
        is_leave_approved: !!approvedLeave,
        punches: []
      };

      if (attendanceDay) {
        // Summary Counts
        if (attendanceDay.status === 0 || attendanceDay.status === 12) summary.present++;
        else if (attendanceDay.status === 1 || attendanceDay.status === 13) summary.halfDay++;
        else if (attendanceDay.status === 5) summary.absent++;
        else if (attendanceDay.status === 6) summary.leave++;

        // Only calculate fine minutes if a fine amount actually exists (as requested)
        let dayFinePenaltyMins = 0;
        if (attendanceDay.fine_data) {
          const fd = attendanceDay.fine_data;
          if (fd.late_entry?.minutes > 0) dayFinePenaltyMins += parseInt(fd.late_entry.minutes) || 0;
          if (fd.early_exit?.minutes > 0) dayFinePenaltyMins += parseInt(fd.early_exit.minutes) || 0;
          if (fd.excess_breaks?.minutes > 0) dayFinePenaltyMins += parseInt(fd.excess_breaks.minutes) || 0;
        } else if ((parseFloat(attendanceDay.fine_amount) || 0) > 0) {
          // Fallback if fine_data is missing but fine_amount exists
          dayFinePenaltyMins = (parseInt(attendanceDay.fine_minutes) || 0);
        }

        totalFineMins += dayFinePenaltyMins;
        summary.fineAmount += parseFloat(attendanceDay.fine_amount) || 0;
        summary.overtimeAmount += parseFloat(attendanceDay.overtime_amount) || 0;
        // overtime_minutes is already the total (early + late) from helper, so no need to add early_overtime_minutes again
        totalOvertimeMins += (parseInt(attendanceDay.overtime_minutes) || 0);

        const shiftName = attendanceDay.shiftTemplate?.shift_name || "N/A";
        const shiftStartTime = attendanceDay.shiftTemplate?.start_time || "N/A";
        const shiftEndTime = attendanceDay.shiftTemplate?.end_time || "N/A";

        let shiftTimeStr = "0:00 Hrs";
        if (attendanceDay.shiftTemplate) {
          const start = dayjs(attendanceDay.shiftTemplate.start_time, "HH:mm:ss");
          let end = dayjs(attendanceDay.shiftTemplate.end_time, "HH:mm:ss");
          if (end.isBefore(start)) end = end.add(1, 'day');
          const diffMins = end.diff(start, 'minute');
          shiftTimeStr = `${Math.floor(diffMins / 60)}:${(diffMins % 60).toString().padStart(2, '0')} Hrs`;
        }

        const statusMap = { 0: "Present", 1: "Half Day", 3: "Weekly Off", 4: "Holiday", 5: "Absent", 6: "Leave", 9: "Incomplete", 10: "Miss Punch", 12: "Out Duty", 13: "Half Out Duty", 14: "Not Marked" };
        let statusText = statusMap[attendanceDay.status] || "Unknown";

        if (isOutDutyApproved && approvedLeave) {
          const leaveCategoryName = approvedLeave.category?.leave_category_name || "Leave";
          statusText = `Out Duty / ${leaveCategoryName}`;
          attendanceDay.leaveCategory = approvedLeave.category;
        } else if (isOutDutyApproved) {
          statusText = "Out Duty";
        } else {
          if (attendanceDay.status === 6) {
            statusText = attendanceDay.leaveCategory?.leave_category_name || "Leave";
          } else if (attendanceDay.status === 4) {
            const h = employeeHolidays.find(h => h.date === curDate);
            statusText = h ? h.name : "Holiday";
          } else if (attendanceDay.status === 1 && attendanceDay.leaveCategory?.leave_category_name) {
            statusText = `Half Day / ${attendanceDay.leaveCategory.leave_category_name}`;
          } else if (attendanceDay.status === 0 && attendanceDay.leaveCategory?.leave_category_name) {
            statusText = attendanceDay.leaveCategory.leave_category_name;
          }
        }

        let timeRange = "0:00 Hrs";
        if (attendanceDay.first_in && attendanceDay.last_out) {
          timeRange = `${dayjs(attendanceDay.first_in, "HH:mm:ss").format("hh:mm a")} - ${dayjs(attendanceDay.last_out, "HH:mm:ss").format("hh:mm a")}`;
        } else if (attendanceDay.first_in) {
          timeRange = `${dayjs(attendanceDay.first_in, "HH:mm:ss").format("hh:mm a")} - Pending`;
        }

        let varianceStr = "";
        const dayFine = dayFinePenaltyMins;
        const totalOvertime = (parseInt(attendanceDay.overtime_minutes) || 0);

        if (dayFine > 0 && totalOvertime > 0) {
          // Show both fine and overtime
          varianceStr = ` [+ ${Math.floor(totalOvertime / 60)}:${(totalOvertime % 60).toString().padStart(2, '0')} Hrs] [- ${Math.floor(dayFine / 60)}:${(dayFine % 60).toString().padStart(2, '0')} Hrs]`;
        } else if (dayFine > 0) {
          // Show only fine
          varianceStr = ` [- ${Math.floor(dayFine / 60)}:${(dayFine % 60).toString().padStart(2, '0')} Hrs]`;
        } else if (totalOvertime > 0) {
          // Show only overtime
          varianceStr = ` [+ ${Math.floor(totalOvertime / 60)}:${(totalOvertime % 60).toString().padStart(2, '0')} Hrs]`;
        }

        dayData = {
          ...dayData,
          id: attendanceDay.id,
          first_in: attendanceDay.first_in,
          last_out: attendanceDay.last_out,
          worked_minutes: attendanceDay.worked_minutes,
          total_break_minutes: attendanceDay.total_break_minutes,
          fine_minutes: attendanceDay.fine_minutes,
          overtime_minutes: attendanceDay.overtime_minutes,
          fine_amount: attendanceDay.fine_amount,
          overtime_amount: attendanceDay.overtime_amount,
          overtime_data: attendanceDay.overtime_data,
          fine_data: attendanceDay.fine_data,
          branch_name: attendanceDay.branch?.branch_name,
          leave_session: attendanceDay.leave_session,
          is_locked: attendanceDay.is_locked,
          shift_id: attendanceDay.shift_id,
          shift_name: shiftName,
          shift_time: shiftTimeStr,
          time_range: timeRange === "0:00 Hrs" ? undefined : (timeRange + varianceStr),
          day_status: attendanceDay.status,
          status: statusText,
          note: attendanceDay.note,
          leave_category_id: attendanceDay.leave_category_id,
          is_scheduled_holiday: !!employeeHolidays.find(h => h.date === curDate),
          is_scheduled_weekly_off: !!employeeWeeklyOffs.find(wo => {
            const dayOfWeek = dayObj.day();
            const weekOfMonth = Math.ceil(dayObj.date() / 7);
            return wo.day_of_week === dayOfWeek && (wo.week_no === 0 || wo.week_no === weekOfMonth);
          }),
          punches: dayPunches
            .sort((a, b) => a.id - b.id) // 🔥 ASC order by ID
            .map(p => ({
              id: p.id,
              time: dayjs(p.punch_time).format("hh:mm a"),
              date_time: dayjs(p.punch_time).format("DD MMM, hh:mm A"),
              type: p.punch_type,
              punch_by: p.user?.user_name || "System",
              branch_name: p.branch?.branch_name,
              image_url: p.image_name
                ? `${process.env.FILE_SERVER_URL}${constants.ATTENDANCE_FOLDER}${p.image_name}`
                : null,
              latitude: p.latitude || null,
              longitude: p.longitude || null,
              ip_address: p.ip_address || null,
              punch_text: `Punched ${p.punch_type === 'IN' ? 'In' : 'Out'} via ${p.image_name ? 'Face Scan' : 'Manual'} | ${shiftName} | through ${p.device?.device_name || 'App'}`
            }))
        };
      }
      // else {
      //   // No attendance record - Check Holiday
      //   const holiday = employeeHolidays.find(h => h.date === curDate);
      //   if (holiday) {
      //     dayData.status = holiday.name || "Holiday";
      //     dayData.day_status = 4;
      //   } else {
      //     // Check Weekly Off
      //     const dayOfWeek = dayObj.day(); // 0 is Sunday
      //     const weekOfMonth = Math.ceil(dayObj.date() / 7);
      //     const isWO = employeeWeeklyOffs.find(wo =>
      //       wo.day_of_week === dayOfWeek && (wo.week_no === 0 || wo.week_no === weekOfMonth) && wo.is_off && wo.status === 0
      //     );
      //     if (isWO) {
      //       dayData.status = "Weekly Off";
      //       dayData.day_status = 3;
      //     }
      //   }

      //   // Count as Absent if explicitly marked as Absent (day_status 5) and not Today/Future
      //   if (dayData.day_status === 5 && dayObj.isBefore(dayjs(), 'day')) {
      //       summary.absent++;
      //   }
      // }

      const dayApproval = approvalRequests.find(ar => ar.attendance_date === curDate);
      if (dayApproval) {
        dayData.approval_status = dayApproval.approval_status;
        dayData.approval_id = dayApproval.id;
        dayData.proposed_status = dayApproval.proposed_attendance_data?.status;
        dayData.approval_reason = dayApproval.reason;
      }

      allDays.push(dayData);
    }

    // Finalize Summary Formatting
    summary.fine = `${Math.floor(totalFineMins / 60)}:${(totalFineMins % 60).toString().padStart(2, '0')}`;
    summary.overtime = `${Math.floor(totalOvertimeMins / 60)}:${(totalOvertimeMins % 60).toString().padStart(2, '0')}`;

    return res.ok({
      employeeDetails: employee,
      month_year: date.format('MMMM YYYY'),
      summary,
      can_punch_from_personal_device: !!outDutyRequest,
      attendance: allDays.reverse() // DESC order
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Get Leave Summary (Balance & History)
 * Grouped by Month for History
 */
exports.getLeaveSummary = async (req, res) => {
  try {
    let { employee_id } = req.body;
    if (!employee_id) {
      employee_id = req.user.employee_id;
    }

    if (!employee_id) {
      return res.error(constants.VALIDATION_ERROR, "Employee ID is required");
    }

    // 1. Fetch Leave Balances
    const employee = await commonQuery.findOneRecord(Employee, employee_id, {
      include: [{ model: LeaveTemplate, as: "leaveTemplate" }]
    });

    let balanceCriteria = { employee_id, status: 0 };
    if (employee && employee.leaveTemplate) {
      const { end } = LeaveBalanceService.getCycleDates(employee.joining_date, employee.leaveTemplate.leave_policy_cycle);
      balanceCriteria.year = end.year();
      if (employee.leaveTemplate.leave_policy_cycle === 'MONTHLY') {
        balanceCriteria.month = end.month() + 1;
      } else {
        balanceCriteria.month = null;
      }
    }

    let isOwnRequest = employee_id == req.user.employee_id;
    const balances = await commonQuery.findAllRecords(EmployeeLeaveBalance, balanceCriteria, {}, null, isOwnRequest ? { applyHierarchy: false } : true);

    // 2. Fetch Leave Requests for History (Ordered by date)
    const history = await commonQuery.findAllRecords(LeaveRequest, {
      employee_id,
      status: 0
    }, {
      include: [
        {
          model: LeaveTemplateCategory,
          as: "category",
          attributes: ["id", "leave_category_name"]
        }
        ,
        // Include approver user so we can show name in history
        {
          model: User,
          as: "approvedBy",
          attributes: ["id", "user_name"],
          required: false
        }
      ],
      order: [["start_date", "DESC"]]
    }, null, isOwnRequest ? { applyHierarchy: false } : true);

    // 3. Format Balances
    let totalUsed = 0;
    let totalLeft = 0;
    const formattedBalances = balances.map(b => {
      const used = parseFloat(b.used_leaves || 0);
      const pending = parseFloat(b.pending_leaves || 0);

      totalUsed += used;
      totalLeft += pending;

      return {
        id: b.id,
        leave_name: b.leave_category_name,
        balance: `${pending.toFixed(1)} Left`,
        to_be_accrued: `${used.toFixed(1)} Used` // Following design
      };
    });

    // 4. Group History by Month
    const groupedHistory = [];
    history.forEach(leave => {
      const monthYear = dayjs(leave.start_date).format("MMM, YYYY");
      let group = groupedHistory.find(g => g.month_label === monthYear);

      if (!group) {
        group = {
          month_label: monthYear,
          total_days: 0,
          leaves: []
        };
        groupedHistory.push(group);
      }

      // Only count approved leaves in the monthly header count if needed,
      // but usually the header shows total requested in that month
      // Sum up days for the month. Credits (Earned) are added, Debits (Taken) are subtracted or just shown?
      // Usually "total_days" in summary means total leave days taken.
      // But if we want to show net change or just total volume, we need to decide.
      // User said "look like earned leave not deducted leave".
      // Let's keep total_days as volume but differentiate in the items.
      // Sum up only "Taken" (DEBIT) leaves for the monthly header count.
      // This avoids negative counts (like -1) when only earned leaves exist.
      if ([constants.LEAVE_APPROVAL_STATUS.APPROVED, constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED, constants.LEAVE_APPROVAL_STATUS.PENDING].includes(leave.approval_status)) {
        if (leave.request_type !== 'CREDIT') {
          group.total_days += parseFloat(leave.total_days || 0);
        }
      }

      const start = dayjs(leave.start_date);
      const end = dayjs(leave.end_date);
      const dateRange = `${start.format("D MMM, ddd")} - ${end.format("D MMM, ddd")}`;

      const statusMap = {
        [constants.LEAVE_APPROVAL_STATUS.PENDING]: "PENDING",
        [constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED]: "PARTIALLY APPROVED",
        [constants.LEAVE_APPROVAL_STATUS.APPROVED]: "APPROVED",
        [constants.LEAVE_APPROVAL_STATUS.REJECTED]: "REJECTED",
        [constants.LEAVE_APPROVAL_STATUS.CANCELLED]: "CANCELLED",
        [constants.LEAVE_APPROVAL_STATUS.DELETED]: "DELETED",
      };

      const colorMap = {
        [constants.LEAVE_APPROVAL_STATUS.APPROVED]: "#10B981",
        [constants.LEAVE_APPROVAL_STATUS.REJECTED]: "#EF4444",
        [constants.LEAVE_APPROVAL_STATUS.PENDING]: "#F59E0B",
        [constants.LEAVE_APPROVAL_STATUS.PARTIALLY_APPROVED]: "#3B82F6",
        [constants.LEAVE_APPROVAL_STATUS.CANCELLED]: "#6B7280",
        [constants.LEAVE_APPROVAL_STATUS.DELETED]: "#9CA3AF",
      };

      const isCredit = leave.request_type === 'CREDIT';
      const labelPrefix = isCredit ? "(+) " : "";
      const typeSuffix = isCredit ? " (Earned)" : "";

      group.leaves.push({
        id: leave.id,
        date_range: dateRange,
        request_type: leave.request_type || 'DEBIT',
        applied_date: leave.createdAt ? dayjs(leave.createdAt).format("D MMM, ddd") : "",
        duration_display: `${labelPrefix}${parseFloat(leave.total_days).toFixed(1)} Days | ${leave.category?.leave_category_name}${typeSuffix}`,
        duration_days: `${labelPrefix}${parseFloat(leave.total_days).toFixed(1)} Days`,
        leave_type: `${leave.category?.leave_category_name}${typeSuffix}`,
        reason: leave.reason || "",
        document_url: leave.document ? `${process.env.FILE_SERVER_URL}${constants.LEAVE_DOC_FOLDER}${leave.document}` : null,
        status_id: leave.approval_status,
        status: statusMap[leave.approval_status] || "PENDING",
        status_color: isCredit ? "#10B981" : (colorMap[leave.approval_status] || "#F59E0B"),
        approved_by: leave.approvedBy?.user_name || null,
        approval_remark: leave.approval_remark || "",
        start_session: leave.start_session === 0 ? "Full Day" : (leave.start_session === 1 ? "Session 1" : "Session 2"),
        end_session: leave.end_session === 0 ? "Full Day" : (leave.end_session === 1 ? "Session 1" : "Session 2")
      });
    });

    return res.ok({
      leave_balance: {
        total_balance_text: `${totalLeft.toFixed(1)} Leaves`,
        categories: formattedBalances,
        total_used_text: `${totalUsed.toFixed(1)} Days`
      },
      leave_history: groupedHistory
    });

  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Update Attendance Note Only
 */
exports.updateAttendanceNote = async (req, res) => {
  try {
    const { employee_id, attendance_date, note } = req.body;

    if (!employee_id || !attendance_date) {
      return res.error(constants.VALIDATION_ERROR, "Employee ID and Date are required");
    }

    const attendanceDay = await commonQuery.findOneRecord(AttendanceDay, {
      employee_id,
      attendance_date
    }, {}, null, false, { company_id: true });

    if (!attendanceDay) {
      return res.error(constants.NOT_FOUND, "Attendance record not found for this date");
    }

    await commonQuery.updateRecordById(AttendanceDay, attendanceDay.id, { note }, null, false, { company_id: true });

    return res.ok({ message: "Note updated successfully" });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Store Face Recognition Error Log
 */
exports.storeFaceRecognitionError = async (req, res) => {
  await ensureFaceRecognitionErrorSynced(req.tenantPrefix);
  const t = await sequelize.transaction();
  try {
    console.log("Storing Face Recognition Error Log...", req.body);
    const { accuracy, time, company_id, branch_id, image: base64Image, latitude, longitude, employee_id, matches, message, face_vector } = req.body;
    const finalMessage = message || null;

    if (!time) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "Time is required");
    }

    // Determine the company and branch IDs
    const finalCompanyId = company_id || req.user?.company_id || 0;
    const finalBranchId = branch_id || req.user?.branch_id || 0;

    let errorImage = null;

    // 1. Check if an image is uploaded as a multipart file
    if (req.files && (req.files.image || req.files['image'])) {
      const savedFiles = await uploadFile(
        req,
        res,
        constants.FACE_ERROR_FOLDER || "employee/face_errors/",
        t
      );
      errorImage = savedFiles.image || savedFiles['image'];
    }
    // 2. Check if the image is provided as a base64 string
    else if (base64Image) {
      errorImage = await uploadBase64File(
        base64Image,
        constants.FACE_ERROR_FOLDER || "employee/face_errors/",
        t
      );
    }

    if (!errorImage) {
      await t.rollback();
      return res.error(constants.VALIDATION_ERROR, "An error image (file or base64) is required");
    }

    // Save to database
    const faceError = await FaceRecognitionError.create({
      image: errorImage,
      accuracy: accuracy ? parseFloat(accuracy) : null,
      time: dayjs(time).toDate(),
      company_id: finalCompanyId,
      branch_id: finalBranchId,
      employee_id: employee_id || null,
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      status: 0, // Active
      matches: matches ? (typeof matches === 'string' ? JSON.parse(matches) : matches) : null,
      face_vector: face_vector ? (typeof face_vector === 'string' ? JSON.parse(face_vector) : face_vector) : null,
      message: finalMessage
    }, { transaction: t });

    await t.commit();

    return res.success(constants.ACTION_SUCCESSFUL, {
      message: "Face recognition error saved successfully",
      data: {
        id: faceError.id,
        image: faceError.image,
        image_url: `${process.env.FILE_SERVER_URL}${constants.FACE_ERROR_FOLDER || "employee/face_errors/"}${faceError.image}`,
        accuracy: faceError.accuracy,
        time: faceError.time,
        company_id: faceError.company_id,
        branch_id: faceError.branch_id,
        employee_id: faceError.employee_id,
        latitude: faceError.latitude,
        longitude: faceError.longitude,
        matches: faceError.matches,
        face_vector: faceError.face_vector,
        message: faceError.message
      }
    });

  } catch (err) {
    await t.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Get Face Recognition Error Logs (Paginated & Filtered)
 */
exports.getFaceRecognitionErrors = async (req, res) => {
  await ensureFaceRecognitionErrorSynced(req.tenantPrefix);
  try {
    const { page, limit, startDate, endDate } = req.body;
    let where = {};
    if (startDate && endDate) {
      where.time = {
        [Op.between]: [
          dayjs(startDate).startOf('day').toDate(),
          dayjs(endDate).endOf('day').toDate()
        ]
      };
    } else if (startDate) {
      where.time = {
        [Op.gte]: dayjs(startDate).startOf('day').toDate()
      };
    } else if (endDate) {
      where.time = {
        [Op.lte]: dayjs(endDate).endOf('day').toDate()
      };
    }

    const fieldConfig = [];

    const payloadForPagination = { ...req.body, status: req.body.status !== undefined ? req.body.status : 0 };
    delete payloadForPagination.startDate;
    delete payloadForPagination.endDate;

    const result = await commonQuery.fetchPaginatedData(
      FaceRecognitionError,
      payloadForPagination,
      fieldConfig,
      {
        include: [
          {
            model: BranchMaster,
            as: "branch",
            attributes: ["id", "branch_name"]
          },
          {
            model: Employee,
            as: "employee",
            attributes: ["id", "first_name", "employee_code", "profile_image", "registered_face_images"],
            required: false
          },
          {
            model: CompanyMaster,
            as: "company",
            attributes: ["id", "company_name"],
            required: false
          }
        ],
        order: [['time', 'DESC']]
      },
      { company_id: true },
      "time",
      where
    );

    // Format URLs for images safely (handling both plain objects and Sequelize instances)
    result.items.forEach(item => {
      const imageUrl = item.image ? `${process.env.FILE_SERVER_URL}${constants.FACE_ERROR_FOLDER || "employee/face_errors/"}${item.image}` : null;
      if (typeof item.setDataValue === 'function') {
        item.setDataValue('image_url', imageUrl);
      } else {
        item.image_url = imageUrl;
      }

      if (item.employee) {
        let profileImage = item.employee.profile_image;
        if (!profileImage && item.employee.registered_face_images) {
          try {
            const parsed = typeof item.employee.registered_face_images === 'string'
              ? JSON.parse(item.employee.registered_face_images)
              : item.employee.registered_face_images;
            if (Array.isArray(parsed) && parsed.length > 0) {
              profileImage = parsed[0];
            }
          } catch (e) {
            console.error("Error parsing registered_face_images:", e);
          }
        }
        const profileImageUrl = profileImage ? `${process.env.FILE_SERVER_URL}${constants.EMPLOYEE_IMG_FOLDER}${profileImage}` : null;
        if (typeof item.employee.setDataValue === 'function') {
          item.employee.setDataValue('profile_image_url', profileImageUrl);
        } else {
          item.employee.profile_image_url = profileImageUrl;
        }
      }
    });

    // Count stats for tabs safely (respecting company scoping/master admin bypass)
    const activeStatsCount = await commonQuery.countRecords(FaceRecognitionError, { ...where, status: 0 }, {}, true);
    const resolvedStatsCount = await commonQuery.countRecords(FaceRecognitionError, { ...where, status: 1 }, {}, true);
    const totalStatsCount = activeStatsCount + resolvedStatsCount;

    result.stats = {
      active: activeStatsCount,
      resolved: resolvedStatsCount,
      total: totalStatsCount
    };

    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Update Face Recognition Error Status (Resolve/Archive)
 */
exports.resolveFaceRecognitionError = async (req, res) => {
  try {
    const { id, status, employee_id } = req.body;

    if (!id) {
      return res.error(constants.VALIDATION_ERROR, "ID is required");
    }

    const faceError = await commonQuery.findOneRecord(FaceRecognitionError, { id }, {}, null, false, { company_id: true });

    if (!faceError) {
      return res.error(constants.NOT_FOUND, "Face recognition error log not found");
    }

    const empId = parseInt(employee_id);
    const vec = faceError.face_vector;

    // Validate before marking as resolved
    if (empId) {
      await ensureAlignedTemplatesColumn();
      const employee = await commonQuery.findOneRecord(Employee, { id: empId }, {}, null, false, {});
      if (!employee) {
        return res.error(constants.NOT_FOUND, "Employee not found");
      }

      // Validation 1: Employee must be registered with face descriptor
      let fd = employee.face_descriptor;
      if (fd && typeof fd === 'string') {
        try {
          fd = JSON.parse(fd);
        } catch (e) {
          fd = null;
        }
      }
      const hasFD = Array.isArray(fd) && fd.length > 0;
      if (!hasFD) {
        return res.error(constants.VALIDATION_ERROR, "Employee does not have a registered face. Please register the employee's face first before resolving.");
      }

      // Validation 2: The error face must belong to the same person.
      // Compare against BOTH enrolled (face_descriptor) and aligned
      // (aligned_face_templates) galleries — the error's face_vector may
      // be from either embedding space.
      if (Array.isArray(vec) && vec.length >= 10) {
        let bestSim = 0;

        // Check enrolled vectors
        const enrolledVectors = Array.isArray(fd[0]) ? fd : [fd];
        for (const enrolled of enrolledVectors) {
          if (!Array.isArray(enrolled) || enrolled.length < 10) continue;
          const sim = adaptiveCosineSim(vec, enrolled);
          if (sim > bestSim) bestSim = sim;
        }

        // Check aligned templates (same embedding space as error face_vector)
        const alignedTemplates = Array.isArray(employee.aligned_face_templates)
          ? employee.aligned_face_templates : [];
        for (const at of alignedTemplates) {
          if (!Array.isArray(at) || at.length < 10) continue;
          const sim = adaptiveCosineSim(vec, at);
          if (sim > bestSim) bestSim = sim;
        }

        if (bestSim < 0.45) {
          return res.error(constants.VALIDATION_ERROR, `This face does not match the selected employee (similarity: ${(bestSim * 100).toFixed(1)}%). Please select the correct employee.`);
        }
      }
    }

    // All validations passed — now mark as resolved
    const updateData = { status: status !== undefined ? status : 1 }; // 1 = Resolved
    if (employee_id) updateData.employee_id = empId;

    await commonQuery.updateRecordById(
      FaceRecognitionError,
      id,
      updateData,
      null,
      false,
      { company_id: true }
    );

    if (empId) {
      try {
        const employee = await commonQuery.findOneRecord(Employee, { id: empId }, {}, null, false, {});
        {
          const empUpdateData = {};

          // A. Store the face_vector in aligned_face_templates + aligned_face_images
          const filename = faceError.image;
          const destDir = path.join(process.cwd(), "uploads", constants.EMPLOYEE_IMG_FOLDER || "employee/images/");

          if (Array.isArray(vec) && vec.length >= 10) {
            let list = Array.isArray(employee.aligned_face_templates)
              ? [...employee.aligned_face_templates] : [];
            let imgList = Array.isArray(employee.aligned_face_images)
              ? [...employee.aligned_face_images] : [];
            while (imgList.length < list.length) imgList.push(null);

            let dup = false;
            for (const t of list) {
              if (adaptiveCosineSim(vec, t) >= ALIGNED_TEMPLATES.dupSimilarity) { dup = true; break; }
            }
            if (!dup) {
              list.push(vec);
              imgList.push(filename || null);

              while (list.length > ALIGNED_TEMPLATES.maxPerEmployee) {
                list.shift();
                const evictedImg = imgList.shift();
                if (evictedImg) {
                  try {
                    const evictPath = path.join(destDir, evictedImg);
                    if (fs.existsSync(evictPath)) {
                      fs.unlinkSync(evictPath);
                      console.log(`[Resolve] 🗑️ Emp #${empId}: evicted aligned image ${evictedImg}`);
                    }
                  } catch (e) {
                    console.error(`[Resolve] Failed to delete evicted image:`, e.message);
                  }
                }
              }

              empUpdateData.aligned_face_templates = list;
              empUpdateData.aligned_face_images = imgList;
              employee.changed('aligned_face_templates', true);
              employee.changed('aligned_face_images', true);
            }
          }

          // B. Copy the physical image and save to profile_image
          if (filename) {
            const sourcePath = path.join(process.cwd(), "uploads", constants.FACE_ERROR_FOLDER || "employee/face_errors/", filename);
            const destPath = path.join(destDir, filename);

            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }

            if (fs.existsSync(sourcePath)) {
              fs.copyFileSync(sourcePath, destPath);
            }

            empUpdateData.profile_image = filename;

            await employee.update(empUpdateData);

            // Synchronize profile image with associated User
            const associatedUser = await commonQuery.findOneRecord(User, { employee_id: empId }, {});
            if (associatedUser) {
              const userDestDir = path.join(process.cwd(), "uploads", constants.USER_IMG_FOLDER);
              const userDestPath = path.join(userDestDir, filename);
              if (fs.existsSync(destPath)) {
                if (!fs.existsSync(userDestDir)) {
                  fs.mkdirSync(userDestDir, { recursive: true });
                }
                fs.copyFileSync(destPath, userDestPath);
              }
              await associatedUser.update({ profile_image: filename });
            }
          } else if (Object.keys(empUpdateData).length > 0) {
            await employee.update(empUpdateData);
          }
          console.log(`[Resolve→Template] ✅ Emp #${empId} verification synchronized.`);
        } // end block
      } catch (tplErr) {
        console.error(`[Resolve→Template] ⚠️ Failed to save template/image for emp #${empId}:`, tplErr.message);
      }
    }

    return res.ok({ message: "Face recognition error status updated successfully" });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Delete Face Recognition Error Log
 */
exports.deleteFaceRecognitionError = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.error(constants.VALIDATION_ERROR, "ID is required");

    await commonQuery.hardDeleteRecords(FaceRecognitionError, id, null, false, { company_id: true });
    return res.ok({ message: "Face recognition error log deleted successfully" });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET ATTENDANCE IRREGULARITIES (Missing Punch In or Punch Out)
 * Supported roles logic:
 * - SuperAdmin/Admin: Show all employee irregularities within their company_id
 * - Attendance Supervisor/Reporting Manager: Show their team members' irregularities
 * - Regular Employee: Will not return any data (should use self-irregularities)
 */
exports.getIrregularities = async (req, res) => {
  try {
    let { employee_id, month_year, page, limit, search } = req.body;
    page = parseInt(page) || 1;
    limit = parseInt(limit) || 15;
    const offset = (page - 1) * limit;

    const companyId = req.user.company_id;
    const minAllowedDate = dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
    const maxAllowedDate = dayjs().endOf('month').format('YYYY-MM-DD');

    // Date range determination
    let startDate, endDate;
    if (month_year) {
      const parsedMonth = dayjs(month_year.trim(), ["MMM YYYY", "MMMM YYYY", "YYYY-MM", "MM-YYYY", "YYYY-M", "M-YYYY"]);
      if (parsedMonth.isValid()) {
        startDate = parsedMonth.startOf('month').format('YYYY-MM-DD');
        endDate = parsedMonth.endOf('month').format('YYYY-MM-DD');

        if (startDate < minAllowedDate || startDate > maxAllowedDate) {
          return res.error(constants.VALIDATION_ERROR, { message: "Only the current month and the past month irregularities can be accessed." });
        }
      }
    }

    // Determine target employee list
    let targetEmployeeIds = [];
    let isFilteredByEmployees = true;

    const isAdmin = req.user.is_super_admin || req.user.is_admin;
    const isSupervisorOrManager = req.user.role_key === constants.ROLE_KEYS.REPORTING_MANAGER ||
      req.user.is_reporting_manager ||
      req.user.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR ||
      req.user.is_attendance_supervisor;

    if (isAdmin) {
      // Admin sees everyone in their company
      const trackedEmployees = await EmployeeAttendanceTemplate.findAll({
        where: { company_id: companyId, status: 0, track_in_out: true },
        attributes: ['employee_id']
      });
      targetEmployeeIds = trackedEmployees.map(e => e.employee_id);
      isFilteredByEmployees = true;
    } else if (isSupervisorOrManager) {
      // Supervisor / manager sees themselves + their team
      const ownEmpId = req.user.employee_id;
      const teamEmployees = await commonQuery.findAllRecords(Employee, {
        [Op.or]: [
          { attendance_supervisor: req.user.id },
          { reporting_manager: req.user.id }
        ],
        status: { [Op.in]: [0, 1, 2] },
        company_id: companyId
      }, { attributes: ['id'] });

      const teamEmpIds = teamEmployees.map(e => e.id);

      const trackedEmployees = await EmployeeAttendanceTemplate.findAll({
        where: { company_id: companyId, status: 0, track_in_out: true, employee_id: { [Op.in]: teamEmpIds } },
        attributes: ['employee_id']
      });
      const validTrackedEmpIds = trackedEmployees.map(t => t.employee_id);

      targetEmployeeIds = [...new Set(validTrackedEmpIds)];
    } else {
      // Regular employee: shouldn't see anything here, they should use self-irregularities
      targetEmployeeIds = [];
    }

    // Construct query filters
    const whereClause = {
      company_id: companyId,
      [Op.or]: [
        { status: { [Op.in]: [9, 10, 14] } },
        {
          [Op.and]: [
            { status: 0 },
            { first_in: null },
            { last_out: null }
          ]
        },
        {
          [Op.and]: [
            { first_in: null },
            { last_out: { [Op.ne]: null } }
          ]
        },
        {
          [Op.and]: [
            { first_in: { [Op.ne]: null } },
            { last_out: null }
          ]
        }
      ],
      // Exclude Weekly Off, Holiday, and Leave status. Present/Absent/HalfDay can have irregularity
      status: { [Op.notIn]: [3, 4, 6] }
    };

    if (isFilteredByEmployees) {
      if (targetEmployeeIds.length === 0) {
        return res.ok({
          items: [],
          totalItems: 0,
          currentPage: page,
          totalPages: 0
        });
      }
      whereClause.employee_id = { [Op.in]: targetEmployeeIds };
    }

    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    if (startDate && endDate) {
      const finalEndDate = endDate > yesterday ? yesterday : endDate;
      if (startDate > finalEndDate) {
        return res.ok({ items: [], totalItems: 0, currentPage: page, totalPages: 0 });
      }
      whereClause.attendance_date = {
        [Op.between]: [startDate, finalEndDate]
      };
    } else {
      whereClause.attendance_date = {
        [Op.between]: [minAllowedDate, yesterday]
      };
    }

    // If specific employee filter is requested in body (useful for manager/admin viewing single team member)
    if (employee_id) {
      const requestedEmpId = parseInt(employee_id);
      if (isFilteredByEmployees) {
        // Must be within authorized team
        if (targetEmployeeIds.includes(requestedEmpId)) {
          whereClause.employee_id = requestedEmpId;
        } else {
          return res.error(constants.UNAUTHORIZED, "Access denied to requested employee's irregularities");
        }
      } else {
        whereClause.employee_id = requestedEmpId;
      }
    }

    let employeeWhereClause = undefined;
    if (search && search.trim() !== '') {
      employeeWhereClause = {
        [Op.or]: [
          { first_name: { [Op.iLike]: `%${search.trim()}%` } },
          { employee_code: { [Op.iLike]: `%${search.trim()}%` } }
        ]
      };
    }

    const { count, rows } = await AttendanceDay.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: Employee,
          as: "employee",
          attributes: ["id", "first_name", "employee_code"],
          required: true,
          where: employeeWhereClause
        },
        {
          model: ShiftTemplate,
          as: "shiftTemplate",
          attributes: ["id", "shift_name", "start_time", "end_time"]
        }
      ],
      order: [["attendance_date", "DESC"]],
      limit,
      offset
    });

    return res.ok({
      items: rows,
      totalItems: count,
      currentPage: page,
      totalPages: Math.ceil(count / limit)
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET ATTENDANCE IRREGULARITIES COUNT
 * Supported roles logic (matching getIrregularities):
 * - SuperAdmin/Admin: Show count of all employee irregularities within their company_id
 * - Attendance Supervisor/Reporting Manager: Show count of team members' irregularities
 * - Regular Employee: Will not return any data
 */
exports.getIrregularitiesCount = async (req, res) => {
  try {
    const companyId = req.user.company_id;

    // Always get the current month date boundaries
    const startDate = dayjs().startOf('month').format('YYYY-MM-DD');
    let endDate = dayjs().endOf('month').format('YYYY-MM-DD');
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    if (endDate > yesterday) {
      endDate = yesterday;
    }

    if (startDate > endDate) {
      return res.ok({ count: 0, selfCount: 0 });
    }

    // Determine target employee list
    let targetEmployeeIds = [];
    let isFilteredByEmployees = true;

    const isAdmin = req.user.is_super_admin || req.user.is_admin;
    const isSupervisorOrManager = req.user.role_key === constants.ROLE_KEYS.REPORTING_MANAGER ||
      req.user.is_reporting_manager ||
      req.user.role_key === constants.ROLE_KEYS.ATTENDANCE_SUPERVISOR ||
      req.user.is_attendance_supervisor;

    if (isAdmin) {
      // Admin sees everyone in their company
      const trackedEmployees = await EmployeeAttendanceTemplate.findAll({
        where: { company_id: companyId, status: 0, track_in_out: true },
        attributes: ['employee_id']
      });
      targetEmployeeIds = trackedEmployees.map(e => e.employee_id);
      isFilteredByEmployees = true;
    } else if (isSupervisorOrManager) {
      // Supervisor / manager sees themselves + their team
      const teamEmployees = await commonQuery.findAllRecords(Employee, {
        [Op.or]: [
          { attendance_supervisor: req.user.id },
          { reporting_manager: req.user.id }
        ],
        status: { [Op.in]: [0, 1, 2] },
        company_id: companyId
      }, { attributes: ['id'] });

      const teamEmpIds = teamEmployees.map(e => e.id);

      const trackedEmployees = await EmployeeAttendanceTemplate.findAll({
        where: { company_id: companyId, status: 0, track_in_out: true, employee_id: { [Op.in]: teamEmpIds } },
        attributes: ['employee_id']
      });
      const validTrackedEmpIds = trackedEmployees.map(t => t.employee_id);

      targetEmployeeIds = [...new Set(validTrackedEmpIds)];
    } else {
      // Regular employee: shouldn't see anything here, they should use self-irregularities
      targetEmployeeIds = [];
    }

    const baseWhereClause = {
      company_id: companyId,
      attendance_date: {
        [Op.between]: [startDate, endDate],
        [Op.lt]: dayjs().format('YYYY-MM-DD')
      },
      [Op.or]: [
        { status: { [Op.in]: [9, 10, 14] } },
        { [Op.and]: [{ status: 0 }, { first_in: null }, { last_out: null }] },
        { [Op.and]: [{ first_in: null }, { last_out: { [Op.ne]: null } }] },
        { [Op.and]: [{ first_in: { [Op.ne]: null } }, { last_out: null }] }
      ],
      status: { [Op.notIn]: [3, 4, 6] }
    };

    // Calculate team count (NO active regularization exclusion, as per getIrregularities)
    let count = 0;
    if (isFilteredByEmployees) {
      if (targetEmployeeIds.length > 0) {
        count = await AttendanceDay.count({
          where: { ...baseWhereClause, employee_id: { [Op.in]: targetEmployeeIds } }
        });
      }
    } else {
      count = await AttendanceDay.count({
        where: baseWhereClause
      });
    }

    // Calculate selfCount (WITH active regularization exclusion, as per getSelfIrregularities)
    let selfCount = 0;
    const currentEmpId = req.user.employee_id;
    if (currentEmpId) {
      const selfWhereClause = {
        ...baseWhereClause,
        employee_id: currentEmpId
      };

      const activeRegularizations = await AttendanceRegularization.findAll({
        where: {
          company_id: companyId,
          employee_id: currentEmpId,
          approval_status: { [Op.in]: [0, 1, 3] },
          status: 0,
          attendance_date: { [Op.between]: [startDate, endDate] }
        },
        attributes: ['employee_id', 'attendance_date']
      });

      if (activeRegularizations.length > 0) {
        const exclusionConditions = activeRegularizations.map(reg => ({
          employee_id: reg.employee_id,
          attendance_date: dayjs(reg.attendance_date).format('YYYY-MM-DD')
        }));
        selfWhereClause[Op.and] = [
          {
            [Op.not]: {
              [Op.or]: exclusionConditions
            }
          }
        ];
      }

      selfCount = await AttendanceDay.count({
        where: selfWhereClause
      });
    }

    return res.ok({ count, selfCount });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET SELF ATTENDANCE IRREGULARITIES (Missing Punch In or Punch Out)
 * Shows only own irregularities for the current month by default
 */
exports.getSelfIrregularities = async (req, res) => {
  try {
    let { month_year, page, limit, search } = req.body;
    page = parseInt(page) || 1;
    limit = parseInt(limit) || 15;
    const offset = (page - 1) * limit;

    const companyId = req.user.company_id;
    const ownEmpId = req.user.employee_id;

    if (!ownEmpId) {
      return res.error(constants.VALIDATION_ERROR, "No employee profile linked to user");
    }

    const hasTracking = await EmployeeAttendanceTemplate.findOne({
      where: { employee_id: ownEmpId, status: 0, track_in_out: true },
      attributes: ['id']
    });

    if (!hasTracking) {
      return res.ok({ items: [], totalItems: 0, currentPage: page, totalPages: 0 });
    }

    // Date range determination
    let startDate, endDate;
    if (month_year) {
      const parsedMonth = dayjs(month_year.trim(), ["MMM YYYY", "MMMM YYYY", "YYYY-MM", "MM-YYYY", "YYYY-M", "M-YYYY"]);
      if (parsedMonth.isValid()) {
        startDate = parsedMonth.startOf('month').format('YYYY-MM-DD');
        endDate = parsedMonth.endOf('month').format('YYYY-MM-DD');
      }
    } else {
      startDate = dayjs().startOf('month').format('YYYY-MM-DD');
      endDate = dayjs().endOf('month').format('YYYY-MM-DD');
    }

    const whereClause = {
      company_id: companyId,
      employee_id: ownEmpId,
      [Op.or]: [
        { status: { [Op.in]: [9, 10, 14] } },
        {
          [Op.and]: [
            { status: 0 },
            { first_in: null },
            { last_out: null }
          ]
        },
        {
          [Op.and]: [
            { first_in: null },
            { last_out: { [Op.ne]: null } }
          ]
        },
        {
          [Op.and]: [
            { first_in: { [Op.ne]: null } },
            { last_out: null }
          ]
        }
      ],
      status: { [Op.notIn]: [3, 4, 6] }
    };

    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    if (startDate && endDate) {
      const finalEndDate = endDate > yesterday ? yesterday : endDate;
      if (startDate > finalEndDate) {
        return res.ok({ items: [], totalItems: 0, currentPage: page, totalPages: 0 });
      }
      whereClause.attendance_date = {
        [Op.between]: [startDate, finalEndDate]
      };
    } else {
      whereClause.attendance_date = {
        [Op.lte]: yesterday
      };
    }

    const regWhere = {
      company_id: companyId,
      employee_id: ownEmpId,
      approval_status: { [Op.in]: [0, 1, 3] },
      status: 0
    };
    if (whereClause.attendance_date) {
      if (whereClause.attendance_date[Op.between]) {
        regWhere.attendance_date = {
          [Op.gte]: dayjs(whereClause.attendance_date[Op.between][0]).startOf('day').toDate(),
          [Op.lte]: dayjs(whereClause.attendance_date[Op.between][1]).endOf('day').toDate()
        };
      } else if (whereClause.attendance_date[Op.lte]) {
        regWhere.attendance_date = {
          [Op.lte]: dayjs(whereClause.attendance_date[Op.lte]).endOf('day').toDate()
        };
      }
    }

    const activeRegularizations = await AttendanceRegularization.findAll({
      where: regWhere,
      attributes: ['employee_id', 'attendance_date']
    });

    if (activeRegularizations.length > 0) {
      const exclusionConditions = activeRegularizations.map(reg => ({
        employee_id: reg.employee_id,
        attendance_date: dayjs(reg.attendance_date).format('YYYY-MM-DD')
      }));
      whereClause[Op.and] = [
        {
          [Op.not]: {
            [Op.or]: exclusionConditions
          }
        }
      ];
    }

    let employeeWhereClause = undefined;
    if (search && search.trim() !== '') {
      employeeWhereClause = {
        [Op.or]: [
          { first_name: { [Op.iLike]: `%${search.trim()}%` } },
          { employee_code: { [Op.iLike]: `%${search.trim()}%` } }
        ]
      };
    }

    const { count, rows } = await AttendanceDay.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: Employee,
          as: "employee",
          attributes: ["id", "first_name", "employee_code"],
          required: true,
          where: employeeWhereClause
        },
        {
          model: ShiftTemplate,
          as: "shiftTemplate",
          attributes: ["id", "shift_name", "start_time", "end_time"]
        }
      ],
      order: [["attendance_date", "DESC"]],
      limit,
      offset
    });

    return res.ok({
      items: rows,
      totalItems: count,
      currentPage: page,
      totalPages: Math.ceil(count / limit)
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * GET SELF ATTENDANCE IRREGULARITIES COUNT
 */
exports.getSelfIrregularitiesCount = async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const ownEmpId = req.user.employee_id;

    if (!ownEmpId) {
      return res.ok({ count: 0 });
    }

    const hasTracking = await EmployeeAttendanceTemplate.findOne({
      where: { employee_id: ownEmpId, status: 0, track_in_out: true },
      attributes: ['id']
    });

    if (!hasTracking) {
      return res.ok({ count: 0 });
    }

    const startDate = dayjs().startOf('month').format('YYYY-MM-DD');
    let endDate = dayjs().endOf('month').format('YYYY-MM-DD');
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    if (endDate > yesterday) {
      endDate = yesterday;
    }

    if (startDate > endDate) {
      return res.ok({ count: 0 });
    }

    const baseWhere = {
      company_id: companyId,
      employee_id: ownEmpId,
      attendance_date: {
        [Op.between]: [startDate, endDate]
      },
      [Op.or]: [
        { status: { [Op.in]: [9, 10, 14] } },
        {
          [Op.and]: [
            { status: 0 },
            { first_in: null },
            { last_out: null }
          ]
        },
        {
          [Op.and]: [
            { first_in: null },
            { last_out: { [Op.ne]: null } }
          ]
        },
        {
          [Op.and]: [
            { first_in: { [Op.ne]: null } },
            { last_out: null }
          ]
        }
      ],
      status: { [Op.notIn]: [3, 4, 6] }
    };

    const regWhere = {
      company_id: companyId,
      employee_id: ownEmpId,
      approval_status: { [Op.in]: [0, 1, 3] },
      status: 0,
      attendance_date: {
        [Op.gte]: dayjs(startDate).startOf('day').toDate(),
        [Op.lte]: dayjs(endDate).endOf('day').toDate()
      }
    };
    const activeRegularizations = await AttendanceRegularization.findAll({
      where: regWhere,
      attributes: ['employee_id', 'attendance_date']
    });

    if (activeRegularizations.length > 0) {
      const exclusionConditions = activeRegularizations.map(reg => ({
        employee_id: reg.employee_id,
        attendance_date: dayjs(reg.attendance_date).format('YYYY-MM-DD')
      }));
      baseWhere[Op.and] = [
        {
          [Op.not]: {
            [Op.or]: exclusionConditions
          }
        }
      ];
    }

    const count = await AttendanceDay.count({
      where: baseWhere
    });

    return res.ok({ count });
  } catch (err) {
    return handleError(err, res, req);
  }
};