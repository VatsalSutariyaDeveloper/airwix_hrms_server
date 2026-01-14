const crypto = require('crypto');

// Throw error if key is missing to prevent random key issues
if (!process.env.ID_ENCRYPTION_KEY) {
  console.error("❌ FATAL: ID_ENCRYPTION_KEY is missing in .env file.");
  // process.exit(1); // Optional: Stop server if key is missing
}
console.log("🔑 Crypto Key Source:", process.env.ID_ENCRYPTION_KEY ? "Loaded from ENV" : "Using Fallback (WARNING)");

const secretKey = crypto.createHash('sha256').update(process.env.ID_ENCRYPTION_KEY || 'default-fallback-key').digest();
const algorithm = 'aes-256-cbc';

exports.encryptId = (text) => {
  if (!text) return text;
  const textStr = String(text); 
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv);
  let encrypted = cipher.update(textStr);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

exports.decryptId = (text) => {
  if (!text || typeof text !== 'string') return text;
  
  const parts = text.split(':');
  if (parts.length !== 2) return text; 

  try {
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    
    const decipher = crypto.createDecipheriv(algorithm, secretKey, iv);
    
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString();
  } catch (error) {
    // 🔥 Log the actual error to see why it fails
    console.error("❌ Decryption Failed for:", text, "Error:", error.message);
    return text; // Return original text on failure
  }
};