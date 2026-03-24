const { Notification } = require("../models");
const { commonQuery, handleError } = require("../helpers");

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

        return notification;
    } catch (err) {
        console.error("Notification Service Error:", err.message);
        return null; // Don't crash the main process if notification fails
    }
};

module.exports = {
    createNotification
};
