const assert = require('assert/strict');
const { evaluateDisposition } = require('../src/services/sentinelFindingDispositions');

const finding = {
  count: 81,
  context: {
    method: 'POST',
    path: '/api/leads/abc/call-attempts/authorize',
    statusCode: 409,
    apiKeyId: 'key-1',
    keyPrefix: 'live_abcd',
    ip: '203.0.113.10',
  },
};
const disposition = {
  scope: { apiKeyId: 'key-1', path: finding.context.path },
  conditions: { allowedStatusCodes: [409], allowedIps: ['203.0.113.10'], maxCount: 100 },
};

assert.deepEqual(evaluateDisposition(finding, disposition), { matches: true, reasons: [] });
assert.deepEqual(evaluateDisposition({ ...finding, context: { ...finding.context, ip: '203.0.113.11' } }, disposition).reasons, ['source_ip_changed']);
assert.deepEqual(evaluateDisposition({ ...finding, context: { ...finding.context, statusCode: 500 } }, disposition).reasons, ['status_code_changed']);
assert.deepEqual(evaluateDisposition({ ...finding, context: { ...finding.context, apiKeyId: 'key-2' } }, disposition).reasons, ['api_key_changed']);
assert.deepEqual(evaluateDisposition({ ...finding, count: 101 }, disposition).reasons, ['volume_exceeded']);
assert.deepEqual(evaluateDisposition({ ...finding, context: { ...finding.context, path: '/api/other' } }, disposition).reasons, ['path_changed']);
console.log('Sentinel finding disposition tests passed');
