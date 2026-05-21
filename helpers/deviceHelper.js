const { DeviceMaster, CompanyMaster, BranchMaster } = require("../models");
const commonQuery = require("./commonQuery");

/**
 * Generates a unique Device ID prefixing 'DEV-{companyCode}{branchCode}-{randomSuffix}'
 * and ensuring that the device ID is not already used in the database.
 * 
 * @param {number|string} companyId 
 * @param {number|string} branchId 
 * @param {object} [transaction] 
 * @returns {Promise<string>}
 */
const generateUniqueDeviceId = async (companyId, branchId, transaction = null) => {
    const company = companyId ? await commonQuery.findOneRecord(CompanyMaster, { id: companyId }, { attributes: ['company_name'] }, transaction, false, {}) : null;
    const branch = branchId ? await commonQuery.findOneRecord(BranchMaster, { id: branchId }, { attributes: ['branch_name'] }, transaction, false, {}) : null;

    const normalizeCodePart = (value, length) => {
        if (!value || typeof value !== "string") return null;
        const letters = value.replace(/[^A-Za-z]/g, "").toUpperCase();
        if (!letters) return null;
        return letters.slice(0, length).padEnd(length, "X");
    };

    const generateDeviceId = () => {
        const companyCode = normalizeCodePart(company?.company_name, 3) || "XXX";
        const branchCode = normalizeCodePart(branch?.branch_name, 3) || "BRN";
        const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
        return `DEV-${companyCode}${branchCode}-${randomSuffix}`;
    };

    let newDeviceId;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
        newDeviceId = generateDeviceId();
        const existing = await commonQuery.findOneRecord(DeviceMaster, { device_id: newDeviceId }, {}, transaction, false, {});
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
