const { StatutoryPTRule, StateMaster } = require("../../models");
const { commonQuery, handleError } = require("../../helpers");
const constants = require("../../helpers/constants");

exports.getAll = async (req, res) => {
    try {
        const rules = await commonQuery.findAllRecords(StatutoryPTRule, {}, {
            include: [{ model: StateMaster, attributes: ['id', ['state_name', 'name']] }]
        });
        return res.ok(rules);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.getStatesWithRules = async (req, res) => {
    try {
        const rules = await StatutoryPTRule.findAll({
            attributes: ['state_id'],
            group: ['StatutoryPTRule.state_id', 'StateMaster.id', 'StateMaster.state_name'],
            include: [{ model: StateMaster, attributes: ['id', ['state_name', 'name']] }]
        });
        
        const states = rules.map(r => r.StateMaster);
        return res.ok(states);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.create = async (req, res) => {
    try {
        const rule = await commonQuery.createRecord(StatutoryPTRule, req.body);
        return res.ok(rule);
    } catch (err) {
        return handleError(err, res, req);
    }
};
