const assert = require('assert/strict');
const {
  authorizeUpstreamRequest,
  sanitizeUpstreamPath,
  getCustomCrmConfig,
} = require('../src/services/customCrmProxy');

const previous = {
  enabled:process.env.CUSTOM_CRM_PROXY_ENABLED,
  clientAuth:process.env.CUSTOM_CRM_ALLOW_CLIENT_AUTH,
  paths:process.env.CUSTOM_CRM_ALLOWED_PATHS,
};

try {
  delete process.env.CUSTOM_CRM_PROXY_ENABLED;
  delete process.env.CUSTOM_CRM_ALLOW_CLIENT_AUTH;
  process.env.CUSTOM_CRM_ALLOWED_PATHS = '/backend';

  const config = getCustomCrmConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.allowClientUpstreamAuth, false);

  assert.equal(sanitizeUpstreamPath('/backend/arbitrary/internal/path').ok, true);
  assert.equal(authorizeUpstreamRequest('GET', '/backend/arbitrary/internal/path').ok, false);
  assert.equal(authorizeUpstreamRequest('POST', '/backend/oauth/token').ok, false);
  assert.equal(authorizeUpstreamRequest('GET', '/backend/contacts/contact-1').ok, false);
  assert.equal(authorizeUpstreamRequest('PUT', '/backend/contacts/contact-1').ok, true);
  assert.equal(authorizeUpstreamRequest('POST', '/backend/contacts/contact-1/notes').ok, true);
  assert.equal(authorizeUpstreamRequest('GET', '/backend/conversations/search').ok, true);
  assert.equal(authorizeUpstreamRequest('GET', '/backend/conversations/conversation-1/messages').ok, true);
  assert.equal(authorizeUpstreamRequest('POST', '/backend/conversations/messages').ok, true);
  assert.equal(authorizeUpstreamRequest('GET', '/backend/locations/location-1/customValues').ok, true);
  assert.equal(authorizeUpstreamRequest('DELETE', '/backend/locations/location-1/customValues/value-1').ok, false);
  assert.equal(authorizeUpstreamRequest('PUT', '/backend/locations/location-1/customValues/value-1').ok, true);

  console.log('Custom CRM proxy policy tests passed');
} finally {
  restore('CUSTOM_CRM_PROXY_ENABLED', previous.enabled);
  restore('CUSTOM_CRM_ALLOW_CLIENT_AUTH', previous.clientAuth);
  restore('CUSTOM_CRM_ALLOWED_PATHS', previous.paths);
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
