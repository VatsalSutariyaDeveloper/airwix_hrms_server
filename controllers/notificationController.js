const { Notification, RolePermission, User, UserDevice } = require("../models");
const { handleError, constants, commonQuery, Op } = require("../helpers");

/**
 * Get list of personal notifications
 */
exports.getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        const personalNotifications = await commonQuery.findAllRecords(Notification, {
            user_id: userId,
            status: { [Op.ne]: 2 } // Not deleted
        }, {
            order: [['created_at', 'DESC']]
        }, null);

        return res.ok(personalNotifications);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Mark a notification as read
 */
exports.markAsRead = async (req, res) => {
    try {
        const { id } = req.body;

        const notification = await commonQuery.findOneRecord(Notification, {
            id
        }, {}, null);

        if (notification && notification.is_read === 0) {
            await commonQuery.updateRecordById(Notification, notification.id, { is_read: 1 }, null);
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

        await commonQuery.updateRecordById(Notification, { user_id: userId }, { status: 2, is_read: 1 }, null);

        return res.ok({ success: true });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Clear a single notification (mark as deleted)
 */
exports.clear = async (req, res) => {
    try {
        const { id } = req.body;
        const userId = req.user.id;

        if (!id) {
            return res.error(constants.VALIDATION_ERROR, "Notification ID is required");
        }

        await commonQuery.updateRecordById(Notification, { id, user_id: userId }, { status: 2, is_read: 1 }, null);

        return res.ok({ success: true });
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Mark all notifications as read
 */
exports.markAllAsRead = async (req, res) => {
    try {
        const userId = req.user.id;

        await Notification.update({ is_read: 1 }, { where: { user_id: userId, is_read: 0 } });

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

        const count = await Notification.count({
            where: { user_id: userId, is_read: 0 }
        });

        return res.ok({ count });
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
        await commonQuery.hardDeleteRecords(UserDevice, { fcm_token, user_id: { [Op.ne]: userId } }, null, false);
        if (existingDevice) {
            await commonQuery.updateRecordById(UserDevice, existingDevice.id, { user_id: userId, company_id: companyId }, null, false, {});
        } else {
            await commonQuery.createRecord(UserDevice, { user_id: userId, fcm_token, company_id: companyId }, null, true, {});
        }

        // 2. Fallback update on User model for legacy/single-query references
        await User.update({ fcm_token: null }, { where: { fcm_token, id: { [Op.ne]: userId } } });
        await commonQuery.updateRecordById(User, userId, { fcm_token }, null, true, {});

        const { generateToken } = require("../helpers/tokenHelper");
        const user = await commonQuery.findOneRecord(User, { id: userId }, {
            include: [{ model: RolePermission, as: 'RolePermission', attributes: ['role_key', 'role_name'] }]
        }, null, false, {});

        const newToken = generateToken({
            ...user.toJSON(),
            access: req.user.access
        }, companyId, req.user.access_by || "web login");

        return res.ok({ message: "FCM token updated successfully", token: newToken });
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
        await commonQuery.hardDeleteRecords(UserDevice, { user_id: userId, fcm_token }, null, false);

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

