const { Notification, User, UserDevice } = require("../models");
const { commonQuery, handleError, logError } = require("../helpers");
const firebaseService = require("../helpers/firebaseService");

/**
 * Service to handle system notifications creation.
 */
const createNotification = async (payload, transaction = null) => {
    try {
        const {
            user_id,
            title,
            message,
            type,
            reference_id = null,
            redirect_url = null,
            status_code = 0,
            company_id,
            branch_id
        } = payload;

        if (!user_id || !title || !message || !type || !company_id) {
            console.error("Notification Service: Missing required fields.", payload);
            return null;
        }

        // 1. Create DB Record
        const notification = await commonQuery.createRecord(Notification, {
            user_id,
            title,
            message,
            type,
            reference_id,
            redirect_url,
            status_code,
            company_id,
            branch_id,
            status: 0 // Unread
        }, transaction);

        // 2. Send Firebase Push Notification to all registered devices in parallel
        try {
            // Fetch all registered devices for this user
            const registeredDevices = await commonQuery.findAllRecords(UserDevice, { user_id: user_id }, { attributes: ["fcm_token"] }, transaction, false);
            let tokens = registeredDevices.map(d => d.fcm_token).filter(Boolean);

            // Safety fallback: if no devices are registered in UserDevice yet, check the legacy User fcm_token
            if (tokens.length === 0) {
                const user = await commonQuery.findOneRecord(User, { id: user_id }, { attributes: ["fcm_token"] }, transaction, false, {});
                if (user && user.fcm_token) {
                    tokens.push(user.fcm_token);
                }
            }

            // Remove any duplicates to avoid double-pushing same device
            tokens = [...new Set(tokens)];

            if (tokens.length > 0) {
                console.log(`[FCM Service] Dispatching parallel push notifications to ${tokens.length} registered devices for user ${user_id}...`);
                
                await Promise.all(tokens.map(async (token) => {
                    try {
                        const response = await firebaseService.sendPushNotification(token, {
                            title: title,
                            body: message,
                            redirect_url: redirect_url,
                            data: {
                                type: type,
                                reference_id: String(reference_id || ""),
                                status_code: String(status_code || "")
                            }
                        });

                        if (!response) {
                            console.warn(`[FCM Notification Warning] FCM delivery returned failure/null for device token starts with: ${token.substring(0, 30)}...`);
                        }
                    } catch (deviceError) {
                        console.error(`[FCM Notification Device Error] Failed to send push to device:`, deviceError.message);
                        
                        // Auto-Cleanup: If token is invalid or expired, automatically delete it from database
                        const errMsg = (deviceError.message || "").toLowerCase();
                        const errCode = (deviceError.code || deviceError.errorInfo?.code || "").toLowerCase();
                        if (errMsg.includes("notregistered") || errMsg.includes("not-registered") || errMsg.includes("invalid") || errMsg.includes("not found") || errMsg.includes("not-found") ||
                            errCode.includes("not-registered") || errCode.includes("invalid") || errCode.includes("not-found") || errCode.includes("notfound")) {
                            console.log(`[FCM Service] Removing invalid/expired token: ${token.substring(0, 30)}...`);
                            await commonQuery.hardDeleteRecords(UserDevice, { fcm_token: token }, transaction, {});
                        }
                    }
                }));
            } else {
                console.warn(`[FCM Notification skipped] User ${user_id} has no registered device fcm_tokens.`);
            }
        } catch (fcmError) {
            console.error("FCM Notification Error:", fcmError.message);
            await logError({
                entity_name: "FCM_NOTIFICATION",
                error_message: `FCM Send Exception: ${fcmError.message}`,
                request_body: { user_id, title, message },
                stack_trace: fcmError.stack
            });
        }

        return notification;
    } catch (err) {
        console.error("Notification Service Error:", err.message);
        return null; // Don't crash the main process if notification fails
    }
};

module.exports = {
    createNotification
};
