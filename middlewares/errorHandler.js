const path = require("path");
const multer = require("multer");
const { handleError } = require("../helpers");


module.exports = (err, req, res, next) => {
  // Figure out where the error came from
  const controllerName = req.route?.path || "Unknown Route";
  const methodName = req.method || "Unknown Method";
  const stackTrace = err.stack || "No stack trace";

  // Full debug log (only server side)
  console.error("===== ERROR LOG START =====");
  console.error("Controller/Route:", controllerName);
  console.error("HTTP Method:", methodName);
  console.error("Request URL:", req.originalUrl);
  console.error("Error Name:", err.name);
  console.error("Error Message:", err.message);
  console.error("Stack Trace:", stackTrace);
  console.error("===== ERROR LOG END =====");

  // Handle Multer file size limit error
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    const maxMb = (req.maxFileSize || 5 * 1024 * 1024) / 1024 / 1024;
    return res.status(400).json({
      status: false,
      code: "FILE_TOO_LARGE",
      message: `File too large. Max allowed size is ${maxMb} MB`,
    });
  }

  // File type validation error (custom from fileFilter)
  if (err.code === "INVALID_FILE_TYPE") {
    return res.status(400).json({
      status: false,
      code: "INVALID_FILE_TYPE",
      message: err.message || "Invalid file type",
    });
  }

  // Generic fallback error (safe for public)
  return handleError(err, res, req);
};
