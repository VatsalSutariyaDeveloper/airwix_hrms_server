const { TranspotationMaster } = require("../../models");
const { sequelize, validateRequest, commonQuery, handleError, constants } = require("../../helpers");

// Create a new transportation record
exports.create = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            transpotation_name: "Transportation Name",
        };
        
        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: { model: TranspotationMaster, fields: ["transpotation_name"] },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const newTranspotation = await commonQuery.createRecord(TranspotationMaster, req.body, transaction);
        await transaction.commit();
        
        return res.success(constants.CREATED, newTranspotation);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Get all transportation records with pagination
exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["transpotation_name", true, true],
            ["transpotation_branch", true, true],
            ["email", true, false],
            ["mobile_no", true, false],
            ["tax_no", true, true],
        ];
        
        const options = {
            attributes: ["id", "transpotation_name", "transpotation_branch", "email", "mobile_no", "tax_no", "status"]
        };
        
        const data = await commonQuery.fetchPaginatedData(
            TranspotationMaster,
            req.body,
            fieldConfig,
            options
        );
        
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get a list of transportation records for dropdowns
exports.dropdownList = async (req, res) => {
    try {
        const { user_id, branch_id, company_id } = req.body;
        const records = await commonQuery.findAllRecords(
            TranspotationMaster,
            { user_id, branch_id, company_id, status: 0 },
            { 
                attributes: ["id", "transpotation_name"], 
                order: [["transpotation_name", "ASC"]] 
            }
        );
        
        return res.ok(records);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Get a single transportation record by ID
exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(TranspotationMaster, req.params.id);
        if (!record || record.status === 2) return res.error(constants.NOT_FOUND);
        
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

// Update a transportation record by ID
exports.update = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const requiredFields = {
            transpotation_name: "Transportation Name",
        };
        
        const errors = await validateRequest(req.body, requiredFields, {
            uniqueCheck: { model: TranspotationMaster, fields: ["transpotation_name"], excludeId: id },
        }, transaction);

        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const updated = await commonQuery.updateRecordById(TranspotationMaster, id, req.body, transaction);
        
        if (!updated) {
             await transaction.rollback();
             return res.error(constants.NOT_FOUND);
        }
        
        await transaction.commit();
        return res.success(constants.UPDATED, updated);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Soft delete transportation records by IDs
exports.delete = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const requiredFields = {
            ids: "Select Data",
        };

        const errors = await validateRequest(req.body, requiredFields, {}, transaction);
        if (errors) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, errors);
        }

        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.INVALID_INPUT);
        }

        const deleted = await commonQuery.softDeleteById(TranspotationMaster, ids, transaction);
        if (!deleted) {
            await transaction.rollback();
            return res.error(constants.ALREADY_DELETED);
        }

        await transaction.commit();
        return res.success(constants.DELETED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};

// Update Status
exports.updateStatus = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { status, ids } = req.body;
        
        if (!Array.isArray(ids) || ids.length === 0) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, [constants.SELECT_AT_LEAST_ONE_RECORD]);
        }
        
        if (![0, 1].includes(status)) {
            await transaction.rollback();
            return res.error(constants.VALIDATION_ERROR, [constants.INVALID_STATUS]);
        }

        const updated = await commonQuery.updateRecordById(
            TranspotationMaster,
            ids,
            { status },
            transaction
        );

        if (!updated) {
            await transaction.rollback();
            return res.error(constants.NOT_FOUND);
        }

        await transaction.commit();
        return res.success(constants.TRANSPORT_UPDATED);
    } catch (err) {
        await transaction.rollback();
        return handleError(err, res, req);
    }
};