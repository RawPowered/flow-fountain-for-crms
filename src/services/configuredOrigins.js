// Custom CRM adapters are opt-in and match exact HTTPS origins only.
function isConfiguredCrmOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return String(process.env.CRM_ALLOWED_ORIGINS || '').split(',').some((entry) => {
      try {
        const allowed = new URL(entry.trim());
        return allowed.protocol === 'https:' && !allowed.username && !allowed.password &&
          allowed.pathname === '/' && !allowed.search && !allowed.hash && allowed.origin === url.origin;
      } catch { return false; }
    });
  } catch { return false; }
}

module.exports = { isConfiguredCrmOrigin };
