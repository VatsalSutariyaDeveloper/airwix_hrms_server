const { AsyncLocalStorage } = require('async_hooks');
const storage = new AsyncLocalStorage();

const tenantMiddleware = (req, res, next) => {
  const hostWithPort = req.get('host');
  const host = hostWithPort ? hostWithPort.split(':')[0] : '';
  const subdomain = host.split('.')[0].toUpperCase(); // HRMS, HR, etc.
  
  // 1. Mapping for special subdomain prefixes
  // e.g., if you want 'hr.airwix.in' to use 'AIRWIX_DB_...'  
  const SUBDOMAIN_MAP = {
    'HR': 'AIRWIX',
    'HRMS': 'HRMS',
  };

  const prefix = SUBDOMAIN_MAP[subdomain] || subdomain;

  // Support local development testing header
  let activePrefix = prefix;
  if (req.headers['x-tenant-prefix']) {
    activePrefix = req.headers['x-tenant-prefix'].toUpperCase();
  }

  storage.run(activePrefix, () => {
    req.tenantPrefix = activePrefix;
    next();
  });
};

module.exports = { tenantMiddleware, storage };
