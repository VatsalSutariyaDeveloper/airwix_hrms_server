const { handleError } = require("../helpers");
const { User, CompanyMaster, BranchMaster } = require("../models");

/**
 * Middleware to validate the presence and existence of company_id, branch_id, and user_id in the request body.
 * This is crucial for ensuring that all operations are performed within a valid tenant and user context.
 */
const validateTenant = async (req, res, next) => {
  console.log(req.body)
  const { company_id, branch_id, user_id } = req.body;

  // 1. Check for the presence of required IDs in the request body.
  if (!company_id) {
    return res.status(401).json({
      code: 401,
      status: "UNAUTHORIZED_REQUEST",
      message: "Company is required.",
    });
  }
  if (!branch_id) {
    return res.status(401).json({
      code: 401,
      status: "UNAUTHORIZED_REQUEST",
      message: "Branch is required.",
    });
  }
  if (!user_id) {
    return res.status(401).json({
      code: 401,
      status: "UNAUTHORIZED_REQUEST",
      message: "User is required.",
    });
  }

  try {
    // 2. Concurrently check if the provided IDs exist in the database.
    const [company, branch, user] = await Promise.all([
      CompanyMaster.findOne({ where: { id: company_id, status: 0 } }),
      BranchMaster.findOne({ where: { id: branch_id, company_id: company_id, status: 0 } }),
      User.findOne({ where: { id: user_id, company_id: company_id, status: 0 } }),
    ]);

    // 3. Return specific error messages if any of the lookups fail.
    if (!company) {
      return res.status(401).json({
        code: 401,
        status: "UNAUTHORIZED_REQUEST",
        message: `Invalid Company ID: No active company found for company_id ${company_id}.`,
      });
    }
    if (!branch) {
      return res.status(401).json({
        code: 401,
        status: "UNAUTHORIZED_REQUEST",
        message: `Invalid Branch ID: No active branch found for branch_id ${branch_id} within the specified company.`,
      });
    }
    if (!user) {
      return res.status(401).json({
        code: 401,
        status: "UNAUTHORIZED_REQUEST",
        message: `Invalid User ID: No active user found for user_id ${user_id} within the specified company.`,
      });
    }

    // 4. If all checks pass, proceed to the next middleware or the route handler.
    next();
  } catch (error) {
    return handleError(err, res, req);
  }
};

module.exports = validateTenant;
