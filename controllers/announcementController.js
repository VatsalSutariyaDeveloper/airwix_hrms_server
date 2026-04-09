const { Announcement, User, RolePermission } = require("../models");
const notificationService = require("../services/notificationService");
const commonQuery = require("../helpers/commonQuery");
const { handleError } = require("../helpers");

exports.createAnnouncement = async (req, res) => {
  try {
    const { title, content, announcement_date, expiry_date, priority, target_audience, branch_id } = req.body;

    const announcement = await commonQuery.createRecord(Announcement, {
      title,
      content,
      announcement_date,
      expiry_date,
      priority,
      target_audience,
      created_by: req.user.id,
      company_id: req.user.company_id,
      branch_id: branch_id || req.user.branch_id
    });

    // Send notifications if active
    if (announcement.status === 0) {
      await sendAnnouncementNotifications(announcement);
    }

    return res.status(201).json({
      success: true,
      message: "Announcement created successfully",
      data: announcement
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getAnnouncements = async (req, res) => {
  try {
    const fieldConfig = [
      ["title", true, true],
      ["content", true, false],
      ["announcement_date", true, true],
      ["expiry_date", true, true],
      ["priority", true, true],
      ["status", true, true],
      ["created_at", false, true]
    ];

    const result = await commonQuery.fetchPaginatedData(
      Announcement,
      req.body,
      fieldConfig,
      {
        attributes: ["id", "title", "content", "announcement_date", "expiry_date", "priority", "target_audience", "status", "created_at"],
        include: [
          { model: User, as: "creator", attributes: ["id", "user_name"] }
        ],
        where: {
          company_id: req.user.company_id
        },
        order: [["announcement_date", "DESC"]]
      },
      { company_id: false }
    );

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, announcement_date, expiry_date, priority, target_audience, status } = req.body;

    const announcement = await commonQuery.findOneRecord(Announcement, id, {}, null);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found"
      });
    }

    if (announcement.created_by !== req.user.id && !req.user.is_admin && !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: "You can only update your own announcements"
      });
    }

    const updated = await commonQuery.updateRecord(Announcement, id, {
      title,
      content,
      announcement_date,
      expiry_date,
      priority,
      target_audience,
      status
    });

    // If it was just activated, send notifications
    if (status === 0 && announcement.status !== 0) {
       const freshAnnouncement = await Announcement.findByPk(id);
       await sendAnnouncementNotifications(freshAnnouncement);
    }

    return res.status(200).json({
      success: true,
      message: "Announcement updated successfully"
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;

    const announcement = await commonQuery.findOneRecord(Announcement, id, {}, null);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: "Announcement not found"
      });
    }

    if (announcement.created_by !== req.user.id && !req.user.is_admin && !req.user.is_super_admin) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own announcements"
      });
    }

    await commonQuery.updateRecord(Announcement, id, { status: 2 });

    return res.status(200).json({
      success: true,
      message: "Announcement deleted successfully"
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

exports.getActiveAnnouncements = async (req, res) => {
  try {
    const today = new Date();
    const Op = require('sequelize').Op;
    
    const whereClause = {
      company_id: req.user.company_id,
      status: 0,
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

    // Filter by target audience for non-admin users
    if (!req.user.is_super_admin && !req.user.is_admin) {
      whereClause[Op.and].push({
        [Op.or]: [
          { target_audience: 'all' },
          { target_audience: req.user.role_id?.toString() }
        ]
      });
    }

    const announcements = await commonQuery.findAllRecords(Announcement, whereClause, {
      attributes: ["id", "title", "content", "announcement_date", "priority", "target_audience"],
      include: [
        { model: User, as: "creator", attributes: ["id", "user_name"] }
      ],
      order: [["priority", "DESC"], ["announcement_date", "DESC"]]
    }, null);

    return res.status(200).json({
      success: true,
      data: announcements
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

/**
 * Helper to send notifications to targeted users
 */
async function sendAnnouncementNotifications(announcement) {
  try {
    const { target_audience, company_id, branch_id, title, content, id } = announcement;
    const Op = require('sequelize').Op;
    let userFilter = { company_id, status: 0 };

    if (!target_audience || target_audience === 'all') {
      // All users in company
    } else if (target_audience === 'employees') {
      userFilter.role_id = { [Op.notIn]: [1, 2] };
    } else if (target_audience === 'managers') {
      userFilter.role_id = { [Op.in]: [3, 4] };
    } else if (typeof target_audience === 'string' && target_audience.startsWith('users:')) {
      const userIds = target_audience.replace('users:', '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (userIds.length > 0) {
        userFilter.id = { [Op.in]: userIds };
      }
    } else if (!isNaN(target_audience)) {
      // It's a Role ID
      userFilter.role_id = parseInt(target_audience);
    }

    const users = await User.findAll({ where: userFilter, attributes: ['id'] });

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
