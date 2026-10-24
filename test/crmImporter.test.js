const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const {
  flattenRecord,
  classifyValue,
  safeConfig,
  fetchCrmPage,
  walkCrmContacts,
  createImportRun,
  objectSchemaFields,
} = require('../src/services/crmImporter');
const {
  publicIntegration,
  normalizeCredential,
  validateProviderBaseUrl,
} = require('../src/services/crmIntegrations');
const { encryptSecret } = require('../src/services/secretBox');
const {
  createLeadManagementRouter,
  requireLocationGrant,
  attachImportedData,
} = require('../src/routes/api/leads');
const { setPool } = require('../src/db/pool');

async function run() {
  const flattened = flattenRecord({
    id: 'contact-1',
    name: { first: 'Ada', last: 'Lovelace' },
    tags: ['solar', 'priority'],
    authorization: 'must-not-be-stored',
    nested: { accessToken: 'must-not-be-stored', score: 8 },
  });
  assert.equal(flattened.id, 'contact-1');
  assert.equal(flattened['name.first'], 'Ada');
  assert.deepEqual(flattened.tags, ['solar', 'priority']);
  assert.equal(flattened.authorization, undefined);
  assert.equal(flattened['nested.accessToken'], undefined);
  assert.equal(flattened['nested.score'], 8);

  assert.equal(classifyValue(true).dataType, 'boolean');
  assert.equal(classifyValue(12.5).dataType, 'number');
  assert.equal(classifyValue('2026-07-11T12:00:00Z').dataType, 'datetime');
  assert.equal(classifyValue({ value: 1 }).dataType, 'json');
  assert.deepEqual(objectSchemaFields({ object: { properties: {
    name: { id: 'field-name', type: 'TEXT', label: 'Pet name' },
    age: { id: 'field-age', type: 'NUMBER', label: 'Pet age' },
  } } }).map((field) => field.key), ['name', 'age']);

  const config = safeConfig({ config_json: JSON.stringify({ recordsPath: 'data.contacts' }) });
  assert.equal(config.recordsPath, 'data.contacts');
  assert.equal(config.idPath, 'id');
  assert.equal(config.defaultServiceType, 'Other');
  assert.equal(safeConfig({ provider: 'leadconnector-pit', config_json: '{}' }).maxPageSize, 100);
  assert.equal(safeConfig({
    provider: 'generic', base_url: 'https://services.leadconnectorhq.com', config_json: '{}',
  }).cursorTimeParam, 'startAfter');
  assert.equal(safeConfig({
    provider: 'generic', base_url: 'https://services.leadconnectorhq.com', location_id: 'location-1', config_json: '{}',
  }).useContactSearch, true);
  assert.equal(safeConfig({
    provider: 'generic', base_url: 'https://services.leadconnectorhq.com', location_id: 'location-1', config_json: '{}',
  }).customFieldsPath, '/locations/location-1/customFields');
  assert.equal(safeConfig({
    provider: 'custom-crm', base_url: 'https://crm.example.invalid', config_json: '{}',
  }).usesCompoundContactCursor, true);
  assert.equal(normalizeCredential('Bearer pit-example', 'Bearer'), 'pit-example');
  assert.equal(validateProviderBaseUrl('leadconnector-pit', 'https://services.leadconnectorhq.com'), 'https://services.leadconnectorhq.com');
  assert.throws(
    () => validateProviderBaseUrl('leadconnector-pit', 'https://services.leadconnectorhq.com.evil.example'),
    (error) => error.status === 400
  );

  const exposed = publicIntegration({
    id: 'integration-1',
    name: 'CRM',
    provider: 'generic',
    location_id: 'location-1',
    base_url: 'https://crm.example.com',
    credential_enc: 'encrypted-secret',
    auth_scheme: 'Bearer',
    config_json: '{}',
    is_enabled: 1,
  });
  assert.equal(exposed.hasCredential, true);
  assert.equal(Object.prototype.hasOwnProperty.call(exposed, 'credential_enc'), false);

  await requireLocationGrant('key-1', 'location-1', 'allow_read', {
    query: async () => [[{ integration_count: 0, grant_count: 0 }]],
  }, { allowLegacyRead: true });
  await assert.rejects(
    requireLocationGrant('key-1', 'location-1', 'allow_read', {
      query: async () => [[{ integration_count: 1, grant_count: 0 }]],
    }, { allowLegacyRead: true }),
    (error) => error.status === 403
  );
  assert.equal(await requireLocationGrant('key-1', 'location-1', 'allow_read', {
    query: async () => [[{ integration_count: 1, grant_count: 1 }]],
  }), 'granted');

  let enrichmentQuery = 0;
  const enriched = await attachImportedData([{
    id: 'contact-1', locationId: 'location-1', serviceType: 'Roofing', status: 'uncontacted',
    contactData: JSON.stringify({
      firstName: 'Ada', lastName:'Lovelace', phone:'+1 555 0100', city:'Tampa', state:'FL',
      latitude:27.9506, longitude:-82.4572, id:'external-contact-id', email:'ada@example.com',
      address:'Secret street', tags:['private'], customFields:[{ id:'private', value:'private' }],
    }),
    assignedTo: null, lastContacted: null, dateAdded: '2026-07-11 12:00:00',
  }], { query: async () => { enrichmentQuery += 1; throw new Error('Dialer DTO must not read enrichment tables'); } });
  assert.equal(enriched[0].firstName, 'Ada');
  assert.equal(enriched[0].lastName, 'Lovelace');
  assert.equal(enriched[0].latitude, 27.9506);
  assert.equal(enriched[0].leadId, 'contact-1');
  assert.equal(enriched[0].contactId, null);
  assert.deepEqual(Object.keys(enriched[0]).sort(), [
    'city', 'contactId', 'firstName', 'lastName', 'latitude', 'leadId', 'longitude', 'phone', 'state',
  ]);
  assert.equal(enrichmentQuery, 0);

  const routePool = {
    query: async (sql) => {
      if (sql.includes('FROM api_operator_sessions s')) {
        return [[{
          apiKeyId:'key-1', userId:'user-1', locationId:'location-1', isAdmin:0,
          expiresAt:'2026-07-12 18:30:00.000', username:'agent', crmUserName:'Agent',
        }]];
      }
      if (sql.startsWith('UPDATE api_operator_sessions SET last_used_at')) return [{ affectedRows:1 }];
      if (sql.includes('COUNT(DISTINCT i.id)')) {
        if (sql.includes('allow_manage_leads')) {
          return [[{ integration_count: 1, grant_count: 1 }]];
        }
        return [[{ integration_count: 0, grant_count: 0 }]];
      }
      if (sql.includes('SELECT l.id')) {
        return [[{
          id: 'contact-1', locationId: 'location-1', serviceType: 'Roofing', status: 'uncontacted',
          contactData: JSON.stringify({ firstName:'Ada', email:'ada@example.com', address:'Secret street', tags:['private'] }), assignedTo: 'user-1',
          lastContacted: null, dateAdded: '2026-07-11 12:00:00',
        }]];
      }
      if (sql.includes('COUNT(*) AS total')) return [[{ total: 1 }]];
      if (sql.startsWith('SELECT id, locationId FROM leads')) {
        return [[{ id: 'contact-1', locationId: 'location-1' }]];
      }
      if (sql.includes('FROM lead_source_links sl')) {
        return sql.includes('SELECT sl.lead_id')
          ? [[{ lead_id:'contact-1', external_record_id: 'crm-contact-1' }]]
          : [[{ external_record_id: 'contact-1' }]];
      }
      if (sql.includes('INSERT INTO dnc_pulse_events')) return [{ affectedRows: 1 }];
      if (sql.includes('FROM lead_source_links')) return [[]];
      if (sql.includes('FROM lead_import_values')) return [[]];
      throw new Error(`Unexpected route query: ${sql}`);
    },
  };
  setPool(routePool);
  const routeApp = express();
  routeApp.use(express.json());
  routeApp.use((req, res, next) => { req.apiKey = { id: 'key-1' }; next(); });
  routeApp.use('/api/leads', createLeadManagementRouter());
  const routeServer = http.createServer(routeApp);
  await new Promise((resolve) => routeServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = routeServer.address();
    const operatorHeaders = { 'X-Operator-Token':'A'.repeat(43) };
    const anonymousResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/leads?locationId=location-1&limit=100`
    );
    assert.equal(anonymousResponse.status, 401);
    const anonymousBody = await anonymousResponse.json();
    assert.equal(anonymousBody.code, 'OPERATOR_SESSION_REQUIRED');
    assert.equal(anonymousBody.authentication.tokenPath, 'session.token');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/leads?locationId=location-1&limit=100`,
      { headers:operatorHeaders }
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.total, 1);
    assert.equal(body.leads[0].firstName, 'Ada');
    assert.equal(body.leads[0].leadId, 'contact-1');
    assert.equal(body.leads[0].contactId, 'crm-contact-1');
    assert.equal(body.leads[0].email, undefined);
    assert.equal(body.leads[0].address, undefined);
    assert.equal(body.leads[0].tags, undefined);
    assert.equal(body.leads[0].contactData, undefined);
    assert.equal(body.leads[0].importedValues, undefined);

    const assignedResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/leads/assigned?locationId=location-1&userId=user-1`,
      { headers:operatorHeaders }
    );
    assert.equal(assignedResponse.status, 200);
    const assignedBody = await assignedResponse.json();
    assert.equal(assignedBody.success, true);
    assert.equal(assignedBody.total, 1);
    assert.equal(assignedBody.leads[0].leadId, 'contact-1');
    assert.equal(assignedBody.leads[0].contactId, 'crm-contact-1');

    const invalidAssignedResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/leads/assigned?locationId=location-1`,
      { headers:operatorHeaders }
    );
    assert.equal(invalidAssignedResponse.status, 400);

    const pulseResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/leads/contact-1/dnc-pulse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: 'location-1',
          url: 'https://webapi.dncscrub.com/gohighlvl/contact-scrub.html?contactId=contact-1&locationId=location-1&t=test-token',
        }),
      }
    );
    const pulseBody = await pulseResponse.json();
    assert.equal(pulseResponse.status, 200, JSON.stringify(pulseBody));
    assert.equal(pulseBody.action, 'browser_navigation');
    assert.equal(new URL(pulseBody.url).searchParams.get('t'), 'test-token');
    assert.equal(pulseResponse.headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise((resolve) => routeServer.close(resolve));
    setPool(null);
  }

  process.env.SESSION_SECRET = 'crm-importer-test-secret';
  let requestSeen;
  const server = http.createServer((req, res) => {
    requestSeen = { url: req.url, authorization: req.headers.authorization };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ contacts: [{ id: 'contact-1', locationId: 'location-1' }], meta: { startAfterId: 'next-1' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const page = await fetchCrmPage({
      provider: 'leadconnector-pit',
      base_url: `http://127.0.0.1:${address.port}`,
      location_id: 'location-1',
      auth_scheme: 'Bearer',
      credential_enc: encryptSecret('upstream-token'),
      config_json: JSON.stringify({ contactsPath: '/contacts/', recordsPath: 'contacts' }),
    }, { limit: 250 });
    assert.equal(page.records[0].id, 'contact-1');
    assert.equal(page.nextCursor, null);
    assert.match(page.checkpointCursor, /contact-1/);
    assert.match(requestSeen.url, /locationId=location-1/);
    assert.match(requestSeen.url, /limit=100/);
    assert.equal(requestSeen.authorization, 'Bearer upstream-token');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const cursorsSeen = [];
  const exhaustiveServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    cursorsSeen.push({ id: url.searchParams.get('startAfterId'), time: url.searchParams.get('startAfter') });
    const page = cursorsSeen.length;
    const contacts = page <= 3
      ? [{ id: `contact-${page}`, locationId: 'location-1', dateAdded: `2026-07-0${page}T12:00:00Z` }]
      : [];
    const meta = page < 3
      ? { startAfterId: 'stale-meta-cursor', startAfter: Date.parse('2026-07-01T12:00:00Z') }
      : {};
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ contacts, count: 3, meta }));
  });
  await new Promise((resolve) => exhaustiveServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = exhaustiveServer.address();
    const walked = await walkCrmContacts({
      provider: 'leadconnector-pit',
      base_url: `http://127.0.0.1:${address.port}`,
      location_id: 'location-1',
      auth_scheme: 'Bearer',
      credential_enc: encryptSecret('upstream-token'),
      config_json: JSON.stringify({ contactsPath: '/contacts/', recordsPath: 'contacts' }),
    }, { pageSize: 1, pageDelayMs: 0 });
    assert.equal(walked.records, 3);
    assert.equal(walked.pages, 4);
    assert.equal(walked.expectedTotal, 3);
    assert.equal(walked.completionReason, 'empty_page');
    assert.deepEqual(cursorsSeen[1], {
      id: 'contact-1', time: String(Date.parse('2026-07-01T12:00:00Z')),
    });
    assert.deepEqual(cursorsSeen[2], {
      id: 'contact-2', time: String(Date.parse('2026-07-02T12:00:00Z')),
    });
    assert.match(walked.lastCursor, /contact-3/);
  } finally {
    await new Promise((resolve) => exhaustiveServer.close(resolve));
  }

  const searchBodies = [];
  const searchServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      searchBodies.push({ method: req.method, url: req.url, body });
      const contacts = body.page === 1
        ? [{ id: 'search-1' }, { id: 'search-2' }]
        : [{ id: 'search-3' }];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ contacts, total: 3 }));
    });
  });
  await new Promise((resolve) => searchServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = searchServer.address();
    const walked = await walkCrmContacts({
      provider: 'generic',
      base_url: `http://127.0.0.1:${address.port}`,
      location_id: 'location-1',
      auth_scheme: 'Bearer',
      credential_enc: encryptSecret('upstream-token'),
      config_json: JSON.stringify({
        useContactSearch: true, contactSearchPath: '/contacts/search', maxPageSize: 2,
      }),
    }, { pageSize: 2, pageDelayMs: 0 });
    assert.equal(walked.records, 3);
    assert.equal(walked.pages, 2);
    assert.equal(walked.expectedTotal, 3);
    assert.deepEqual(searchBodies.map((item) => item.body.page), [1, 2]);
    assert(searchBodies.every((item) => item.method === 'POST' && item.body.pageLimit === 2));
  } finally {
    await new Promise((resolve) => searchServer.close(resolve));
  }

  const cursorSearchBodies = [];
  const cursorSearchServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      cursorSearchBodies.push(body);
      const contacts = body.searchAfter
        ? [{ id: 'cursor-3', searchAfter: [1720000003000, 'cursor-3'] }]
        : [
          { id: 'cursor-1', searchAfter: [1720000001000, 'cursor-1'] },
          { id: 'cursor-2', searchAfter: [1720000002000, 'cursor-2'] },
        ];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ contacts, total: 3 }));
    });
  });
  await new Promise((resolve) => cursorSearchServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = cursorSearchServer.address();
    const walked = await walkCrmContacts({
      provider: 'generic',
      base_url: `http://127.0.0.1:${address.port}`,
      location_id: 'location-1',
      auth_scheme: 'Bearer',
      credential_enc: encryptSecret('upstream-token'),
      config_json: JSON.stringify({
        useContactSearch: true, contactSearchPath: '/contacts/search', maxPageSize: 2,
      }),
    }, {
      pageSize: 2,
      pageDelayMs: 0,
      updatedAfter: '2026-07-12T11:55:00.000Z',
      updatedBefore: '2026-07-13T12:00:00.000Z',
    });
    assert.equal(walked.records, 3);
    assert.equal(walked.pages, 2);
    assert.equal(cursorSearchBodies[0].page, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(cursorSearchBodies[1], 'page'), false);
    assert.deepEqual(cursorSearchBodies[1].searchAfter, [1720000002000, 'cursor-2']);
    assert.deepEqual(cursorSearchBodies[0].filters, [{
      field: 'dateUpdated',
      operator: 'range',
      value: { gte: '2026-07-12T11:55:00.000Z', lte: '2026-07-13T12:00:00.000Z' },
    }]);
    assert.deepEqual(cursorSearchBodies[0].sort, [{ field: 'dateUpdated', direction: 'asc' }]);
  } finally {
    await new Promise((resolve) => cursorSearchServer.close(resolve));
  }

  let insertedRun;
  const importRunPool = {
    query: async (sql, params) => {
      if (sql.includes("status IN ('queued', 'running')")) return [[]];
      if (sql.startsWith('INSERT INTO crm_import_runs')) {
        insertedRun = params;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected import-run query: ${sql}`);
    },
  };
  await createImportRun({
    id: 'integration-incremental',
    provider: 'generic',
    base_url: 'https://services.leadconnectorhq.com',
    location_id: 'location-1',
    last_cursor: '{"page":99}',
    last_sync_at: '2026-07-13 12:00:00',
    config_json: '{}',
  }, 'key-1', { full: false, pageSize: 100 }, importRunPool);
  const incrementalOptions = JSON.parse(insertedRun[7]);
  assert.equal(insertedRun[5], null, 'new sync windows must not reuse a completed run cursor');
  assert.equal(incrementalOptions.syncMode, 'incremental');
  assert.equal(incrementalOptions.updatedAfter, '2026-07-13T11:55:00.000Z');
  assert.match(incrementalOptions.updatedBefore, /^\d{4}-\d{2}-\d{2}T/);

  console.log('CRM importer tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
