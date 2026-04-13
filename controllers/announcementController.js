const { Announcement, User, RolePermission } = require("../models");
const notificationService = require("../services/notificationService");
const commonQuery = require("../helpers/commonQuery");
const { handleError, sequelize, constants, Op, formatDateTime } = require("../helpers");
const validateRequest = require("../helpers/validateRequest");

exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const requiredFields = {
      title: "Title",
      content: "Content",
      announcement_date: "Announcement Date",
      announcement_type: "Announcement Type",
      target_type: "Target Type",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: Announcement,
        fields: ["title"],
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const announcement = await commonQuery.createRecord(
      Announcement,
      req.body,
      transaction
    );

    // Send notifications if active
    if (announcement.status === 0) {
      await sendAnnouncementNotifications(announcement);
    }

    await transaction.commit();
    return res.success(constants.ANNOUNCEMENT_CREATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getAll = async (req, res) => {
  try {
    const fieldConfig = [
      ["title", true, true],
      ["content", true, false],
      ["announcement_date", true, true],
      ["expiry_date", true, true],
      ["announcement_type", true, true],
      ["target_type", true, true],
    ];

    const result = await commonQuery.fetchPaginatedData(
      Announcement,
      { ...req.body },
      fieldConfig,
      {}
    );

    return res.ok(result);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;

    const requiredFields = {
      title: "Title",
      content: "Content",
      announcement_date: "Announcement Date",
      announcement_type: "Announcement Type",
      target_type: "Target Type",
    };

    const errors = await validateRequest(req.body, requiredFields, {
      uniqueCheck: {
        model: Announcement,
        fields: ["title"],
        excludeId: req.params.id
      }
    }, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const announcement = await commonQuery.updateRecordById(Announcement, id, req.body, transaction);

    // If it was just activated, send notifications
    if (announcement.status == 0) {
      await sendAnnouncementNotifications(announcement);
    }

    await transaction.commit();
    return res.success(constants.ANNOUNCEMENT_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.delete = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.SELECT_AT_LEAST_ONE_RECORD);
    }

    const deleted = await commonQuery.softDeleteById(Announcement, ids, transaction);
    if (!deleted) {
      await transaction.rollback();
      return res.error(constants.ALREADY_DELETED);
    }

    await transaction.commit();
    return res.success(constants.DELETED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getById = async (req, res) => {
  try {
    const { id } = req.params;
    const announcement = await commonQuery.findOneRecord(Announcement, id);
    if (!announcement || announcement.status === 2) return res.error(constants.NOT_FOUND);
    return res.ok(announcement);
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.updateStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await transaction.rollback();
      return res.error(constants.SELECT_AT_LEAST_ONE_RECORD);
    }
    if (status === undefined || status === null) {
      await transaction.rollback();
      return res.error(constants.STATUS_REQUIRED);
    }

    const updated = await commonQuery.updateRecordById(
      Announcement, 
      ids, 
      { status },
      transaction
    );
    if (!updated) {
      await transaction.rollback();
      return res.error(constants.UPDATE_FAILED);
    }

    await transaction.commit();
    return res.success(constants.STATUS_UPDATED);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getActiveAnnouncements = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const today = new Date();
    const whereClause = {
      announcement_date: { [Op.lte]: today },
      [Op.and]: [
        {
          [Op.or]: [
            { expiry_date: null },
            { expiry_date: { [Op.gte]: today } }
          ]
        }
      ]
    };

    const announcements = await commonQuery.findAllRecords(
      Announcement,
      whereClause,
      {
        include: [
          {
            model: User,
            as: "created_by",
            attributes: ["id", "user_name"],
          },
        ],
        attributes: ["id", "title", "content", "announcement_date", "expiry_date", "announcement_type"],
        order: [["announcement_date", "DESC"]]
      }, transaction);

    // Filter by target audience for non-admin users in response
    let filteredAnnouncements = announcements;
    if (!req.user.is_super_admin && !req.user.is_admin) {
      filteredAnnouncements = announcements.filter(announcement => {
        const { target_type, target } = announcement;
        const userId = req.user.id?.toString();
        const roleId = req.user.role_id?.toString();
        const employeeRoleId = constants.EMPLOYEE_ROLE_ID.toString();

        // Helper to check if target contains exact match
        const containsExactMatch = (targetStr, value) => {
          if (!targetStr || !value) return false;
          const parts = targetStr.split(',');
          return parts.some(part => part.trim() === value);
        };

        if (target_type === 0) return true; // Show to all
        if (target_type === 1 && containsExactMatch(target, employeeRoleId)) return true; // Employee role
        if (target_type === 3 && containsExactMatch(target, userId)) return true; // Specific user
        if (target_type === 2 && containsExactMatch(target, roleId)) return true; // Specific role
        return false;
      });
    }

    // Format dates in response
    const formattedAnnouncements = filteredAnnouncements.map(announcement => ({
      ...announcement.toJSON(),
      announcement_date: formatDateTime(announcement.announcement_date),
      expiry_date: announcement.expiry_date ? formatDateTime(announcement.expiry_date) : null,
      created_by: announcement.created_by.user_name,
    }));

    await transaction.commit();
    return res.success(constants.ANNOUNCEMENT_FETCHED, formattedAnnouncements);
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

/**
 * Helper to send notifications to targeted users
 */
async function sendAnnouncementNotifications(announcement) {
  try {
    const { target_type, company_id, branch_id, title, content, id } = announcement;
    let userFilter = { company_id, status: 0 };

    if (!target_type || target_type === 0) {
    } else if (target_type === 1) {
      userFilter.role_id = constants.EMPLOYEE_ROLE_ID;
    } else if (target_type === 2) {
      const roleIds = target.toString().split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (roleIds.length > 0) {
        userFilter.role_id = { [Op.in]: roleIds };
      }
    } else if (target_type === 3) {
      const userIds = target.toString().split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (userIds.length > 0) {
        userFilter.id = { [Op.in]: userIds };
      }
    }

    const users = await commonQuery.findAllRecords(User, userFilter, { attributes: ['id'] });

    for (const user of users) {
      await notificationService.createNotification({
        user_id: user.id,
        title: `Announcement: ${title}`,
        message: content.length > 100 ? content.substring(0, 97) + "..." : content,
        type: "ANNOUNCEMENT",
        reference_id: id,
        status_code: 0,
        company_id,
        branch_id
      });
    }
  } catch (err) {
    console.error("Failed to send announcement notifications:", err);
  }
}
