const {
    ApprovalWorkflow,
    ApprovalRule,
    ApprovalLevel,
    ModuleEntityMaster,
    User,
    RolePermission // Assuming you have a Role model
} = require("../../models");
const {
    sequelize,
    Op,
    handleError,
    validateRequest,
    commonQuery
} = require("../../helpers");

const ENTITY = "Approval Workflow";

/**
 * Create a complete Workflow with Rules and Levels in one go.
 */
exports.createCompleteWorkflow = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const {
            module_entity_id,
            workflow_name,
            description,
            priority, // <--- New
            rules, 
            levels,
            company_id,
            user_id
        } = req.body;

        // 1. Create Workflow
        const workflowData = {
            module_entity_id,
            workflow_name,
            description,
            priority: priority || 999,
            company_id,
            user_id: user_id, // commonQuery expects user_id for audit logs
            status: 1
        };
        const workflow = await commonQuery.createRecord(ApprovalWorkflow, workflowData, transaction);

        if (Array.isArray(rules) && rules.length > 0) {
            const rulesData = rules.map((r, index) => ({
                workflow_id: workflow.id,
                field_name: r.field_name,
                operator: r.operator,
                value: r.value,
                logical_operator: r.logical_operator || 'AND',
                sequence: index,
                company_id,
                user_id: user_id
            }));
            await commonQuery.bulkCreate(ApprovalRule, rulesData, {}, transaction);
        }

        // 3. Create Levels (Same as before)
        if (Array.isArray(levels) && levels.length > 0) {
            const levelsData = levels.map(l => ({
                workflow_id: workflow.id,
                level_sequence: l.level_sequence,
                approver_type: l.approver_type,
                approver_id: l.approver_id,
                company_id,
                user_id: user_id
            }));
            await commonQuery.bulkCreate(ApprovalLevel, levelsData, {}, transaction);
        }

        await transaction.commit();
        return res.success("CREATE", "Workflow Created Successfully", workflow);

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Get All Workflows (Paginated)
 */
exports.getAllWorkflows = async (req, res) => {
    try {
        const { company_id } = req.body;
        const query = { company_id };

        const data = await commonQuery.fetchPaginatedData(
            ApprovalWorkflow,
            req.body,
            [
                ["workflow_name", true, true],
                ["status", true, false]
            ],
            {
                where: query,
                include: [
                    { model: ModuleEntityMaster, as: 'module_entity', attributes: ['entity_name'] }
                ]
            },
            false
        );

        return res.ok(data);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Get Single Workflow Detailed View
 */
exports.getWorkflowById = async (req, res) => {
    try {
        const { id } = req.params;
        const workflow = await commonQuery.findOneRecord(ApprovalWorkflow, { id }, {
            include: [
                { model: ApprovalRule, as: 'rules' },
                { 
                    model: ApprovalLevel, 
                    as: 'levels',
                },
                { model: ModuleEntityMaster, as: 'module_entity' }
            ],
            order: [
                [{ model: ApprovalLevel, as: 'levels' }, 'level_sequence', 'ASC']
            ]
        }, null, false, false);

        if (!workflow) return res.error("NOT_FOUND");

        return res.success("FETCH", ENTITY, workflow);
    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Update Workflow
 */
exports.updateWorkflow = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.params;
        const { rules, levels, ...headerData } = req.body;

        // 1. Fetch Existing Workflow Logic
        const existingWorkflow = await commonQuery.findOneRecord(ApprovalWorkflow, id, {}, transaction, false, false);

        if (!existingWorkflow) {
            await transaction.rollback();
            return res.error("NOT_FOUND", "Workflow not found");
        }

        // Use company_id from the database record to be safe
        const companyId = existingWorkflow.company_id;

        // 2. Update Header
        await commonQuery.updateRecordById(ApprovalWorkflow, id, headerData, transaction);

        // 3. Sync Rules (Delete old, add new)
        if (rules && Array.isArray(rules)) {
            await commonQuery.hardDeleteRecords(ApprovalRule, { workflow_id: id }, transaction, false);
            
            if (rules.length > 0) {
                const rulesData = rules.map((r, index) => ({
                    workflow_id: id,
                    field_name: r.field_name,
                    operator: r.operator,
                    value: r.value,
                    // Ensure these new fields are mapped correctly
                    logical_operator: r.logical_operator || 'AND', 
                    sequence: index, // Maintain the order from the array
                    company_id: companyId // Safe Company ID
                }));
                await commonQuery.bulkCreate(ApprovalRule, rulesData, {}, transaction);
            }
        }

        // 4. Sync Levels
        if (levels && Array.isArray(levels)) {
            await commonQuery.hardDeleteRecords(ApprovalLevel, { workflow_id: id }, transaction, false);
            
            if (levels.length > 0) {
                const levelsData = levels.map(l => ({
                    workflow_id: id,
                    level_sequence: l.level_sequence,
                    approver_type: l.approver_type,
                    approver_id: l.approver_id,
                    company_id: companyId // Safe Company ID
                }));
                await commonQuery.bulkCreate(ApprovalLevel, levelsData, {}, transaction);
            }
        }

        await transaction.commit();
        return res.success("UPDATE", ENTITY);

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * Delete Workflow
 */
exports.deleteWorkflow = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { id } = req.body.id;
        
        // Soft delete or Hard delete based on your preference
        // Here assuming Hard delete for config, but you can use update status=2
        await commonQuery.hardDeleteRecords(ApprovalRule, { workflow_id: id }, transaction, false);
        await commonQuery.hardDeleteRecords(ApprovalLevel, { workflow_id: id }, transaction, false);
        const deleted = await commonQuery.hardDeleteRecords(ApprovalWorkflow, { id }, transaction, false);

        if (!deleted) {
            await transaction.rollback();
            return res.error("NOT_FOUND");
        }

        await transaction.commit();
        return res.success("DELETE", ENTITY);
    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

exports.configureApprovalType = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { 
            module_entity_id, 
            type, // 1=None, 2=Admin, 3=Multi, 4=Custom
            company_id,
            admin_role_id, // For Type 2
            approver_ids,  // Array of IDs for Type 3 [UserA, UserB]
            // For Type 4, we assume user uses the "Create Workflow" API directly
        } = req.body;

        // 1. CLEAR EXISTING CONFIGURATION
        // Delete all active workflows for this module to reset settings
        await commonQuery.updateRecordById(
            ApprovalWorkflow,
            { module_entity_id, company_id },
            { status: 2 },
            transaction
        );

        if (type === 1) {
            // Type 1: No Approval
            // Done! We just deleted everything.
            await transaction.commit();
            return res.success("UPDATE", "Approval Disabled for this module.");
        }

        if (type === 2) {
            // Type 2: Admin Approval (Single Step)
            const wf = await commonQuery.createRecord(ApprovalWorkflow, {
                module_entity_id,
                workflow_name: "Admin Approval (System Generated)",
                priority: 1,
                company_id,
                status: 1
            }, transaction);

            // Level 1 = Admin Role
            await commonQuery.createRecord(ApprovalLevel, {
                workflow_id: wf.id,
                level_sequence: 1,
                approver_type: 'ROLE',
                approver_id: admin_role_id,
                company_id
            }, transaction);
        }

        if (type === 3) {
            // Type 3: Multi-Level (Fixed Chain)
            const wf = await commonQuery.createRecord(ApprovalWorkflow, {
                module_entity_id,
                workflow_name: "Multi-Level Approval (System Generated)",
                priority: 1,
                company_id,
                status: 1
            }, transaction);

            // Create Levels from array
            if (approver_ids && approver_ids.length > 0) {
                const levelsData = approver_ids.map((appr, index) => ({
                    workflow_id: wf.id,
                    level_sequence: index + 1,
                    approver_type: appr.type,
                    approver_id: appr.id,
                    company_id
                }));
                await commonQuery.bulkCreate(ApprovalLevel, levelsData, {}, transaction);
            }
        }

        // Type 4 (Custom) is handled by the generic "Create Workflow" API, 
        // as it requires complex rules that don't fit in a simple "Switch" API.

        await transaction.commit();
        return res.success("UPDATE", "Approval Configuration Saved.");

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};