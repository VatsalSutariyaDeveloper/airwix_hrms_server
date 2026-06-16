const { Announcement, User, RolePermission, UserDevice, CompanyMaster } = require("../models");
const commonQuery = require("../helpers/commonQuery");
const { handleError, sequelize, constants, Op, formatDateTime } = require("../helpers");
const firebaseService = require("../helpers/firebaseService");
const validateRequest = require("../helpers/validateRequest");
const dayjs = require("dayjs");

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

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const announcement = await commonQuery.createRecord(
      Announcement,
      req.body,
      transaction
    );

    await transaction.commit();

    // Send notifications to the targeted users asynchronously in the background
    setImmediate(async () => {
      try {
        const announcementDate = dayjs(req.body.announcement_date);
        const todayEnd = dayjs().endOf('day');
        if (announcementDate.isAfter(todayEnd)) {
          console.log(`Announcement date is in the future (${req.body.announcement_date}), skipping immediate notification.`);
          return;
        }

        const companyId = req.user?.company_id || req.body.company_id;
        if (!companyId) return;

        const company = await CompanyMaster.findByPk(companyId, { attributes: ["organization_id"] });
        let companyIds = [companyId];
        if (company && company.organization_id) {
          const companies = await CompanyMaster.findAll({
            where: { organization_id: company.organization_id, status: 0 },
            attributes: ["id"]
          });
          if (companies.length > 0) {
            companyIds = companies.map(c => c.id);
          }
        }

        let whereClause = {
          company_id: { [Op.in]: companyIds },
          status: 0 // Active users
        };

        const targetType = parseInt(req.body.target_type);
        const target = req.body.target; // Comma-separated values

        let queryOptions = {
          attributes: ["id", "fcm_token"]
        };

        if (targetType === 3) {
          const userIds = target ? target.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
          if (userIds.length > 0) {
            whereClause.id = { [Op.in]: userIds };
          } else {
            return;
          }
        } else if (targetType === 2) {
          const roleIds = target ? target.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
          if (roleIds.length > 0) {
            whereClause.role_id = { [Op.in]: roleIds };
          } else {
            return;
          }
        } else if (targetType === 1) {
          queryOptions.include = [
            {
              model: RolePermission,
              as: "RolePermission",
              where: { role_key: { [Op.notIn]: [constants.ROLE_KEYS.BUSINESS_ADMIN, constants.ROLE_KEYS.ADMIN] } },
              required: true,
              attributes: []
            }
          ];
        }

        const targetUsers = await commonQuery.findAllRecords(User, whereClause, queryOptions);

        const cleanContent = (req.body.content || "")
          .replace(/<[^>]*>/g, "")
          .substring(0, 150);

        // Collect all FCM tokens from target users (multi-device support)
        let allTokens = [];
        for (const user of targetUsers) {
          const devices = await commonQuery.findAllRecords(UserDevice, { user_id: user.id }, { attributes: ["fcm_token"] }, null, false);
          const deviceTokens = devices.map(d => d.fcm_token).filter(Boolean);
          if (deviceTokens.length > 0) {
            allTokens.push(...deviceTokens);
          } else if (user.fcm_token) {
            allTokens.push(user.fcm_token);
          }
        }

        allTokens = [...new Set(allTokens)];

        if (allTokens.length > 0) {
          await firebaseService.sendMulticastNotification(allTokens, {
            title: `New Announcement: ${req.body.title}`,
            body: cleanContent || "A new company announcement has been published.",
            data: {
              type: "ANNOUNCEMENT",
              reference_id: String(announcement.id || ""),
              redirect_url: "/announcements"
            }
          });
        }
      } catch (notifyErr) {
        console.error("Error sending FCM for announcement:", notifyErr);
      }
    });

    return res.success(constants.ANNOUNCEMENT_CREATED, announcement);
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

    if (!req.user.is_super_admin) {
      req.body.user_id = req.user.id;
    }

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

    const errors = await validateRequest(req.body, requiredFields, {}, transaction);

    if (errors) {
      await transaction.rollback();
      return res.error(constants.VALIDATION_ERROR, errors);
    }

    const announcement = await commonQuery.updateRecordById(Announcement, id, req.body, transaction);

    await transaction.commit();

    // Send Firebase push notifications to target users (without creating Notification DB entries)
    setImmediate(async () => {
      try {
        const announcementDate = dayjs(req.body.announcement_date);
        const todayEnd = dayjs().endOf('day');
        if (announcementDate.isAfter(todayEnd)) {
          console.log(`Announcement date is in the future (${req.body.announcement_date}), skipping immediate notification.`);
          return;
        }

        const companyId = req.user?.company_id || req.body.company_id;
        if (!companyId) return;

        const company = await CompanyMaster.findByPk(companyId, { attributes: ["organization_id"] });
        let companyIds = [companyId];
        if (company && company.organization_id) {
          const companies = await CompanyMaster.findAll({
            where: { organization_id: company.organization_id, status: 0 },
            attributes: ["id"]
          });
          if (companies.length > 0) {
            companyIds = companies.map(c => c.id);
          }
        }

        let whereClause = {
          company_id: { [Op.in]: companyIds },
          status: 0
        };

        const targetType = parseInt(req.body.target_type);
        const target = req.body.target;

        let queryOptions = {
          attributes: ["id", "fcm_token"]
        };

        if (targetType === 3) {
          const userIds = target ? target.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
          if (userIds.length > 0) {
            whereClause.id = { [Op.in]: userIds };
          } else {
            return;
          }
        } else if (targetType === 2) {
          const roleIds = target ? target.split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
          if (roleIds.length > 0) {
            whereClause.role_id = { [Op.in]: roleIds };
          } else {
            return;
          }
        } else if (targetType === 1) {
          queryOptions.include = [
            {
              model: RolePermission,
              as: "RolePermission",
              where: { role_key: { [Op.notIn]: [constants.ROLE_KEYS.BUSINESS_ADMIN, constants.ROLE_KEYS.ADMIN] } },
              required: true,
              attributes: []
            }
          ];
        }

        const targetUsers = await commonQuery.findAllRecords(User, whereClause, queryOptions);

        const cleanContent = (req.body.content || "")
          .replace(/<[^>]*>/g, "")
          .substring(0, 150);

        // Collect all FCM tokens from target users (multi-device support)
        let allTokens = [];
        for (const user of targetUsers) {
          const devices = await commonQuery.findAllRecords(UserDevice, { user_id: user.id }, { attributes: ["fcm_token"] }, null, false);
          const deviceTokens = devices.map(d => d.fcm_token).filter(Boolean);
          if (deviceTokens.length > 0) {
            allTokens.push(...deviceTokens);
          } else if (user.fcm_token) {
            allTokens.push(user.fcm_token);
          }
        }

        allTokens = [...new Set(allTokens)];

        if (allTokens.length > 0) {
          await firebaseService.sendMulticastNotification(allTokens, {
            title: `Updated Announcement: ${req.body.title}`,
            body: cleanContent || "A company announcement has been updated.",
            data: {
              type: "announcement",
              reference_id: String(id || ""),
              redirect_url: "/dashboard"
            }
          });
        }
      } catch (notifyErr) {
        console.error("Error sending FCM for updated announcement:", notifyErr);
      }
    });

    return res.success(constants.ANNOUNCEMENT_UPDATED, announcement);
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
    return res.success(constants.ANNOUNCEMENT_DELETED);
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
    return res.success(constants.STATUS_UPDATED, { ids, status });
  } catch (err) {
    await transaction.rollback();
    return handleError(err, res, req);
  }
};

exports.getActiveAnnouncements = async (req, res) => {
  const transaction = await sequelize.transaction();

  try {
    const today = dayjs().format("YYYY-MM-DD");
    const todayEnd = dayjs().endOf('day').format("YYYY-MM-DD HH:mm:ss");
    const whereClause = {
      company_id: req.user.company_id,
      status: 0,
      announcement_date: { [Op.lte]: todayEnd },
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
        attributes: ["id", "title", "content", "announcement_date", "expiry_date", "announcement_type", "target_type", "target", "createdAt"],
        order: [["announcement_date", "DESC"]]
      }, transaction);

    // Filter by target audience for non-admin users in response
    let filteredAnnouncements = announcements;
    if (!req.user.is_super_admin && !req.user.is_admin) {
      filteredAnnouncements = announcements.filter(announcement => {
        const { target_type, target } = announcement;
        const userId = req.user.id?.toString();
        const roleKey = req.user.role_key;

        // Helper to check if target contains exact match
        const containsExactMatch = (targetStr, value) => {
          if (!targetStr || !value) return false;
          const parts = targetStr.split(',');
          return parts.some(part => part.trim() === value);
        };

        if (target_type === 0) return true; // Show to all
        if (target_type === 1 && roleKey !== constants.ROLE_KEYS.BUSINESS_ADMIN && roleKey !== constants.ROLE_KEYS.ADMIN) return true;
        if (target_type === 3 && containsExactMatch(target, userId)) return true; // Specific user
        if (target_type === 2 && containsExactMatch(target, req.user.role_id?.toString())) return true; // Specific role (still uses ID for now as target column stores IDs)
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