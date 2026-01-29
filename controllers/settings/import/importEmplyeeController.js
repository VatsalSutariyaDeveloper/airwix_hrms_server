const { Worker } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const fsPromises = fs.promises;
const readline = require('readline');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { validateRequest, handleError, constants } = require("../../../helpers");

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
      field_mapping: "Select Mapping Fields",
    });

    if (indentErrors) {
      if (req.file && req.file.path) fs.unlinkSync(req.file.path);
      return res.error(constants.VALIDATION_ERROR, { errors: indentErrors });
    }

    let workerScriptPath = null;
    if (req.body.entity_name === "Employee Import") {
      workerScriptPath = "./employeeImport.js";
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

          return res.error(constants.VALIDATION_ERROR,{
              errorKey: errorKey, 
              errorCount: result.errorCount,
              skippedCount: result.skippedCount,
              ...result.errors,
            }
          );
        }

        if (fs.existsSync(errorLogPath)) {
            fs.unlink(errorLogPath, () => {}); 
        }

        return res.success(constants.ITEM_CREATED, {
          message: result.message,
          count: result.count,
          skipped: result.skipped,
          summary: result.summary
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
      return res.error(constants.SERVER_ERROR, { message: "Import worker failed unexpectedly." });
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