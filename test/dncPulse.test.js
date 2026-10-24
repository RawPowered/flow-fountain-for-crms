const assert = require('assert/strict');
const {
  buildDncPulseUrl,
  buildDncDraftUrl,
  buildCustomCrmContactUrl,
  extractPulseUrls,
  fetchDncPulseUrlFromNotes,
  fetchLeadConnectorContact,
} = require('../src/services/dncPulse');
const { encryptSecret } = require('../src/services/secretBox');
const {
  findDncRuleForRecord,
  classifyDncScreening,
  dncDestinationStatus,
} = require('../src/services/crmImporter');
const { assertDncAssignmentAllowed } = require('../src/services/leadPools');

const pulse = buildDncPulseUrl({
  templateUrl: 'https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=contact-1&locationId=location-1&t=secret-token',
  contactId: 'contact-1',
  locationId: 'location-1',
});
const parsed = new URL(pulse);
assert.equal(parsed.origin, 'https://webapi.dncscrub.com');
assert.equal(parsed.searchParams.get('contactId'), 'contact-1');
assert.equal(parsed.searchParams.get('locationId'), 'location-1');
assert.equal(parsed.searchParams.get('t'), 'secret-token');
const draft = new URL(buildDncDraftUrl({ contactId: 'contact-1', locationId: 'location-1' }));
assert.equal(draft.searchParams.get('contactId'), 'contact-1');
assert.equal(draft.searchParams.get('locationId'), 'location-1');
assert.equal(draft.searchParams.has('t'), false);
assert.equal(
  buildCustomCrmContactUrl({ contactId: 'contact-1', locationId: 'location-1' }),
  'https://crm.example.invalid/v2/location/location-1/contacts/detail/contact-1'
);
assert.throws(() => buildCustomCrmContactUrl({ contactId: '../bad', locationId: 'location-1' }), /Valid contactId/);
assert.throws(() => buildDncPulseUrl({
  templateUrl: 'https://evil.example/gohighlvl/contact-scrub.html?t=secret-token',
  contactId: 'contact-1', locationId: 'location-1',
}), /not allowlisted/);
assert.throws(() => buildDncPulseUrl({
  templateUrl: 'https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=other&locationId=location-1&t=secret-token',
  contactId: 'contact-1', locationId: 'location-1',
}), /does not match/);
assert.equal(extractPulseUrls({ notes: [{ body: 'Click https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=contact-1&amp;locationId=location-1&amp;t=note-token' }] })[0],
  'https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=contact-1&locationId=location-1&t=note-token');

const dncRule = {
  poolKey: 'dnc', label: 'DNC', statusValues: ['do_not_call', 'dnc'],
  destinationStatus: 'do_not_call', isEnabled: true,
};
assert.equal(findDncRuleForRecord({ tags: ['DNC'] }, [dncRule]), dncRule);
assert.equal(findDncRuleForRecord({ tags: ['roofing'] }, [dncRule]), null);
assert.equal(classifyDncScreening({ tags: ['dnc-blocked'] }).state, 'blocked');
assert.equal(classifyDncScreening({ tags: ['dnc-clean'] }).state, 'clean');
assert.equal(classifyDncScreening({ tags: ['dnc-wireless'] }).state, 'clean');
assert.equal(classifyDncScreening({ tags: ['dnd'] }).state, 'pending');
assert.equal(classifyDncScreening({ tags: [] }).state, 'pending');

const pendingRule = { poolKey: 'dnc_pending', statusValues: ['dnc_pending', 'dnd'], isEnabled: true };
const availableRule = { poolKey: 'available', statusValues: ['uncontacted'], destinationStatus: 'uncontacted', isAssignable: true, isEnabled: true };
const assignedRule = { poolKey: 'assigned', statusValues: ['assigned'], assignmentPolicy: 'require_user', isEnabled: true };
assert.equal(dncDestinationStatus({ state: 'clean' }, [dncRule, pendingRule, availableRule]), 'uncontacted');
assert.equal(dncDestinationStatus({ state: 'pending' }, [dncRule, pendingRule, availableRule]), 'dnc_pending');
assert.throws(() => assertDncAssignmentAllowed([{ status: 'dnc_pending' }], assignedRule,
  [dncRule, pendingRule, availableRule, assignedRule]), /require a clean DNC result/);
assert.throws(() => assertDncAssignmentAllowed([{ status: 'do_not_call' }], availableRule,
  [dncRule, pendingRule, availableRule, assignedRule]), /require a clean DNC result/);
assert.throws(() => assertDncAssignmentAllowed([{ status: 'uncontacted', dncStatus: 'pending' }], assignedRule,
  [dncRule, pendingRule, availableRule, assignedRule]), /require a clean DNC result/);
assert.doesNotThrow(() => assertDncAssignmentAllowed([{ status: 'uncontacted', dncStatus: 'clean' }], assignedRule,
  [dncRule, pendingRule, availableRule, assignedRule]));

async function testNoteDiscovery() {
  process.env.SESSION_SECRET = 'dnc-pulse-test-secret';
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    const body = String(url).endsWith('/notes')
      ? { notes: [{ body: 'DNC Scrub: https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=contact-1&locationId=location-1&t=note-token' }] }
      : { contact: { id: 'contact-1', locationId: 'location-1', tags: ['dnc-clean'] } };
    return new Response(JSON.stringify(body),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const discovered = await fetchDncPulseUrlFromNotes({
      provider: 'leadconnector-pit',
      base_url: 'https://services.leadconnectorhq.com',
      auth_scheme: 'Bearer',
      credential_enc: encryptSecret('pit-test-token'),
      config_json: JSON.stringify({ version: '2021-07-28' }),
    }, 'contact-1', 'location-1');
    assert.equal(new URL(discovered).searchParams.get('t'), 'note-token');
    assert.equal(request.url, 'https://services.leadconnectorhq.com/contacts/contact-1/notes');
    assert.equal(request.options.headers.Authorization, 'Bearer pit-test-token');
    const contact = await fetchLeadConnectorContact({
      provider: 'leadconnector-pit',
      base_url: 'https://services.leadconnectorhq.com',
      auth_scheme: 'Bearer',
      credential_enc: encryptSecret('pit-test-token'),
      config_json: '{}',
    }, 'contact-1');
    assert.deepEqual(contact.tags, ['dnc-clean']);
    assert.equal(request.url, 'https://services.leadconnectorhq.com/contacts/contact-1');
  } finally {
    global.fetch = originalFetch;
  }
}

testNoteDiscovery().then(() => console.log('DNC pulse tests passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
