const Message = require('../../../models/mongo/message'); // Import Mongo Model

exports.getChatHistory = async (req, res) => {
  try {
    const { userId1, userId2 } = req.params;

    // Find conversation between these two MySQL IDs
    const messages = await Message.find({
      $or: [
        { senderId: userId1, receiverId: userId2 },
        { senderId: userId2, receiverId: userId1 }
      ]
    }).sort({ createdAt: 1 }); // Oldest first

    return res.status(200).json({
      success: true,
      data: messages
    });

  } catch (error) {
    console.error("Chat History Error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch chat" });
  }
};