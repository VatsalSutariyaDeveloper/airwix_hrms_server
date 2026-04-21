const { ActivityLog, ApiLog, Logs, User, DeviceMaster } = require("../models");
const commonQuery = require("../helpers/commonQuery");
const { handleError } = require("../helpers");

exports.getAuditLogs = async (req, res) => {
  try {
    const fieldConfig = [
      ["entity_name", true, true],
      ["action_type", true, true],
      ["record_id", true, true],
      ["log_message", true, false],
      ["logs.ip_address", true, true],
      ["logs.access_type", true, true],
      ["logs.caller", true, true],
      ["logs.status", true, true],
      ["logs.created_at", true, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      Logs,
      req.body,
      fieldConfig,
      {
        attributes: ["id", "entity_name", "action_type", "record_id", "log_message", "old_data", "new_data", "stack_trace", "sql_query", "ip_address", "status", "access_type", "caller", "created_at"],
        include: [
          { model: User, as: "user", attributes: ["id", "user_name", "email"] },
          { model: DeviceMaster, as: "device", attributes: ["id", "device_name"] },
        ],
      },
      { company_id: true }
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getActivityLogs = async (req, res) => {
  try {
    const fieldConfig = [
      ["entity_name", true, true],
      ["action_type", true, true],
      ["record_id", true, true],
      ["log_message", true, false],
      ["activity_logs.ip_address", true, true],
      ["activity_logs.access_type", true, true],
      ["activity_logs.caller", true, true],
      ["activity_logs.created_at", true, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      ActivityLog,
      req.body,
      fieldConfig,
      {
        attributes: ["id", "entity_name", "action_type", "record_id", "log_message", "old_data", "new_data", "sql_query", "ip_address", "access_type", "caller", "created_at"],
        include: [
          { model: User, as: "user", attributes: ["id", "user_name", "email"] },
          { model: DeviceMaster, as: "device", attributes: ["id", "device_name"] },
        ],
      },
      { company_id: true }
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getApiLogs = async (req, res) => {
  try {
    const fieldConfig = [
      ["method", true, true],
      ["url", true, true],
      ["status_code", true, true],
      ["ApiLog.ip_address", true, true],
      ["access_type", true, true],
      ["caller", true, true],
      ["ApiLog.created_at", true, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      ApiLog,
      req.body,
      fieldConfig,
      {
        attributes: ["id", "method", "url", "status_code", "ip_address", "request_body", "response_body", "duration", "user_agent", "access_type", "caller", "created_at"],
        include: [
          { model: User, as: "user", attributes: ["id", "user_name", "email"] },
          { model: DeviceMaster, as: "device", attributes: ["id", "device_name"] },
        ],
      },
      { company_id: true }
    );

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
