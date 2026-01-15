const responseCodes = require("./responseCodes");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const checkPermission = require("../middlewares/checkPermission");
const { normalizeValues } = require("../middlewares/normalizeNullValues");
const { constants } = require("./constants");
const { requestContext } = require("../utils/requestContext"); // ✅ IMPORT CONTEXT

// --- UTILITY FUNCTIONS ---
const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const cleanSubfolder = (subfolder) =>
  (subfolder || "")
    .split("/")
    .map((part) => part.replace(/[^a-zA-Z0-9-_]/g, ""))
    .filter(Boolean)
    .join("/");

// --- TRANSACTION ROLLBACK HOOK ---
const attachRollbackHook = (transaction, fullPath) => {
  if (transaction && typeof transaction.rollback === "function") {
    if (!transaction._uploadedFiles) {
      transaction._uploadedFiles = [];
      const originalRollback = transaction.rollback.bind(transaction);
      transaction.rollback = async function patchedRollback(...args) {
        for (const filePath of transaction._uploadedFiles) {
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
              console.log(`[Rollback] Deleted: ${filePath}`);
            } catch (err) {
              console.error(`[Rollback] Failed to delete: ${filePath}`, err);
            }
          }
        }
        return originalRollback(...args);
      };
    }
    transaction._uploadedFiles.push(fullPath);
  }
};

/**
 * Deletes a specified file.
 */
const deleteFile = async (req, res, folder, filename) => {
  if (!folder || !filename) return;
  const filePath = path.join(process.cwd(), "uploads", folder, filename);
  console.log("filePath", filePath);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[File System] Deleted: ${filePath}`);
    }
  } catch (err) {
    console.error(`File delete failed for ${filePath}:`, err.message);
  }
};

/**
 * Saves one or more buffered files.
 */
const uploadFile = async (
  req,
  res,
  subfolder = "",
  transaction = null,
  oldFileName = null
) => {
  let filesToProcess = [];

  // Handle single file upload
  if (req.file) {
    filesToProcess = [req.file];
  }
  // Handle multiple files in an array
  else if (Array.isArray(req.files)) {
    filesToProcess = req.files;
  }
  // Handle files in an object (keyed by field name)
  else if (typeof req.files === "object" && req.files !== null) {
    Object.keys(req.files).forEach((key) => {
      const fileOrFiles = req.files[key];
      if (Array.isArray(fileOrFiles)) {
        filesToProcess.push(...fileOrFiles);
      } else {
        filesToProcess.push(fileOrFiles);
      }
    });
  }

  if (filesToProcess.length === 0) {
    return {};
  }

  const savedFilenames = {};
  const baseDir = "uploads";
  const targetFolder = path.join(baseDir, cleanSubfolder(subfolder));
  ensureDir(targetFolder);

  for (const file of filesToProcess) {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    const filename = `${Date.now()}_${name}${ext}`;
    const fullPath = path.join(targetFolder, filename);

    try {
      fs.writeFileSync(fullPath, file.buffer);
      savedFilenames[file.fieldname] = filename;
      attachRollbackHook(transaction, fullPath);
    } catch (err) {
      console.error(`File write failed for ${file.originalname}:`, err);
      throw {
        code: responseCodes.FILE_UPLOAD_FAILED.code,
        status: responseCodes.FILE_UPLOAD_FAILED.status,
        message: `Failed to upload file: ${file.originalname}`,
      };
    }
  }
  if (Object.keys(savedFilenames).length > 0 && oldFileName) {
    await deleteFile(req, res, subfolder, oldFileName);
  }
  return savedFilenames;
};

// --- Middleware for multiple files ---
const bufferFile = (fieldNames, maxCount = 10) => {
  const maxSize = 5 * 1024 * 1024; // 5MB
  const storage = multer.memoryStorage();

  const fileFilter = (req, file, cb) => {
    const allowedExt = /\.(jpeg|jpg|png|webp|pdf|xls|xlsx)$/i;
    const allowedMime = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExt.test(ext) && allowedMime.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error("FILE_TYPE_NOT_ALLOWED");
      err.customCode = "FILE_TYPE_NOT_ALLOWED";
      cb(err);
    }
  };

  const multerInstance = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter,
  });

  let uploader;
  if (!fieldNames) {
    uploader = multerInstance.any();
  } else if (Array.isArray(fieldNames)) {
    const fields = fieldNames.map((name) => ({ name, maxCount }));
    uploader = multerInstance.fields(fields);
  } else {
    uploader = multerInstance.single(fieldNames);
  }

  return (req, res, next) => {
    // ✅ CAPTURE CONTEXT BEFORE MULTER RUNS
    const store = requestContext.getStore();

    uploader(req, res, (err) => {
      // ✅ DEFINE LOGIC TO RUN INSIDE CONTEXT
      const runLogic = () => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            const { code, status, message } = responseCodes.FILE_TOO_LARGE;
            return res.status(code).json({ status, message });
          }
          if (err.customCode === "FILE_TYPE_NOT_ALLOWED") {
            const { code, status, message } = responseCodes.FILE_TYPE_NOT_ALLOWED;
            return res.status(code).json({ status, message });
          }
          if (err instanceof multer.MulterError) {
            console.error("Multer Error:", err);
            const { code, status } = responseCodes.FILE_UPLOAD_FAILED;
            return res
              .status(code)
              .json({ status, message: `File upload error ${err.message}` });
          }
          const { code, status, message } = responseCodes.SERVER_ERROR;
          return res
            .status(code)
            .json({ status, message: "Server error during file processing." });
        }

        if (req.body && typeof req.body === "object") {
          normalizeValues(req.body);
        }

        // ✅ RUN PERMISSION CHECK (Since app.js skips it for multipart)
        checkPermission(req, res, next);
      };

      // ✅ RESTORE CONTEXT AND RUN LOGIC
      if (store) {
        requestContext.run(store, runLogic);
      } else {
        runLogic();
      }
    });
  };
};

// --- Middleware for multiple image fields ---
const bufferImage = (fieldNames) => {
  const maxSize = 5 * 1024 * 1024; // 5MB
  const storage = multer.memoryStorage();
  const fileFilter = (req, file, cb) => {
    const allowedExt = /\.(jpeg|jpg|png|webp)$/i;
    const allowedMime = ["image/jpeg", "image/png", "image/webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    if (allowedExt.test(ext) && allowedMime.includes(mime)) {
      cb(null, true);
    } else {
      const err = new Error("IMAGE_TYPE_NOT_ALLOWED");
      err.customCode = "IMAGE_TYPE_NOT_ALLOWED";
      cb(err);
    }
  };
  const multerHandler = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter,
  });

  return async (req, res, next) => {
    const uploader = fieldNames
      ? multerHandler.fields(
          Array.isArray(fieldNames)
            ? fieldNames.map((name) => ({ name, maxCount: 1 }))
            : [{ name: fieldNames, maxCount: 1 }]
        )
      : multerHandler.any();

    // ✅ CAPTURE CONTEXT
    const store = requestContext.getStore();

    uploader(req, res, async (err) => {
      // ✅ WRAP LOGIC
      const runLogic = () => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            const { code, status, message } = responseCodes.IMAGE_TOO_LARGE;
            return res.status(code).json({ status, message });
          }
          if (err.customCode === "IMAGE_TYPE_NOT_ALLOWED") {
            const { code, status, message } =
              responseCodes.IMAGE_TYPE_NOT_ALLOWED;
            return res.status(code).json({ status, message });
          }
          if (err instanceof multer.MulterError) {
            const { code, status } = responseCodes.IMAGE_UPLOAD_FAILED;
            return res
              .status(code)
              .json({
                status,
                message: `Image upload error: ${err.message}`,
              });
          }
        }
        if (req.body && typeof req.body === "object") {
          normalizeValues(req.body);
        }
        
        // ✅ RUN PERMISSION CHECK
        checkPermission(req, res, next);
      };

      // ✅ RESTORE CONTEXT
      if (store) {
        requestContext.run(store, runLogic);
      } else {
        runLogic();
      }
    });
  };
};

// --- Middleware for a single Excel file ---
const bufferExcel = (fieldName) => {
  const maxSize = 30 * 1024 * 1024; // 30MB
  const storage = multer.memoryStorage();

  const fileFilter = (req, file, cb) => {
    const allowedExt = /\.(xls|xlsx|csv)$/i;
    const allowedMime = [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "application/csv",
      "application/vnd.ms-excel",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExt.test(ext) && allowedMime.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error("EXCEL_FILE_ONLY");
      err.customCode = "EXCEL_FILE_ONLY";
      cb(err);
    }
  };

  const multerInstance = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter,
  });

  const uploader = multerInstance.single(fieldName);

  return (req, res, next) => {
    // ✅ CAPTURE CONTEXT
    const store = requestContext.getStore();

    uploader(req, res, (err) => {
      // ✅ WRAP LOGIC
      const runLogic = () => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            const { code, status, message } = responseCodes.FILE_TOO_LARGE;
            return res.status(code).json({ status, message });
          }
          if (err.customCode === "EXCEL_FILE_ONLY") {
            const { code, status } = responseCodes.FILE_TYPE_NOT_ALLOWED;
            return res
              .status(code)
              .json({
                status,
                message:
                  "Invalid file type. Only Excel files (.xls, .xlsx) are allowed.",
              });
          }
          if (err instanceof multer.MulterError) {
            console.error("Multer Error:", err);
            const { code, status } = responseCodes.FILE_UPLOAD_FAILED;
            return res
              .status(code)
              .json({ status, message: `File upload error: ${err.message}` });
          }
          const { code, status, message } = responseCodes.SERVER_ERROR;
          return res
            .status(code)
            .json({ status, message: "Server error during file processing." });
        }
        if (req.body && typeof req.body === "object") {
          normalizeValues(req.body);
        }
        
        // ✅ RUN PERMISSION CHECK
        checkPermission(req, res, next);
      };

      // ✅ RESTORE CONTEXT
      if (store) {
        requestContext.run(store, runLogic);
      } else {
        runLogic();
      }
    });
  };
};

const uploadExcelToDisk = (fieldName) => {
  const maxSize = 50 * 1024 * 1024; // 50MB limit
  const baseDir = "uploads/temp_imports"; // Temporary folder

  ensureDir(path.join(process.cwd(), baseDir));

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(process.cwd(), baseDir));
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(
        null,
        file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
      );
    },
  });

  const fileFilter = (req, file, cb) => {
    const allowedExt = /\.(xls|xlsx|csv)$/i;
    const allowedMime = [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "application/csv",
    ];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedExt.test(ext) || allowedMime.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error("EXCEL_FILE_ONLY");
      err.customCode = "EXCEL_FILE_ONLY";
      cb(err);
    }
  };

  const multerInstance = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter,
  });

  const uploader = multerInstance.single(fieldName);

  return (req, res, next) => {
     // ✅ CAPTURE CONTEXT
    const store = requestContext.getStore();

    uploader(req, res, (err) => {
      // ✅ WRAP LOGIC
      const runLogic = () => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res
              .status(413)
              .json({ status: false, message: "File too large" });
          }
          return res.status(400).json({ status: false, message: err.message });
        }

        if (req.body && typeof req.body === "object") {
          normalizeValues(req.body);
        }

        // ✅ RUN PERMISSION CHECK
        checkPermission(req, res, next);
      };

      // ✅ RESTORE CONTEXT
      if (store) {
        requestContext.run(store, runLogic);
      } else {
        runLogic();
      }
    });
  };
};

const fileExists = (folder, fileName) => {
  if (!fileName) return false;

  const fullPath = path.join(constants.UPLOAD_PATH, folder, fileName);
  return fs.existsSync(fullPath);
};

module.exports = {
  bufferImage,
  bufferFile,
  uploadFile,
  deleteFile,
  bufferExcel,
  uploadExcelToDisk,
  fileExists,
};