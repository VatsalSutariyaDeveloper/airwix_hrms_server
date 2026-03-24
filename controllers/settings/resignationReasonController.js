const { ResignationReason } = require("../../models");
const { commonQuery, constants, handleError } = require("../../helpers");

exports.create = async (req, res) => {
    try {
        const record = await commonQuery.createRecord(ResignationReason, req.body);
        return res.success(constants.CREATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getAll = async (req, res) => {
    try {
        const fieldConfig = [
            ["reason_name", true, true],
            ["description", true, false],
        ];
    
        const data = await commonQuery.fetchPaginatedData(
            ResignationReason,
            { ...req.body, status: 0 },
            fieldConfig
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getById = async (req, res) => {
    try {
        const record = await commonQuery.findOneRecord(ResignationReason, req.params.id);
        if (!record) return res.error(constants.NOT_FOUND);
        return res.ok(record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.update = async (req, res) => {
    try {
        const record = await commonQuery.updateRecordById(ResignationReason, req.params.id, req.body);
        return res.success(constants.UPDATED, record);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.delete = async (req, res) => {
    try {
        await commonQuery.softDeleteById(ResignationReason, req.params.id);
        return res.success(constants.DELETED);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.dropdownList = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const data = await commonQuery.findAllRecords(ResignationReason, { 
            status: 0,
            company_id: companyId 
        }, {
            attributes: ['id', 'reason_name']
        });
        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};
