const {
    ApprovalRequest,
    ApprovalLevel,
    ApprovalLog,
    ApprovalWorkflow,
    ModuleEntityMaster,
    User,
    SalesOrder, // Import other entities as needed
    PurchaseOrder,
    Indent,
    Quotation
} = require("../../models");
const ApprovalEngine = require("../../helpers/approvalEngine");
const { sequelize, handleError, commonQuery, Op } = require("../../helpers");
const { ENTITIES } = require("../../helpers/constants");
const { MODULES } = require("../../helpers/moduleEntitiesConstants");

/**
 * Get Pending Approvals for the Current Logged-in User
 */
exports.getMyPendingApprovals = async (req, res) => {
    try {
        const { user_id, company_id, role_id } = req.user; // Injected via Auth Middleware usually

        // 1. Fetch all PENDING requests
        // Note: For high volume, we should optimize this query to filter by user/role at SQL level
        // But for complexity, we fetch pending first, then filter in code or using complex Where
        const pendingRequests = await commonQuery.findAllRecords(
            ApprovalRequest,
            {
                status: 'PENDING',
                company_id
            },
            {
                    include: [
                    { 
                        model: ModuleEntityMaster, 
                        as: 'module_entity',
                        attributes: ['entity_name'] 
                    },
                    {
                        model: ApprovalWorkflow,
                        as: 'workflow',
                        attributes: ['workflow_name']
                    }
                ]
            },
            null, false
        );

        // 2. Filter: Is the current user the approver for the current level?
        const myApprovals = [];
        
        for (const req of pendingRequests) {
            // Find the level definition for this request's current sequence
            const currentLevel = await commonQuery.findOneRecord(
                ApprovalLevel,
                {
                    workflow_id: req.workflow_id,
                    level_sequence: req.current_level_sequence
                },
                {}, null, false, false
            );
            
            if (currentLevel) {
                // Check if User matches
                const isUserMatch = currentLevel.approver_type === 'USER' && currentLevel.approver_id === user_id;
                // Check if Role matches
                const isRoleMatch = currentLevel.approver_type === 'ROLE' && currentLevel.approver_id === role_id;

                if (isUserMatch || isRoleMatch) {
                    // Fetch snippet of the actual data (e.g. Sales Order Amount)
                    // This is optional but good for UI
                    let entityDetails = {};
                    if(req.module_entity_id === MODULES.SALES.QUOTATION.ID) {
                        entityDetails = await commonQuery.findOneRecord(
                            Quotation,
                            req.entity_id, 
                            { attributes: ['series_code', 'total_amount', 'quotation_date', 'party_id'] },
                            {}, null, false, false
                        );
                    } else if(req.module_entity_id === MODULES.SALES.SALES_ORDER.ID) {
                        entityDetails = await commonQuery.findOneRecord(
                            SalesOrder,
                            req.entity_id, 
                            { attributes: ['series_code', 'total_amount', 'sales_order_date', 'party_id'] },
                            {}, null, false, false
                        );
                    }

                    myApprovals.push({
                        ...req.toJSON(),
                        approval_level_details: currentLevel,
                        entity_details: entityDetails
                    });
                }
            }
        }

        return res.ok(myApprovals);

    } catch (err) {
        return handleError(err, res, req);
    }
};

/**
 * Take Action (Approve / Reject)
 */
exports.takeAction = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const {
            approval_request_id,
            entity_type, // String code e.g., 'SALES_ORDER'
            entity_id,   // ID of the record
            action,      // 'APPROVE' or 'REJECT'
            comment,
            user_id,
            company_id
        } = req.body;

        if (!action || !entity_id || !entity_type) {
             await transaction.rollback();
             return res.error("VALIDATION_ERROR", { errors: ["Missing required fields"] });
        }

        // 2. Call the Engine
        const result = await ApprovalEngine.processAction(
            approval_request_id,
            entity_id,
            entity_type,
            user_id,
            action,
            comment,
            transaction
        );

        // 3. Post-Processing: Update the Actual Entity Table Status
        // This keeps the Entity table in sync with the Approval Request
        if (result.status === 'APPROVED') {
            // Fully Approved
            if (entity_type === MODULES.SALES.QUOTATION.ID) {
                await commonQuery.updateRecordById(Quotation, entity_id, { status: 0 }, transaction);
            } else if (entity_type === MODULES.SALES.SALES_ORDER.ID) {
                await commonQuery.updateRecordById(SalesOrder, entity_id, { status: 0 }, transaction);
            } 
            // Add other entities here (PurchaseOrder, etc.)
        } 
        else if (result.status === 'REJECTED') {
            // Rejected
            if (entity_type === MODULES.SALES.QUOTATION.ID) {
                await commonQuery.updateRecordById(Quotation, entity_id, { status: 1 }, transaction);
            } else if (entity_type === MODULES.SALES.SALES_ORDER.ID) {
                await commonQuery.updateRecordById(SalesOrder, entity_id, { status: 1 }, transaction);
            } 
        }
        // If status is 'PENDING', it means it moved to the next level, so we don't change the Entity Status (keep it as 'Pending Approval')

        await transaction.commit();
        return res.success("Action Processed Successfully");

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};

/**
 * View Approval History (Logs)
 */
exports.getApprovalHistory = async (req, res) => {
    try {
        const { entity_type, entity_id } = req.body;
        
        // Resolve Request ID first (Optional, or join tables)
        const requests = await commonQuery.findAllRecords(ApprovalRequest, {
            module_entity_id: entity_type,
            entity_id 
        }, {
            attributes: ['id', 'status', 'createdAt']
        }, null, false);

        const requestIds = requests.map(r => r.id);

        const logs = await commonQuery.findAllRecords(ApprovalLog, { 
            request_id: { [Op.in]: requestIds } 
        }, {
            include: [
                { model: User, as: 'user', attributes: ['user_name'] }
            ],
            order: [['createdAt', 'DESC']]
        }, null, false);

        return res.ok(logs);
    } catch (err) {
        return handleError(err, res, req);
    }
};

exports.createApprovalRequest = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const { entity_type, entity_id, company_id, user_id } = req.body;

        if (!entity_type || !entity_id) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { errors: ["Entity Type and ID are required."] });
        }

        // 1. Identify the Model and Status Field based on Entity Type
        let Model, statusField = 'status';
        let recordData = null;

        // Map generic entity types to Sequelize Models
        // Ensure ENTITIES constants are defined in helpers/constants.js
        switch (entity_type) {
            case MODULES.SALES.QUOTATION.ID:
                Model = Quotation;
                break;
            case MODULES.SALES.SALES_ORDER:
                Model = SalesOrder;
                break;
            // case MODULES.SALES.:
            //     Model = PurchaseOrder;
            //     break;
            // case MODULES.SALES.:
            //     Model = Indent;
            //     break;
            default:
                await transaction.rollback();
                return res.error("VALIDATION_ERROR", { errors: ["Invalid or Unsupported Entity Type."] });
        }

        // 2. Fetch the Record Data (Required to check rules like 'total_amount > 5000')
        recordData = await commonQuery.findOneRecord(Model, entity_id, {}, transaction, false, false);

        if (!recordData) {
            await transaction.rollback(); 
            return res.error("NOT_FOUND", { errors: ["Record not found."] });
        }

        // Optional: Check if already pending
        const existingRequest = await commonQuery.findOneRecord(ApprovalRequest, {
            module_entity_id: entity_type,
            entity_id: entity_id,
            status: 'PENDING'
        }, {}, transaction, false, false);

        if (existingRequest) {
            await transaction.rollback();
            return res.error("VALIDATION_ERROR", { errors: ["This record is already pending approval."] });
        }

        // 3. Check if Approval is Required (Using the Engine)
        const workflow = await ApprovalEngine.checkApprovalRequired(
            entity_type,
            recordData.toJSON(), // Pass plain data
            company_id
        );

        let responseMessage = "Approval not required. Status updated to Active.";
        let newStatus = 0; // Active/Approved default

        if (workflow) {
            // --- A. Approval IS Required ---
            
            // 4. Initiate the Request in DB
            await ApprovalEngine.initiateApproval(
                entity_type,
                entity_id,
                workflow.id,
                company_id,
                transaction
            );

            newStatus = 4; // 4 = Pending Approval (Adjust based on your status constants)
            responseMessage = "Approval Request Created. Sent to Level 1.";
        } 
        
        // 5. Update the Main Entity Status (e.g., Sales Order Status)
        // If workflow found -> Status 4 (Pending)
        // If no workflow -> Status 0 (Active)
        await commonQuery.updateRecordById(
            Model,
            entity_id,
            { [statusField]: newStatus },
            transaction
        );

        await transaction.commit();
        return res.success(responseMessage, { 
            approval_required: !!workflow,
            new_status: newStatus 
        });

    } catch (err) {
        if (!transaction.finished) await transaction.rollback();
        return handleError(err, res, req);
    }
};