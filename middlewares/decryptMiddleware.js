const { decrypt } = require("../helpers/crypto");

const processData = (data) => {
  if (Array.isArray(data)) {
    return data.map(item => processData(item));
  } else if (typeof data === 'object' && data !== null) {
    for (const key in data) {
      // Check if key is 'id' or ends with 'Id' (e.g., 'companyId')
      if (key === 'id' || key.endsWith('Id') || key.endsWith('_id')) {
        if (typeof data[key] === 'string') {
          // Attempt to decrypt
          const decrypted = decrypt(data[key]);
          
          // If the result is a valid number, replace the encrypted string with the number
          if (!isNaN(decrypted) && decrypted.trim() !== "") {
             data[key] = Number(decrypted); 
          }
        }
      } else {
        // Recursive call for nested objects (like arrays inside body)
        data[key] = processData(data[key]);
      }
    }
  }
  return data;
};

const decryptMiddleware = (req, res, next) => {
  if (req.params) processData(req.params);
  if (req.query) processData(req.query);
  if (req.body) processData(req.body);
  next();
};

module.exports = decryptMiddleware;