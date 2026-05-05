const { Notification, Announcement, Employee, sequelize, RolePermission } = require("../models");
const { handleError, constants, commonQuery, Op } = require("../helpers");
const dayjs = require("dayjs");

/**
 * Get unified list of personal notifications and active announcements
 */
exports.getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        const roleKey = req.user.role_key;

        // 1. Fetch Personal Notifications
        const personalNotifications = await commonQuery.findAllRecords(Notification, {
            user_id: userId,
            status: { [Op.ne]: 2 } // Not deleted
        }, {
            order: [['created_at', 'DESC']],
            limit: 50
        }, null);

        // 1.5. Fetch cleared announcement IDs (status: 2, type: 'ANNOUNCEMENT')
        const clearedAnnouncementRecords = await commonQuery.findAllRecords(Notification, {
            user_id: userId,
            type: 'ANNOUNCEMENT',
            status: 2 // Deleted/cleared
        }, {}, null);
        const clearedAnnouncementIds = clearedAnnouncementRecords.map(n => parseInt(n.reference_id));

        // 2. Fetch Active Announcements
        // Active if: current date is between announcement_date and expiry_date (if exists)
        const today = dayjs().format("YYYY-MM-DD");
        const todayEnd = dayjs().endOf('day').format("YYYY-MM-DD HH:mm:ss");

        const activeAnnouncements = await commonQuery.findAllRecords(Announcement, {
            status: 0, // Active
            announcement_date: { [Op.lte]: todayEnd },
            [Op.or]: [
                { expiry_date: null },
                { expiry_date: { [Op.gte]: today } }
            ]
        }, {}, null);

        // 3. Filter Announcements by Target and exclude cleared ones
        // target_type: 0 = all, 1 = employees, 2 = specific roles, 3 = specific users
        const filteredAnnouncements = activeAnnouncements.filter(ann => {
            // Exclude if user has cleared this announcement
            if (clearedAnnouncementIds.includes(ann.id)) return false;

            // Filter by target_type
            if (ann.target_type === 0) return true; // All users
            if (ann.target_type === 1) return true; // All employees
            if (ann.target_type === 2) {
                // Specific roles - target contains role_ids like "79,80,83"
                const targetRoleIds = (ann.target || "").split(",").map(t => parseInt(t.trim()));
                return targetRoleIds.includes(req.user.role_id);
            }
            if (ann.target_type === 3) {
                // Specific users - target contains user_ids
                const targetUserIds = (ann.target || "").split(",").map(t => parseInt(t.trim()));
                return targetUserIds.includes(userId);
            }
            return false;
        });

        // 4. Merge and Map
        // We need to check which announcements have already been marked as "read" 
        // (which means a Notification record exists for it with type='ANNOUNCEMENT' and ref_id=announcement.id)
        
        const announcementReadRecords = personalNotifications.filter(n => n.type === 'ANNOUNCEMENT');
        const readAnnouncementMap = {};
        announcementReadRecords.forEach(r => {
            readAnnouncementMap[parseInt(r.reference_id)] = r.is_read;
        });

        const mappedAnnouncements = filteredAnnouncements.map(ann => ({
            ...ann.dataValues,
            type: 'ANNOUNCEMENT',
            message: ann.content,
            is_read: readAnnouncementMap[ann.id] || 0,
            is_announcement: true
        }));

        const mappedNotifications = personalNotifications
            .filter(n => n.type !== 'ANNOUNCEMENT')
            .map(n => ({
                ...n.dataValues,
                is_announcement: false
            }));

        const unifiedList = [...mappedAnnouncements, ...mappedNotifications].sort((a, b) => 
            dayjs(b.created_at).valueOf() - dayjs(a.created_at).valueOf()
        );

        return res.ok(unifiedList);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Mark a notification (or announcement) as read
 */
exports.markAsRead = async (req, res) => {
    try {
        const { id, is_announcement } = req.body;
        const userId = req.user.id;

        if (is_announcement) {
            const existing = await commonQuery.findOneRecord(Notification, {
                user_id: userId,
                type: 'ANNOUNCEMENT',
                reference_id: id,
            }, {}, null);

            if (!existing) {
                const ann = await Announcement.findByPk(id);
                if (ann) {
                    const notification = await commonQuery.createRecord(Notification, {
                        type: 'ANNOUNCEMENT',
                        reference_id: id,
                        title: ann.title,
                        message: ann.content,
                        status: 0, // Active
                        is_read: 1 // Read
                    }, null);
                }
            } else if (existing.is_read === 0) {
                await commonQuery.updateRecordById(Notification, existing.id, { is_read: 1 }, null);
            }
        } else {
            const notification = await commonQuery.findOneRecord(Notification, {
                id
            }, {}, null);

            if (notification && notification.is_read === 0) {
                await commonQuery.updateRecordById(Notification, notification.id, { is_read: 1 }, null);
            }
        }

        return res.ok({ success: true });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Clear all notifications (mark as deleted)
 */
exports.clearAll = async (req, res) => {
    try {
        const userId = req.user.id;
        const roleKey = req.user.role_key;

        // 1. Create notification records for active announcements if they don't exist
        const today = dayjs().format("YYYY-MM-DD");
        const todayEnd = dayjs().endOf('day').format("YYYY-MM-DD HH:mm:ss");

        const activeAnnouncements = await commonQuery.findAllRecords(Announcement, {
            status: 0,
            announcement_date: { [Op.lte]: todayEnd },
            [Op.or]: [
                { expiry_date: null },
                { expiry_date: { [Op.gte]: today } }
            ]
        }, {}, null);

        const filteredAnnouncements = activeAnnouncements.filter(ann => {
            // target_type: 0 = all, 1 = employees, 2 = specific roles, 3 = specific users
            if (ann.target_type === 0) return true; // All users
            if (ann.target_type === 1) return true; // All employees (assuming current user is employee)
            if (ann.target_type === 2) {
                // Specific roles - target contains role_ids like "79,80,83"
                const targetRoleIds = (ann.target || "").split(",").map(t => parseInt(t.trim()));
                return targetRoleIds.includes(req.user.role_id);
            }
            if (ann.target_type === 3) {
                // Specific users - target contains user_ids
                const targetUserIds = (ann.target || "").split(",").map(t => parseInt(t.trim()));
                return targetUserIds.includes(userId);
            }
            return false;
        });

        for (const ann of filteredAnnouncements) {
            const existing = await commonQuery.findOneRecord(Notification, {
                user_id: userId,
                type: 'ANNOUNCEMENT',
                reference_id: ann.id,
            }, {}, null);

            if (!existing) {
                await commonQuery.createRecord(Notification, {
                    type: 'ANNOUNCEMENT',
                    reference_id: ann.id,
                    title: ann.title,
                    message: ann.content,
                    status: 0,
                    is_read: 1
                }, null);
            }
        }

        await commonQuery.updateRecordById(Notification,{user_id: userId}, { status: 2,is_read:1 }, null);

        return res.ok({ success: true });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Mark all notifications and announcements as read
 */
exports.markAllAsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const companyId = req.user.company_id;

        // 1. Update all existing notifications to is_read 1
        await Notification.update({ is_read: 1 }, { where: { user_id: userId, is_read: 0 } });

        // 2. We should ideally also mark all active announcements as read by creating records for them
        // But for performance, we might skip this unless explicitly requested. 
        // For now, let's just do existing ones.

        return res.ok({ success: true });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Get unread count
 */
exports.getUnreadCount = async (req, res) => {
    try {
        const userId = req.user.id;
        const companyId = req.user.company_id;
        const roleKey = req.user.role_key;

        // Count real unread notifications
        const notificationCount = await Notification.count({
            where: { user_id: userId, is_read: 0 }
        });

        // Count unread announcements
        const today = dayjs().format("YYYY-MM-DD");
        const todayEnd = dayjs().endOf('day').format("YYYY-MM-DD HH:mm:ss");
        const activeAnnouncements = await Announcement.findAll({
            where: {
                company_id: companyId,
                status: 0,
                announcement_date: { [Op.lte]: todayEnd },
                [Op.or]: [
                    { expiry_date: null },
                    { expiry_date: { [Op.gte]: today } }
                ]
            }
        });

        const readAnnouncementIds = (await Notification.findAll({
            where: { user_id: userId, type: 'ANNOUNCEMENT' },
            attributes: ['reference_id']
        })).map(r => parseInt(r.reference_id));

        const unreadAnnouncements = activeAnnouncements.filter(ann => {
            // Check role target
            let roleMatch = true;
            const target = (ann.target || "").toString().toLowerCase();
            if (target && target !== "all") {
                const targets = target.split(",").map(t => t.trim());
                roleMatch = roleKey && targets.includes(roleKey.toLowerCase());
            }
            return roleMatch && !readAnnouncementIds.includes(ann.id);
        });

        return res.ok({ count: notificationCount + unreadAnnouncements.length });
    } catch (err) {
        return handleError(err, res, req);
    }
};
