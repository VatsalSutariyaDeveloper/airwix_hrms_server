const { ResignationReason } = require("../../models");
const { commonQuery, constants, handleError } = require("../../helpers");

exports.createReason = async (req, res) => {
    try {
        const record = await commonQuery.createRecord(ResignationReason, req.body);
        return res.success(constants.CREATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAllReasons = async (req, res) => {
    try {
        const data = await commonQuery.findAllRecords(ResignationReason, { status: 0 });
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getReasonById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(ResignationReason, req.params.id);
        if (!record) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.updateReason = async (req, res) => {
    try {
        const record = await commonQuery.updateRecordById(ResignationReason, req.params.id, req.body);
        return res.success(constants.UPDATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.deleteReason = async (req, res) => {
    try {
        await commonQuery.softDeleteById(ResignationReason, req.params.id);
        return res.success(constants.DELETED);
    } catch (err) {
        return handleError(err, res, req);
    }
};
