module.exports = {
  // 🔴 Error Responses
  VALIDATION_ERROR: {
    code: 400,
    status: "VALIDATION_ERROR",
    message: "Validation failed",
  },
  USER_LIMIT_REACHED: {
    code: 400,
    status: "SUBSCRIPTION_LIMIT",
    message: "User limit reached for your current plan. Please Update Plan."
  },
  COMPANY_LIMIT_REACHED: {
    code: 400,
    status: "SUBSCRIPTION_LIMIT",
    message: "Company limit reached for your current plan. Please Update Plan."
  },
  NOT_FOUND: {
    code: 404,
    status: "NOT_FOUND",
    message: "Resource not found",
  },
  FORBIDDEN: {
    code: 403,
    status: "FORBIDDEN",
    message: "Access denied. You do not have permission to perform this action.",
  },
  ALREADY_DELETED: {
    code: 410,
    status: "ALREADY_DELETED",
    message: "Resource already deleted",
  },
  SERVER_ERROR: {
    code: 500,
    status: "SERVER_ERROR",
    message: "Internal server error",
  },
  UNIQUE_CONSTRAINT: {
    code: 409,
    status: "UNIQUE_CONSTRAINT",
    message: "Unique constraint violation",
  },
  FOREIGN_KEY_CONSTRAINT: (table = "related table") => ({
    code: 400,
    status: "FOREIGN_KEY_CONSTRAINT",
    message: `Unable to save the item. Please ensure that the selected ${table} exists and is valid.`,
  }),


  // 🔴 File Upload Errors
  IMAGE_TYPE_NOT_ALLOWED: {
    code: 400,
    status: "FILE_TYPE_NOT_ALLOWED",
    message: "Only JPG, JPEG, PNG, and WEBP image files are allowed."
  },
  IMAGE_TOO_LARGE: {
    code: 400,
    status: "FILE_TOO_LARGE",
    message: "Image file too large. Maximum allowed size is 5MB."
  },
  FILE_TYPE_NOT_ALLOWED: {
    code: 400,
    status: "FILE_TYPE_NOT_ALLOWED",
    message: "Only JPG, JPEG, PNG, WEBP and Pdf files are allowed."
  },
  FILE_TOO_LARGE: {
    code: 400,
    status: "FILE_TOO_LARGE",
    message: "File too large. Maximum allowed size is 5MB."
  },
  FILE_REQUIRED: {
    code: 400,
    status: "FILE_REQUIRED",
    message: "File is required."
  },
  FILE_UPLOAD_FAILED: {
    code: 500,
    status: "FILE_UPLOAD_FAILED",
    message: "File could not be saved due to a server error."
  },
  IMAGE_UPLOAD_FAILED: {
    code: 500,
    status: "IMAGE_UPLOAD_FAILED",
    message: "Image could not be saved due to a server error."
  },

  // 📧 Email Specific Errors
  EMAIL_AUTH_FAILED: {
    code: 401,
    status: "EMAIL_AUTH_FAILED",
    message: "Email authentication failed. Please check your SMTP username and password."
  },
  EMAIL_CONNECTION_FAILED: {
    code: 502,
    status: "EMAIL_CONNECTION_FAILED",
    message: "Could not connect to the email server. Please check your SMTP Host and Port."
  },
  EMAIL_TIMEOUT: {
    code: 504,
    status: "EMAIL_TIMEOUT",
    message: "The email server took too long to respond. Please try again later."
  },
  EMAIL_REJECTED: {
    code: 422,
    status: "EMAIL_REJECTED",
    message: "The email server rejected the sender address or recipient. Check permissions."
  },
  EMAIL_UNKNOWN_ERROR: {
    code: 500,
    status: "EMAIL_SEND_FAILED",
    message: "An unknown error occurred while sending the email."
  },
  
  // ✅ Success Responses
  SUCCESS: {
    FETCH: (name = "Record") => ({
      code: 200,
      status: "SUCCESS",
      message: `${name} fetched successfully`,
    }),
    CREATE: (name = "Record") => ({
      code: 201,
      status: "CREATE_SUCCESS",
      message: `${name} created successfully`,
    }),
    UPDATE: (name = "Record") => ({
      code: 200,
      status: "UPDATE_SUCCESS",
      message: `${name} updated successfully`,
    }),
    DELETE: (name = "Record") => ({
      code: 200,
      status: "DELETE_SUCCESS",
      message: `${name} deleted successfully`,
    }),
    SOFT_DELETE: (name = "Record") => ({
      code: 200,
      status: "SOFT_DELETE_SUCCESS",
      message: `${name} soft deleted successfully`,
    }),
  },
};
