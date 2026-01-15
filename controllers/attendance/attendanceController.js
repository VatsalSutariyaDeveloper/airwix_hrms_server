import { punch } from "../../helpers/attendanceHelper.js";

export const punchIn = async (req, res) => {
  await punch(req.user.id, "IN", req.meta);
  res.json({ message: "Punch In recorded" });
};

export const punchOut = async (req, res) => {
  await punch(req.user.id, "OUT", req.meta);
  res.json({ message: "Punch Out recorded" });
};
