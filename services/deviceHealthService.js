const { DeviceMaster, Notification, User, RolePermission, CompanySettings } = require("../models");
const { constants, Op } = require("../helpers");

/**
 * Scans all paired devices and creates notifications for those that are offline.
 * Offline threshold is dynamic or defaults to 30 minutes.
 */
const checkDeviceHealth = async () => {
    try {
        console.log("🚀 Starting Device Health Check...");

        // 1. Group devices by company to fetch settings once per company
        const pairedDevices = await DeviceMaster.findAll({
            where: {
                status: 0,
                device_id: { [Op.ne]: null }
            }
        });

        if (pairedDevices.length === 0) {
            console.log("✅ No paired devices found.");
            return;
        }

        // Group by company_id
        const devicesByCompany = pairedDevices.reduce((acc, device) => {
            if (!acc[device.company_id]) acc[device.company_id] = [];
            acc[device.company_id].push(device);
            return acc;
        }, {});

        for (const companyId in devicesByCompany) {
            // 2. Fetch Notification Settings for this company
            const settingsRecord = await CompanySettings.findOne({
                where: {
                    company_id: companyId,
                    settings_name: "device_offline_alert_config",
                    status: 0
                }
            });

            // Default roles if no setting is found
            let targetRoleKeys = [constants.ROLE_KEYS.BUSINESS_ADMIN, constants.ROLE_KEYS.ADMIN];
            let thresholdMinutes = 30;

            if (settingsRecord && settingsRecord.settings_value) {
                targetRoleKeys = settingsRecord.settings_value.role_keys || targetRoleKeys;
                thresholdMinutes = settingsRecord.settings_value.threshold_minutes || thresholdMinutes;
            }

            const offlineThreshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);
            const devices = devicesByCompany[companyId];

            for (const device of devices) {
                const isOffline = !device.last_login_at || new Date(device.last_login_at) < offlineThreshold;

                if (isOffline) {
                    // 3. Find target users based on selected roles
                    const recipients = await User.findAll({
                        where: {
                            company_id: companyId,
                            status: 0
                        },
                        include: [{
                            model: RolePermission,
                            as: 'RolePermission',
                            where: {
                                role_key: { [Op.in]: targetRoleKeys }
                            }
                        }]
                    });

                    for (const user of recipients) {
                        // 4. Prevent duplicate unread notifications
                        const existingNotification = await Notification.findOne({
                            where: {
                                user_id: user.id,
                                reference_id: device.id,
                                type: "DEVICE_OFFLINE",
                                is_read: 0
                            }
                        });

                        if (!existingNotification) {
                            await Notification.create({
                                user_id: user.id,
                                company_id: companyId,
                                branch_id: device.branch_id,
                                title: "Device Offline Alert",
                                message: `Warning: The device '${device.device_name}' has been offline for over ${thresholdMinutes} minutes.`,
                                type: "DEVICE_OFFLINE",
                                reference_id: device.id,
                                status_code: 1,
                                redirect_url: "/settings/device"
                            });
                            console.log(`🔔 Alert sent to ${user.user_name} for device ${device.device_name}`);
                        }
                    }
                }
            }
        }
        
        console.log("✅ Device Health Check completed.");
    } catch (error) {
        console.error("❌ Error in Device Health Check:", error);
    }
};

module.exports = {
    checkDeviceHealth
};
