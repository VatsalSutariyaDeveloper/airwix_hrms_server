const { ActivityLog, ApiLog, Logs, User } = require("../models");
const commonQuery = require("../helpers/commonQuery");

exports.getAuditLogs = async (req, res) => {
  try {
    const fieldConfig = [
      ["entity_name", true, true],
      ["action_type", true, true],
      ["record_id", true, true],
      ["log_message", true, false],
      ["ip_address", true, true],
      ["created_at", false, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      Logs,
      req.body,
      fieldConfig,
      {
        include: [
          { model: User, as: "user", attributes: ["id", "first_name", "last_name", "email"] },
        ],
      }
    );

    return res.status(200).json({
      success: true,
      data: result.items,
      pagination: {
         total: result.total,
         currentPage: result.currentPage,
         pageSize: result.pageSize,
         totalPages: result.totalPages
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getActivityLogs = async (req, res) => {
  try {
    const fieldConfig = [
      ["entity_name", true, true],
      ["action_type", true, true],
      ["record_id", true, true],
      ["log_message", true, false],
      ["ip_address", true, true],
      ["created_at", false, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      ActivityLog,
      req.body,
      fieldConfig,
      {
        include: [
          { model: User, as: "user", attributes: ["id", "first_name", "last_name", "email"] },
        ],
      }
    );

    return res.status(200).json({
      success: true,
      data: result.items,
      pagination: {
         total: result.total,
         currentPage: result.currentPage,
         pageSize: result.pageSize,
         totalPages: result.totalPages
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getApiLogs = async (req, res) => {
  try {
    const fieldConfig = [
      ["method", true, true],
      ["url", true, true],
      ["status_code", true, true],
      ["ip_address", true, true],
      ["created_at", false, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      ApiLog,
      req.body,
      fieldConfig,
      {
        include: [
          { model: User, as: "user", attributes: ["id", "first_name", "last_name", "email"] },
        ],
      }
    );

    return res.status(200).json({
      success: true,
      data: result.items,
      pagination: {
         total: result.total,
         currentPage: result.currentPage,
         pageSize: result.pageSize,
         totalPages: result.totalPages
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
