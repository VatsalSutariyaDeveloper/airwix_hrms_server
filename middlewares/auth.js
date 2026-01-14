const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
console.log("Auth Header:", authHeader);
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        status: 401,
        message: "Access denied. No token provided.",
      });
    }

    const token = authHeader.split(" ")[1];

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your_jwt_secret");

    if (!decoded) {
        return res.status(401).json({
            status: 401,
            message: "Invalid or expired token.",
      });
    }

    // Continue to the next middleware or route
    next();
  } catch (err) {
    return res.status(401).json({
      status: 401,
      message: "Invalid or expired token.",
      error: err.message,
    });
  }
};

module.exports = authMiddleware;
