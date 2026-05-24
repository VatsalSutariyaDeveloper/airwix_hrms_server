const { Worker } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const fsPromises = fs.promises;
const readline = require('readline');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { validateRequest, handleError, constants, commonQuery, sequelize, Op } = require("../../../helpers");
const { Employee, LeaveTemplateCategory, EmployeeLeaveBalance } = require("../../../models");

/**
 * Controller: Import Data
 * Handles the HTTP request, spawns a worker, and manages the response.
 * Handles CLIENT DISCONNECTION to abort worker.
 */
exports.importData = async (req, res) => {
  let worker = null;
  let isAborted = false;
  let cancelTimeout = null;
  let keepErrorLog = false; // Flag to preserve file temporarily
  
  try {
    // 1. Validate Basic Request
    const indentErrors = await validateRequest(req.body, {
      entity_name: "Select Entity",
    });

    if (indentErrors) {
      if (req.file && req.file.path) fs.unlinkSync(req.file.path);
      return res.error(constants.VALIDATION_ERROR,  indentErrors );
    }

    let workerScriptPath = null;
    // console.log("ENTITY NAME RECEIVED:", `"${req.body.entity_name}"`);

    if (req.body.entity_name === "Employee Import") {
       workerScriptPath = "./employeeImport.js";
      } else if (req.body.entity_name === "Item Import") {
        workerScriptPath = "./itemImport.js";
      } else if (req.body.entity_name === "Leave Import") {
        workerScriptPath = "./leaveImport.js";
      } else if (req.body.entity_name === "Attendance Import") {
        workerScriptPath = "./attendanceImport.js";
      } else if (req.body.entity_name === "Daily Attendance Import") {
        workerScriptPath = "./dailyAttendanceImport.js";
      } else if (req.body.entity_name === "Payroll Import") {
        workerScriptPath = "./payrollImport.js";
      } else if (req.body.entity_name === "Salary Structure Import") {
        workerScriptPath = "./salaryStructureImport.js";
      } else {
        if (req.file && req.file.path) fs.unlinkSync(req.file.path);
        return res.error(constants.VALIDATION_ERROR, { errors: ["Invalid Entity Name"] });
      }
      if (!req.file || !req.file.path) {
        return res.error(constants.VALIDATION_ERROR, { errors: ["Excel file is required"] });
      }

      const errorKey = crypto.randomUUID();
      const uploadDir = path.dirname(req.file.path);
      const errorLogPath = path.join(uploadDir, `${errorKey}_errors.jsonl`);
      const workerPath = path.resolve(__dirname, workerScriptPath);

      worker = new Worker(workerPath, {
        workerData: {
          filePath: req.file.path,
          errorLogPath: errorLogPath,
          body: req.body,
          user_id: req.user ? req.user.id : req.body.user_id,
          branch_id: req.user ? req.user.branch_id : req.body.branch_id,
          company_id: req.user ? req.user.company_id : req.body.company_id,
          is_super_admin: req.user ? req.user.is_super_admin : false,
          branch_access: req.user ? req.user.branch_access : "",
        }
      });

      const abortImport = () => {
        if (isAborted || !worker) return;
        console.warn("Client aborted. Aborting worker...");
        isAborted = true;
        worker.postMessage({ command: "ABORT" });

        cancelTimeout = setTimeout(() => {
          if (worker) {
            console.error("Worker did not exit gracefully. Force killing.");
            worker.terminate();
          }
        }, 8000);
      };

      req.on("aborted", abortImport);
      req.on("close", () => { if (!isAborted) abortImport(); });
      req.connection?.on("close", abortImport);

      // 4. Handle Worker Events
      worker.on("message", (msg) => {
        if (res.headersSent) return;
        
        if (msg.status === "SUCCESS") {
          const result = msg.result;

          if (result.importErrors) {
            keepErrorLog = true;
            setTimeout(() => {
              if (fs.existsSync(errorLogPath)) {
                fs.unlink(errorLogPath, (err) => {
                  if (!err) console.log(`Auto-cleaned expired error file: ${errorKey}`);
                });
              }
            }, 300000);

            return res.error(constants.VALIDATION_ERROR, {
              errorKey: errorKey,
              errorCount: result.errorCount,
              skippedCount: result.skippedCount,
              ...result.errors,
            }
            );
          }

          if (fs.existsSync(errorLogPath)) {
            fs.unlink(errorLogPath, () => { });
          }

          return res.success(constants.ITEM_CREATED, {
            message: result.message,
            count: result.count,
            skipped: result.skipped,
            summary: result.summary,
            errors: result.errors // Include error messages
          });
        }
        else if (msg.status === "ERROR") {
          return res.error(constants.SERVER_ERROR, { message: msg.error });
        } else if (msg.status === "CANCELLED") {
          console.log("✅ Worker confirmed cancellation.");
          if (cancelTimeout) clearTimeout(cancelTimeout);
          if (!res.headersSent) res.status(499).send("Client cancelled.");
          worker.terminate();
        }
      });

      worker.on("error", (err) => {
        console.error("Worker Thread Error:", err);
        if (!res.headersSent) {
          return res.error(constants.SERVER_ERROR, { message: "Import worker failed unexpectedly." });
        }
      });

      worker.on("exit", (code) => {
        if (cancelTimeout) clearTimeout(cancelTimeout);
        try {
          if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
          // Only delete error log if NOT waiting for user download
          if (!keepErrorLog && fs.existsSync(errorLogPath)) {
            fs.unlinkSync(errorLogPath);
          }
        } catch (cleanupErr) {
          console.error("Failed to delete temp files", cleanupErr);
        }
        worker = null;
        console.log(`Worker exited with code ${code}`);
      });

    } catch (err) {
      console.error("Import Controller Error:", err);
      if (req.file && req.file.path) fs.unlinkSync(req.file.path);
      return handleError(err, res, req);
    }
  };

  /**
   * Controller: Download Leave Sample Excel
   * Generates a template with active employees and their current leave balances.
   */
  exports.downloadLeaveSample = async (req, res) => {
    try {
      const company_id = req.user.company_id;
      const currentYear = new Date().getFullYear();

      // 1. Fetch all active employees
      const employees = await Employee.findAll({
        where: {
          company_id,
          status: 0 // Active
        },
        attributes: ['id', 'employee_code', 'first_name'],
        order: [['first_name', 'ASC']]
      });

      // 2. Fetch all unique leave categories for this company
      const categories = await LeaveTemplateCategory.findAll({
        where: { 
          company_id, 
          status: 0,
          is_paid: true 
        },
        attributes: [
          [sequelize.fn('DISTINCT', sequelize.col('leave_category_name')), 'leave_category_name']
        ],
        order: [['leave_category_name', 'ASC']],
        raw: true
      });

      // 3. Fetch current balances for these employees and categories
      const balances = await EmployeeLeaveBalance.findAll({
        where: {
          company_id,
          year: currentYear,
          employee_id: { [Op.in]: employees.map(e => e.id) }
        },
        attributes: ['employee_id', 'leave_category_name', 'total_allocated'],
        raw: true
      });

      // Organize balances by employee_id and category_name
      const balanceMap = {};
      balances.forEach(b => {
        if (!balanceMap[b.employee_id]) balanceMap[b.employee_id] = {};
        balanceMap[b.employee_id][b.leave_category_name] = b.total_allocated;
      });

      // 4. Create Workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Leave Import Sample");

      // Define Columns
      const columns = [
        { header: "Employee Code", key: "employee_code", width: 15 },
        { header: "Employee Name", key: "employee_name", width: 25 },
      ];

      categories.forEach(cat => {
        columns.push({ header: cat.leave_category_name, key: cat.leave_category_name, width: 20 });
      });

      worksheet.columns = columns;

      // Add Rows
      employees.forEach(emp => {
        const row = {
          employee_code: emp.employee_code,
          employee_name: emp.first_name
        };

        categories.forEach(cat => {
          // If no balance record exists for this category/employee, show '-' to indicate it's not applicable
          // This allows the import logic to skip these categories as requested earlier.
          row[cat.leave_category_name] = balanceMap[emp.id]?.hasOwnProperty(cat.leave_category_name) 
            ? balanceMap[emp.id][cat.leave_category_name] 
            : '-';
        });

        worksheet.addRow(row);
      });

      // Styling
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE6E6E6' }
      };

      // 5. Send Response
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="leave_import_sample.xlsx"');

      await workbook.xlsx.write(res);
      res.end();

    } catch (err) {
      console.error("Download Leave Sample Error:", err);
      return handleError(err, res, req);
    }
  };

  /**
   * Controller: Download Error File
   * Reconstructs the file path using the key and streams it as XLSX.
   */
  exports.downloadErrorFile = async (req, res) => {
    let tempFilePath = null;
    let fileStream = null;

    try {
      const { key } = req.query;
      if (!key) {
        return res.error(constants.VALIDATION_ERROR, { message: "Missing error key." });
      }

      const tempDir = path.join(process.cwd(), 'uploads', 'temp_imports');
      tempFilePath = path.join(tempDir, `${key}_errors.jsonl`);

      if (!fs.existsSync(tempFilePath)) {
        return res.error(constants.NOT_FOUND, { message: "Error file expired or not found." });
      }

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="rows_with_errors.xlsx"');

      fileStream = fs.createReadStream(tempFilePath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: res, useStyles: true, useSharedStrings: true
      });
      const worksheet = workbook.addWorksheet("Import Errors");

      let isFirstLine = true;
      for await (const line of rl) {
        if (!line) continue;
        try {
          const rowData = JSON.parse(line);
          if (isFirstLine) {
            const allHeaders = Object.keys(rowData);
            const errorHeader = allHeaders.find(h => h.toLowerCase() === 'error') || 'Error';
            const dataHeaders = allHeaders.filter(h => h.toLowerCase() !== 'error');
            const finalHeaders = [...dataHeaders, errorHeader];

            worksheet.columns = finalHeaders.map(header => ({
              header, key: header, width: header === errorHeader ? 60 : 15,
            }));
            worksheet.getRow(1).font = { bold: true };
            worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6E6' } };
            isFirstLine = false;
          }
          worksheet.addRow(rowData).commit();
        } catch (e) { }
      }
      await workbook.commit();

    } catch (err) {
      console.error("Download Error:", err);
      if (!res.headersSent) res.error(constants.SERVER_ERROR, { message: "Failed to generate file." });
    } finally {
      if (fileStream) {
        fileStream.close();
      }
    }
  };