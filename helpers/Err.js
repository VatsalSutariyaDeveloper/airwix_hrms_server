// utils/Err.js

class Err extends Error {
  constructor(message, data = null) {
    super(message);
    this.name = "Err";
    this.handled = true; 
    this.data = data;
  }
}

// The shortcut function you requested
const fail = (message, data = null) => {
  throw new Err(message, data);
};

// Export both
module.exports = { Err, fail };