const { DeviceMaster } = require("../models");
const commonQuery = require("./commonQuery");
const crypto = require("crypto");

/**
 * Generates a unique Device ID using standard UUID v4 format (uppercase)
 * and ensuring that the device ID is not already used in the database.
 * 
 * @param {number|string} companyId 
 * @param {number|string} branchId 
 * @param {object} [transaction] 
 * @returns {Promise<string>}
 */
const generateUniqueDeviceId = async (companyId, branchId, transaction = null) => {
    let newDeviceId;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
        newDeviceId = crypto.randomUUID().toUpperCase();
        // Check database-wide (including soft-deleted records and other tenants) for uniqueness
        const existing = await commonQuery.findOneRecord(
            DeviceMaster, 
            { device_id: newDeviceId }, 
            { skipStatus: true }, 
            transaction, 
            false, 
            {}
        );
        if (!existing) isUnique = true;
        attempts++;
    }

    if (!isUnique) {
        throw new Error("Failed to generate a unique Device ID.");
    }
    return newDeviceId;
};

module.exports = {
    generateUniqueDeviceId
};
