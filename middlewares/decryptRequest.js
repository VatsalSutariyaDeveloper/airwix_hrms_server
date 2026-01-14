const { decryptId } = require('../helpers/cryptoHelper');

const decryptObject = (obj) => {
  // console.log("obj", obj); 
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => decryptObject(item));
  }

  Object.keys(obj).forEach((key) => {
    const value = obj[key];

    // 1. Single ID
    if ((key === 'id' || key.endsWith('_id') || key.endsWith('Id')) && typeof value === 'string') {
      obj[key] = decryptId(value);
    } 
    
    // 2. Array of IDs
    else if ((key === 'ids' || key.endsWith('_ids') || key.endsWith('Ids')) && Array.isArray(value)) {
      obj[key] = value.map(item => {
        return typeof item === 'string' ? decryptId(item) : decryptObject(item);
      });
    }

    // 3. Nested objects
    else if (typeof value === 'object') {
      obj[key] = decryptObject(value);
    }
  });

  return obj;
};

module.exports = (req, res, next) => {
  try {
    // Regex for IV:Data format (32 hex chars : hex chars)
    const encryptedIdPattern = /([0-9a-fA-F]{32}):([0-9a-fA-F]+)/g;

    if (typeof req.url === "string" && encryptedIdPattern.test(req.url)) {
      
      console.log("🔐 URL BEFORE:", req.url);

      // [FIX] Pass 'match' directly to decryptId
      const newUrl = req.url.replace(encryptedIdPattern, (match) => {
        const decrypted = decryptId(match); // <--- CHANGED THIS LINE
        return decrypted ? String(decrypted) : match;
      });

      if (newUrl !== req.url) {
        req.url = newUrl;
        req._parsedUrl = null; // Important for Express to re-route correctly
      }

      console.log("🔓 URL AFTER :", req.url);
    }
  } catch (err) {
    console.error("❌ URL Decryption failed:", err);
  }

  if (req.body) req.body = decryptObject(req.body);
  if (req.query) req.query = decryptObject(req.query);

  next();
};