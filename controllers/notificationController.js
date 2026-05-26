const { Notification, Announcement, Employee, sequelize, RolePermission, User, UserDevice } = require("../models");
const { handleError, constants, commonQuery, Op } = require("../helpers");
const { getFilteredAnnouncements } = require("../helpers/functions/commonFunctions");
const dayjs = require("dayjs");

/**
 * Get unified list of personal notifications and active announcements
 */
exports.getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        // 1. Fetch Personal Notifications
        const personalNotifications = await commonQuery.findAllRecords(Notification, {
            user_id: userId,
            status: { [Op.ne]: 2 } // Not deleted
        }, {
            order: [['created_at', 'DESC']],
            limit: 50
        }, null);

        // 2. Get filtered announcements using reusable function
        const filteredAnnouncements = await getFilteredAnnouncements(userId, req.user.role_id, { Announcement, Notification }, false);

        // 3. Merge and Map
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

        // 2. Mark all active announcements as read by creating notification records for them
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

        // Filter announcements that target this user
        const filteredAnnouncements = activeAnnouncements.filter(ann => {
            if (ann.target_type === null || ann.target_type === undefined) return false; // Skip if target_type is null/undefined (0 = All users is valid)
            
            if (ann.target_type === 0) return true; // All users
            if (ann.target_type === 1) return true; // All employees
            if (ann.target_type === 2) {
                // Specific roles
                if (!ann.target || !req.user.role_id) return false;
                const targetArray = Array.isArray(ann.target) ? ann.target : String(ann.target || "").split(",");
                const targetRoleIds = targetArray.map(t => parseInt(String(t).trim()));
                return targetRoleIds.includes(req.user.role_id);
            }
            if (ann.target_type === 3) {
                // Specific users
                if (!ann.target || !userId) return false;
                const targetArray = Array.isArray(ann.target) ? ann.target : String(ann.target || "").split(",");
                const targetUserIds = targetArray.map(t => parseInt(String(t).trim()));
                return targetUserIds.includes(userId);
            }
            return false;
        });

        // Create notification records for unread announcements
        for (const ann of filteredAnnouncements) {
            // Safety checks
            if (!ann.id || !userId || !companyId) continue;
            
            const existing = await Notification.findOne({
                where: {
                    user_id: userId,
                    type: 'ANNOUNCEMENT',
                    reference_id: ann.id,
                }
            });

            if (!existing) {
                await Notification.create({
                    user_id: userId, // Required: link to the current user
                    type: 'ANNOUNCEMENT',
                    reference_id: ann.id,
                    title: ann.title || 'Announcement',
                    message: ann.content || '',
                    status: 0,
                    is_read: 1, // Mark as read immediately
                    company_id: companyId,
                    branch_id: req.user.branch_id || null
                });
            } else if (existing.is_read === 0) {
                await Notification.update({ is_read: 1 }, {
                    where: { id: existing.id }
                });
            }
        }

        return res.ok({ success: true });
    } catch (err) {
        console.error('markAllAsRead error:', err);
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

/**
 * Update User FCM Token for push notifications
 */
exports.updateFcmToken = async (req, res) => {
    try {
        const { fcm_token } = req.body;
        const userId = req.user.id;
        console.log("userId", userId);
        if (!fcm_token) {
            return res.error(constants.VALIDATION_ERROR, "FCM token is required");
        }

        // Skip FCM token storage for attendance and canteen devices
        const isDeviceSession = req.user.access === "attendance" || req.user.access === "canteen";
        if (isDeviceSession) {
            // Delete FCM token if it exists in the database
            await commonQuery.hardDeleteRecords(UserDevice, { fcm_token }, null);
            await User.update({ fcm_token: null }, { where: { fcm_token } });
            return res.ok({ message: "FCM token storage skipped and deleted if existing for device sessions" });
        }

        // 1. Dual-register in our multi-device table
        const companyId = req.user.company_id || null;
        const existingDevice = await commonQuery.findOneRecord(UserDevice, { fcm_token }, {}, null, false, {});
        if (!existingDevice) {
            await commonQuery.createRecord(UserDevice, { user_id: userId, fcm_token, company_id: companyId }, null, true, {});
        } else {
            await commonQuery.updateRecordById(UserDevice, { fcm_token }, { user_id: userId, company_id: companyId }, null, false, {});
        }

        // 2. Fallback update on User model for legacy/single-query references
        await commonQuery.updateRecordById(User, userId, { fcm_token }, null, true, {});

        return res.ok({ message: "FCM token updated successfully" });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Remove User FCM Token on logout or token deactivation
 */
exports.removeFcmToken = async (req, res) => {
    try {
        const { fcm_token } = req.body;
        const userId = req.user.id;

        if (!fcm_token) {
            return res.error(constants.VALIDATION_ERROR, "FCM token is required");
        }

        // 1. Remove from multi-device table
        await commonQuery.deleteRecord(UserDevice, { user_id: userId, fcm_token }, null);

        // 2. Clear legacy fcm_token on User model if it matches
        const user = await commonQuery.findOneRecord(User, { id: userId }, { attributes: ["id", "fcm_token"] }, null, false, {});
        if (user && user.fcm_token === fcm_token) {
            await commonQuery.updateRecordById(User, userId, { fcm_token: null }, null, true, {});
        }

        return res.ok({ message: "FCM token removed successfully" });
    } catch (err) {
        return handleError(err, res, req);
    }
};

