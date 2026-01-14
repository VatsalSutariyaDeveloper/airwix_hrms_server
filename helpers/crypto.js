const crypto = require("crypto");

const SECRET_KEY = "12345678901234567890123456789012"; // 32 chars
const IV = "1234567890123456"; // 16 chars

function encrypt(text) {
  if (!text) return text;
  try {
    let cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(SECRET_KEY), IV);
    let encrypted = cipher.update(String(text)); // Ensure it's string
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    // Make URL Safe: + -> -, / -> _, remove =
    return encrypted.toString("base64")
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (e) {
    console.error("Encryption error:", e);
    return text;
  }
}

function decrypt(text) {
  if (!text) return text;
  // If it's already a number, don't decrypt
  if (typeof text === 'number') return text;
  
  try {
    // Restore URL Safe chars: - -> +, _ -> /
    let str = text.replace(/-/g, '+').replace(/_/g, '/');
    
    // Restore padding
    while (str.length % 4) {
      str += '=';
    }

    let encryptedText = Buffer.from(str, "base64");
    let decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(SECRET_KEY), IV);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    const result = decrypted.toString();
    // Return number if it is a valid ID, otherwise return original string
    return isNaN(result) || result === "" ? text : result; 
  } catch (error) {
    return text; // Fallback to original text if decryption fails
  }
}

module.exports = { encrypt, decrypt };