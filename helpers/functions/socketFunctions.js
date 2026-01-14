const { User } = require("../../models");
const { getIo } = require("../../socket");

/**
 * Notifies specific users via WebSockets that their session data is outdated.
 * This is a generic function that can target users by company, branch, or individual ID.
 *
 * @param {object} target - An object specifying who to notify. Can contain company_id, branch_id, or user_id.
 * @param {string} message - The message to send to the user, which will be displayed in the reload modal.
 */
exports.notifyUsers = async (target, message) => {
  // Validate that the target object is valid
  if (!target || typeof target !== 'object' || Object.keys(target).length === 0) {
    console.error("[Socket Helper] Error: Invalid or empty target specified for notification.");
    return;
  }

  try {
    const whereClause = {};
    if (target.company_id) whereClause.company_id = target.company_id;
    if (target.branch_id) whereClause.branch_id = target.branch_id;
    if (target.user_id) whereClause.id = target.user_id;
console.log("Where Clause:", whereClause);
    // Find all users who match the target criteria
    const affectedUsers = await User.findAll({
      where: whereClause,
      attributes: ['id'], // We only need the user ID for the socket room
      raw: true,
    });
console.log("Affected Users:", affectedUsers.id);
    if (affectedUsers.length === 0) {
      console.log(`[Socket Helper] No users found for target:`, target);
      return; // No users to notify
    }
console.log("Affected Users:", affectedUsers);
    const io = getIo();
    
    // Create a unique set of user IDs to ensure each user is notified only once
    const userIds = [...new Set(affectedUsers.map(user => user.id))];
console.log("Unique User IDs to notify:", userIds);
    userIds.forEach(userId => {
        console.log(`[Socket Helper] Notifying user ID: ${userId}`);
      // Emit the event to the "room" named after the user's ID
      io.to(userId.toString()).emit('session_updated', { message });
      console.log(`[Socket Helper] Event 'session_updated' emitted to room: user_${userId}`);
    });

  } catch (error) {
    // Log any errors but don't crash the main process
    console.error("[Socket Helper] Failed to send socket notification:", error);
  }
};