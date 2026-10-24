const { principalType } = require('./sessionAuth');

const PRESERVATION_CAPABILITIES = Object.freeze([
  'view',
  'manage_secrets',
  'manage_integrations',
  'design_exports',
  'run_exports',
  'download_artifacts',
  'restore_configuration',
  'view_audit',
]);

const ROLE_CAPABILITIES = Object.freeze({
  root: Object.freeze([...PRESERVATION_CAPABILITIES]),
  platform: Object.freeze([
    'view',
    'manage_integrations',
    'design_exports',
    'run_exports',
  ]),
  tenant: Object.freeze([]),
  viewer: Object.freeze([]),
});

function preservationCapabilities(admin) {
  const role = principalType(admin);
  return [...(ROLE_CAPABILITIES[role] || [])];
}

function hasPreservationCapability(admin, capability) {
  if (!PRESERVATION_CAPABILITIES.includes(capability)) return false;
  return preservationCapabilities(admin).includes(capability);
}

function requirePreservationCapability(capability) {
  if (!PRESERVATION_CAPABILITIES.includes(capability)) {
    throw new Error(`Unknown preservation capability: ${capability}`);
  }
  return (req, res, next) => {
    if (hasPreservationCapability(req.session?.admin, capability)) return next();
    return res.status(403).json({ error: `Preservation capability required: ${capability}` });
  };
}

module.exports = {
  PRESERVATION_CAPABILITIES,
  ROLE_CAPABILITIES,
  preservationCapabilities,
  hasPreservationCapability,
  requirePreservationCapability,
};
