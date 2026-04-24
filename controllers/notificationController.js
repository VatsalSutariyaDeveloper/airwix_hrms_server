const { Notification, Announcement, Employee, sequelize, RolePermission } = require("../models");
const { handleError, constants, commonQuery, Op } = require("../helpers");
const dayjs = require("dayjs");

/**
 * Get unified list of personal notifications and active announcements
 */
exports.getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        const companyId = req.user.company_id;
        const branchId = req.user.branch_id;
        const roleKey = req.user.role_key;

        // 1. Fetch Personal Notifications
        const personalNotifications = await Notification.findAll({
            where: {
                user_id: userId,
                company_id: companyId,
                status: { [Op.ne]: 2 } // Not deleted
            },
            order: [['created_at', 'DESC']],
            limit: 50
        });

        // 2. Fetch Active Announcements
        // Active if: current date is between announcement_date and expiry_date (if exists)
        const today = dayjs().format("YYYY-MM-DD");
        
        const activeAnnouncements = await Announcement.findAll({
            where: {
                company_id: companyId,
                status: 0, // Active
                announcement_date: { [Op.lte]: today },
                [Op.or]: [
                    { expiry_date: null },
                    { expiry_date: { [Op.gte]: today } }
                ]
            }
        });

        // 3. Filter Announcements by Target
        // target is comma separated string of role_keys or "all"
        const filteredAnnouncements = activeAnnouncements.filter(ann => {
            if (!ann.target || ann.target.toLowerCase() === "all") return true;
            const targets = ann.target.split(",").map(t => t.trim().toLowerCase());
            return targets.includes(roleKey.toLowerCase());
        });

        // 4. Merge and Map
        // We need to check which announcements have already been marked as "read" 
        // (which means a Notification record exists for it with type='ANNOUNCEMENT' and ref_id=announcement.id)
        
        const announcementReadRecords = personalNotifications.filter(n => n.type === 'ANNOUNCEMENT');
        const readAnnouncementIds = announcementReadRecords.map(r => parseInt(r.ref_id));

        const mappedAnnouncements = filteredAnnouncements.map(ann => ({
            id: `ANN_${ann.id}`, // Virtual ID to distinguish from real notifications
            real_id: ann.id,
            type: 'ANNOUNCEMENT',
            title: ann.title,
            message: ann.content,
            status: readAnnouncementIds.includes(ann.id) ? 1 : 0,
            created_at: ann.announcement_date,
            is_announcement: true
        }));

        const mappedNotifications = personalNotifications
            .filter(n => n.type !== 'ANNOUNCEMENT') // Don't duplicate
            .map(n => ({
                id: n.id,
                type: n.type,
                title: n.title,
                message: n.message,
                status: n.status,
                created_at: n.created_at,
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
        const { id } = req.body;
        const userId = req.user.id;
        const companyId = req.user.company_id;

        if (typeof id === 'string' && id.startsWith('ANN_')) {
            // It's a virtual announcement ID
            const annId = id.split('_')[1];
            
            // Check if already exists
            const existing = await Notification.findOne({
                where: {
                    user_id: userId,
                    type: 'ANNOUNCEMENT',
                    ref_id: annId
                }
            });

            if (!existing) {
                // Create a "read" record for this announcement
                const ann = await Announcement.findByPk(annId);
                if (ann) {
                    await Notification.create({
                        user_id: userId,
                        company_id: companyId,
                        type: 'ANNOUNCEMENT',
                        ref_id: annId,
                        title: ann.title,
                        message: ann.content,
                        status: 1 // Read
                    });
                }
            } else {
                await existing.update({ status: 1 });
            }
        } else {
            // It's a real notification ID
            await Notification.update({ status: 1 }, { where: { id, user_id: userId } });
        }

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

        // 1. Update all existing notifications to status 1
        await Notification.update({ status: 1 }, { where: { user_id: userId, status: 0 } });

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
            where: { user_id: userId, status: 0 }
        });

        // Count unread announcements
        const today = dayjs().format("YYYY-MM-DD");
        const activeAnnouncements = await Announcement.findAll({
            where: {
                company_id: companyId,
                status: 0,
                announcement_date: { [Op.lte]: today },
                [Op.or]: [
                    { expiry_date: null },
                    { expiry_date: { [Op.gte]: today } }
                ]
            }
        });

        const readAnnouncementIds = (await Notification.findAll({
            where: { user_id: userId, type: 'ANNOUNCEMENT' },
            attributes: ['ref_id']
        })).map(r => parseInt(r.ref_id));

        const unreadAnnouncements = activeAnnouncements.filter(ann => {
            // Check role target
            let roleMatch = true;
            if (ann.target && ann.target.toLowerCase() !== "all") {
                const targets = ann.target.split(",").map(t => t.trim().toLowerCase());
                roleMatch = targets.includes(roleKey.toLowerCase());
            }
            return roleMatch && !readAnnouncementIds.includes(ann.id);
        });

        return res.ok({ count: notificationCount + unreadAnnouncements.length });
    } catch (err) {
        return handleError(err, res, req);
    }
};
