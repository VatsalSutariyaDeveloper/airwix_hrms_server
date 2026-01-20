const jwt = require("jsonwebtoken");
const { requestContext } = require("../utils/requestContext.js");

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✅ 1. Attach identity to req.user (ONLY place)
    req.user = {
      id: decoded.id,
      company_id: decoded.company_id,
      branch_id: decoded.branch_id,
      role_id: decoded.role_id,
      permissions: decoded.permissions || [],
      access_by: decoded.access_by || "web login"
    };

    // ✅ 2. Bind AsyncLocalStorage context ONCE
    requestContext.run(
      {
        userId: decoded.id,
        companyId: decoded.company_id,
        branchId: decoded.branch_id,
        roleId: decoded.role_id,
        ip: req.ip
      },
      () => {
        next(); // ✅ only ONE next()
      }
    );

  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = { authMiddleware };
