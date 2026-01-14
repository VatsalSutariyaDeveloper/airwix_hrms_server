const mongoose = require('mongoose');
require("dotenv").config();

const connectMongoDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB Connected Successfully (Chat Data)');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
    // Don't exit process here, so MySQL app keeps running even if Chat DB fails
  }
};

module.exports = connectMongoDB;