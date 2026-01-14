const { ApprovalWorkflow, ApprovalRule, ApprovalLevel, ApprovalRequest, ApprovalLog, User } = require("../models");
const { Op } = require("sequelize");
const commonQuery = require("./commonQuery");

const STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
};

const ApprovalEngine = {

  /**
   * Helper: Compare a single value against a rule
   */
  evaluateCondition: (recordValue, operator, ruleValue) => {
    const numRecord = parseFloat(recordValue);
    const numRule = parseFloat(ruleValue);
    const isNum = !isNaN(numRecord) && !isNaN(numRule);

    switch (operator) {
      case '>': return isNum && numRecord > numRule;
      case '<': return isNum && numRecord < numRule;
      case '>=': return isNum && numRecord >= numRule;
      case '<=': return isNum && numRecord <= numRule;
      case '=': return recordValue == ruleValue; 
      case '!=': return recordValue != ruleValue;
      case 'CONTAINS': return String(recordValue).toLowerCase().includes(String(ruleValue).toLowerCase());
      default: return false;
    }
  },

  /**
   * Main Logic: Find the FIRST workflow that matches the data
   */
  checkApprovalRequired: async (moduleEntityId, recordData, companyId) => {
    // 1. Fetch Workflows sorted by PRIORITY (1 -> 999)
    const workflows = await commonQuery.findAllRecords(
      ApprovalWorkflow,
      { module_entity_id: moduleEntityId, status: 1, company_id: companyId },
      {
        include: [{ 
          model: ApprovalRule, 
          as: 'rules',
          separate: true, 
          order: [['sequence', 'ASC'], ['id', 'ASC']] 
        }],
        order: [['priority', 'ASC']] 
      },
      null, false
    );

    if (!workflows || workflows.length === 0) return null;

    // 2. Iterate through Workflows
    for (const workflow of workflows) {
      
      // If no rules, it's a "Catch-All" (matches everything)
      if (!workflow.rules || workflow.rules.length === 0) {
        return workflow;
      }

      // 3. Evaluate Logic Chain (Sequential Evaluation)
      // Example: Rule1(True) AND Rule2(False) OR Rule3(True)
      
      const rules = workflow.rules;
      
      // Start with the result of the first rule
      let currentResult = ApprovalEngine.evaluateCondition(
        recordData[rules[0].field_name], 
        rules[0].operator, 
        rules[0].value
      );

      // Loop through the rest
      for (let i = 1; i < rules.length; i++) {
        const prevRule = rules[i - 1]; // The operator sits on the previous rule usually, or we store it on current
        const currentRule = rules[i];
        
        const nextConditionResult = ApprovalEngine.evaluateCondition(
            recordData[currentRule.field_name], 
            currentRule.operator, 
            currentRule.value
        );

        // Apply logic based on the PREVIOUS rule's logical_operator
        // (Rule 1) AND (Rule 2)
        if (prevRule.logical_operator === 'OR') {
            currentResult = currentResult || nextConditionResult;
        } else {
            // Default to AND
            currentResult = currentResult && nextConditionResult;
        }
      }

      // 4. If the final result is TRUE, we found our workflow!
      // Stop checking lower priority workflows.
      if (currentResult === true) {
        return workflow;
      }
    }

    return null; // No matching workflow found
  },

  /**
   * Initiate the approval process in DB
   */
  initiateApproval: async (moduleEntityId, entityId, workflowId, companyId, transaction) => {
    return await commonQuery.createRecord(
      ApprovalRequest,
      {
        module_entity_id: moduleEntityId,
        entity_id: entityId,
        workflow_id: workflowId,
        current_level_sequence: 1,
        status: STATUS.PENDING,
        company_id: companyId
      }, 
      transaction
    );
  },
  
  // Note: Ensure you include processAction here as defined in previous steps
  processAction: async (approval_request_id='', entityId, moduleEntityId, userId, action, comment, transaction) => {
      // Re-use the existing processAction logic
      const request = await commonQuery.findOneRecord(
        ApprovalRequest,
        { entity_id: entityId, module_entity_id: moduleEntityId, status: STATUS.PENDING, ...(approval_request_id ? { id: approval_request_id } : {}) },
        {}, transaction, true, false
      );
      if (!request) throw new Error("No pending approval request found.");

      const levels = await commonQuery.findAllRecords(
        ApprovalLevel,
        { workflow_id: request.workflow_id },
        { order: [['level_sequence', 'ASC']] },
        transaction,
        false
      );

    const currentLevel = levels.find(l => l.level_sequence === request.current_level_sequence);
    
    // 3. VALIDATION: Is this user allowed to approve?
    // (Logic: Check if user has the Role ID or is the specific User ID)
    const user = await commonQuery.findOneRecord(User, userId, {}, transaction, false, false);
    // Note: You must adapt this check based on your specific User/Role structure
    const isRoleMatch = currentLevel.approver_type === 'ROLE' && user.role_id === currentLevel.approver_id; 
    const isUserMatch = currentLevel.approver_type === 'USER' && user.id === currentLevel.approver_id;

    if (!isRoleMatch && !isUserMatch) {
       // Allow bypassing this check for Super Admins if needed
       throw new Error("You are not authorized to approve this level.");
    }

    // 4. Log the action
    await commonQuery.createRecord(
      ApprovalLog,
      {
        request_id: request.id,
        user_id: userId,
        action: action,
        comment: comment,
        level_sequence: request.current_level_sequence,
        company_id: request.company_id
      }, 
      transaction
    );
    // const request = await ApprovalRequest.findOne({
    //       where: { entity_id: entityId, module_entity_id: moduleEntityId, status: STATUS.PENDING, ...(approval_request_id ? { id: approval_request_id } : {}) },
    //       transaction
    //   });

    if (action === 'REJECT') {
        await request.update({ status: STATUS.REJECTED }, { transaction });
        return { status: STATUS.REJECTED };
    } else if (action === 'APPROVE') {
        const nextLevel = levels.find(l => l.level_sequence === request.current_level_sequence + 1);
        if (nextLevel) {
            await request.update({ current_level_sequence: nextLevel.level_sequence }, { transaction });
            return { status: STATUS.PENDING, next_level: nextLevel.level_sequence };
        } else {
            await request.update({ status: STATUS.APPROVED }, { transaction });
            return { status: STATUS.APPROVED };
        }
    }
  }
};

module.exports = ApprovalEngine;