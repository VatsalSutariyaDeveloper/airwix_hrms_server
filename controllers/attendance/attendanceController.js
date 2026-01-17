const { punch } = require("../../helpers/attendanceHelper.js");
const { handleError, constants } = require("../../helpers");

const attendancePunch = async (req, res) => {
  try {
    const { employee_id } = req.body;
    if (!employee_id) {
      return res.status(400).json({ status: false, message: "Employee ID is required" });
    }

    const result = await punch(employee_id, {
      ...req.body,
      user_id: req.user.id,
      company_id: req.user.company_id,
      branch_id: req.user.branch_id,
      ip_address: req.ip
    });
    
    return res.json({ 
      status: true, 
      message: `Punch ${result.punchType} recorded`, 
      data: result 
    });
  } catch (err) {
    return handleError(err, res, req);
  }
};

module.exports = {
  attendancePunch,
};
