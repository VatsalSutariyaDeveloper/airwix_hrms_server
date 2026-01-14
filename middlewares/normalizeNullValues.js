function normalizeValues(obj) {
  for (const key in obj) {
    const value = obj[key];
    
    // 1. Recursive check for nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      normalizeValues(value);
      continue; // Move to the next key after recursion
    }
    if (
      value === 'null' ||
      value === 'undefined' ||
      value === ''
    ) {
      obj[key] = null;
    }
  }
}

const normalizeNullValues =  function(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    normalizeValues(req.body);
  }
  next();
};


module.exports = {
  normalizeValues,
  normalizeNullValues
};