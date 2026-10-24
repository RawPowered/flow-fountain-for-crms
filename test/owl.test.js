const assert = require('assert/strict');
const bcrypt = require('bcryptjs');
const { setPool } = require('../src/db/pool');
const { encryptSecret } = require('../src/services/secretBox');
const { DEFAULT_POOL_RULES, normalizeRule } = require('../src/services/leadPools');
const {
  CORE_TABLES,
  requireCapability,
  requireColumns,
  listPools,
  listDncScreening,
  scrubDncScreeningLead,
  fetchCrmTagRecords,
  listLeadSources,
  assignLeads,
  moveLeadsToPool,
  isCustomCrmIntegration,
  isLeadConnectorIntegration,
  getComplianceReport,
  buildLocationContexts,
  recordAudit,
  listUsers,
  changeUserPassword,
  updateUser,
  recheckServicePool,
} = require('../src/services/owl');

async function run() {
  assert.deepEqual(buildLocationContexts(['location-db','location-both'], ['location-api','location-both']), [
    { locationId:'location-api', databaseDiscovered:false, integrationGranted:true, authority:'api_integration' },
    { locationId:'location-both', databaseDiscovered:true, integrationGranted:true, authority:'api_integration' },
    { locationId:'location-db', databaseDiscovered:true, integrationGranted:false, authority:'database' },
  ]);
  const deniedContext = {
    sourceInfo: {
      tables: {
        leads: { select: true, update: false, allowedColumns: ['id', 'locationId'] },
      },
    },
  };
  assert.throws(() => requireCapability(deniedContext, 'leads', 'update'), (error) => error.status === 403);
  assert.throws(() => requireColumns(deniedContext, 'leads', ['id', 'status']), (error) => error.status === 403);
  assert.equal(isCustomCrmIntegration({ base_url: 'https://crm.example.invalid' }), true);

  const userListSql = [];
  const listedUsers = await listUsers({
    source:'core',
    corePool:{ query:async (sql) => {
      userListSql.push(sql);
      if (sql.includes('FROM owl_user_pool_permissions')) return [[]];
      return [[{ id:'legacy-1', locationId:'location-1', username:'legacy.agent', credentialScheme:'legacy' }]];
    } },
    sourceInfo:{ slug:'core', tables:CORE_TABLES },
  }, 'location-1');
  assert.equal(listedUsers[0].credentialScheme, 'legacy');
  assert.equal(Object.hasOwn(listedUsers[0], 'passwordHash'), false);
  assert.ok(userListSql.some((sql) => /END AS credentialScheme/.test(sql)));
  assert.equal(isCustomCrmIntegration({ base_url: 'https://crm-api.example.invalid/v1' }), true);
  assert.equal(isCustomCrmIntegration({ base_url: 'http://crm.example.invalid' }), false);
  assert.equal(isCustomCrmIntegration({ base_url: 'https://example.invalid.evil.example' }), false);
  assert.equal(isLeadConnectorIntegration({ base_url: 'https://services.leadconnectorhq.com' }), true);
  assert.equal(isLeadConnectorIntegration({ base_url: 'https://services.leadconnectorhq.com.evil.example' }), false);
  for (const required of ['dnc_pending', 'no_phone', 'dnc', 'not_interested', 'scheduled', 'closed_won', 'closed_lost', 'closed_dnq']) {
    assert.ok(DEFAULT_POOL_RULES.some((pool) => pool.poolKey === required));
  }
  assert.throws(() => normalizeRule('bad key', {}), (error) => error.status === 400);
  assert.throws(() => normalizeRule('dnc', {
    label: 'DNC', statusValues: ['dnc'], destinationStatus: 'dnc', isEnabled: false,
  }), (error) => error.status === 409);

  const poolQueries = [];
  const leadState = { id: 'lead-1', status: 'uncontacted', assignedTo: null, dncStatus: 'clean' };
  const fakePool = {
    query: async (sql, params) => {
      poolQueries.push({ sql, params });
      if (sql.includes('FROM crm_integrations i')) {
        return [[
          { id: 'integration-1', name: 'Nova', provider: 'custom-crm', location_id: 'location-1', base_url: 'https://crm.example.invalid', credential_enc: 'encrypted', auth_scheme: 'Bearer', config_json: '{}', is_enabled: 1 },
          { id: 'integration-pit', name: 'LeadConnector', provider: 'leadconnector-pit', location_id: 'location-1', base_url: 'https://services.leadconnectorhq.com', credential_enc: 'encrypted', auth_scheme: 'Bearer', config_json: '{}', is_enabled: 1 },
          { id: 'integration-2', name: 'Other', provider: 'generic', location_id: 'location-1', base_url: 'https://crm.example.com', credential_enc: 'encrypted', auth_scheme: 'Bearer', config_json: '{}', is_enabled: 1 },
        ]];
      }
      if (sql.includes('FROM lead_source_links sl')) {
        return [[{
          external_record_id: 'contact-pending', id: 'integration-pit', name: 'LeadConnector',
          provider: 'leadconnector-pit', location_id: 'location-1',
          base_url: 'https://services.leadconnectorhq.com', auth_scheme: 'Bearer',
          credential_enc: encryptSecret('pit-test-token'), config_json: '{}', is_enabled: 1,
        }]];
      }
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows: 1 }];
      if (sql.includes('FROM owl_lead_pool_rules WHERE')) {
        return [DEFAULT_POOL_RULES.map((item, index) => ({
          id: `pool-${index}`, source_slug: 'core', location_id: 'location-1',
          pool_key: item.poolKey, label: item.label,
          status_values_json: JSON.stringify(item.statusValues),
          destination_status: item.destinationStatus, assignment_policy: item.assignmentPolicy,
          is_assignable: item.isAssignable ? 1 : 0, is_terminal: item.isTerminal ? 1 : 0,
          color: item.color, sort_order: item.sortOrder, is_enabled: 1,
        }))];
      }
      if (sql.includes('GROUP BY serviceType')) {
        return [[{ serviceType: 'Roofing', status: 'uncontacted', total: '4', assigned: '1', available: '3', newestLead: '2026-07-11 12:00:00' }]];
      }
      if (sql.includes('dncStatus IN (?,?)') && sql.includes('SELECT id, serviceType, contactData')) {
        return [[{
          id: 'lead-pending', locationId: 'location-1', serviceType: 'Roofing',
          status: 'dnc_pending', contactData: '{"firstName":"Pending"}', assignedTo: null,
          dncStatus: 'pending', dncCheckedAt: null, dateAdded: '2026-07-11 12:00:00',
        }]];
      }
      if (sql.includes('COUNT(*) AS total') && sql.includes('SUM(dncStatus')) {
        return [[{ total:'1', pending:'1', review:'0', releasable:'0' }]];
      }
      if (sql.includes('SELECT id, locationId, status, dncStatus FROM leads')) {
        return [[{ id: 'lead-pending', locationId: 'location-1', status: 'dnc_pending', dncStatus: 'pending' }]];
      }
      if (sql.includes('FROM users WHERE id = ?')) return [[{ id: 'user-1', username: 'agent' }]];
      if (sql.startsWith('SELECT id, status, assignedTo')) {
        return [[{ ...leadState }]];
      }
      if (sql.startsWith('UPDATE leads SET assignedTo')) {
        leadState.assignedTo = params[0]; leadState.status = params[1]; return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE leads SET status = ?, assignedTo = NULL')) {
        leadState.status = params[0]; leadState.assignedTo = null; return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO owl_audit_events')) return [{ affectedRows: 1 }];
      if (sql.startsWith('INSERT INTO dnc_pulse_events')) return [{ affectedRows: 1 }];
      if (sql.includes('COUNT(*) AS screened') && sql.includes('FROM lead_compliance_checks')) {
        return [[{ screened:'2', allowed:'1', blocked:'1', blockedLeads:'1' }]];
      }
      if (sql.includes('SUM(source=\'dialer\') AS authorizedAttempts')) return [[{ attempts:'3', authorizedAttempts:'2', confirmedAttempts:'1', attributedConfirmedAttempts:'1' }]];
      if (sql.includes('GROUP BY reason')) return [[{ reason:'outside_marketing_hours', total:'1' }]];
      if (sql.includes('FROM lead_compliance_checks c')) {
        assert.ok(!sql.includes(' AS localTime'));
        assert.ok(sql.includes(' AS leadLocalTime'));
        return [[{ id:'check-1', leadId:'lead-1', leadLocalTime:'2026-07-11 18:30:00', attempts24h:'0', decision:'blocked', reason:'outside_marketing_hours', contactData:'{}' }]];
      }
      if (sql.includes('FROM lead_call_attempts a')) return [[{
        leadId:'lead-1', userId:'user-1', occurredAt:'2026-07-11 18:31:00',
        externalUserId:'crm-user-1',
        callStatus:'completed', source:'crm', syncedAt:'2026-07-11 18:32:00',
        serviceType:'Roofing', contactData:'{"firstName":"Ada"}', username:'agent',
      }]];
      throw new Error(`Unexpected OWL query: ${sql}`);
    },
  };
  const context = {
    apiKeyId: 'key-1',
    source: 'core',
    sourceInfo: { slug: 'core', tables: CORE_TABLES },
    corePool: fakePool,
  };

  const pools = await listPools(context, 'location-1');
  assert.deepEqual(pools[0], {
    serviceType: 'Roofing', status: 'uncontacted', total: 4, assigned: 1,
    available: 3, newestLead: '2026-07-11 12:00:00',
  });

  const sources = await listLeadSources(context, 'location-1');
  assert.equal(sources.length, 2);
  assert.equal(sources[0].id, 'integration-1');
  assert.equal(sources[0].ready, true);
  assert.equal(Object.prototype.hasOwnProperty.call(sources[0], 'credential_enc'), false);

  const screening = await listDncScreening(context, { locationId: 'location-1', limit: 25 });
  assert.equal(screening.total, 1);
  assert.deepEqual(screening.counts, { pending:1, review:0, releasable:0 });
  assert.equal(screening.rows[0].contactName, 'Pending');
  assert.equal(Object.hasOwn(screening.rows[0], 'contactData'), false);
  assert.equal(screening.nextOffset, null);
  assert.ok(poolQueries.some((entry) => entry.sql.includes('dncStatus IN (?,?)')));
  await assert.rejects(
    () => listDncScreening({ ...context, source: 'secondary' }, { locationId: 'location-1' }),
    (error) => error.status === 409
  );

  const dncWrites = [];
  const dncConnection = {
    beginTransaction: async () => dncWrites.push({ sql:'BEGIN', params:[] }),
    commit: async () => dncWrites.push({ sql:'COMMIT', params:[] }),
    rollback: async () => dncWrites.push({ sql:'ROLLBACK', params:[] }),
    release: () => {},
    query: async (sql, params) => {
      dncWrites.push({ sql, params });
      if (sql.startsWith('UPDATE leads SET dncStatus')) return [{ affectedRows:1 }];
      if (sql.startsWith('UPDATE leads SET status')) return [{ affectedRows:1 }];
      if (sql.startsWith('INSERT INTO dnc_pulse_events')) return [{ affectedRows:1 }];
      throw new Error(`Unexpected DNC transaction query: ${sql}`);
    },
  };
  const dncPool = {
    getConnection: async () => dncConnection,
    query: async (sql) => {
      if (sql.includes('SELECT id, locationId, status, dncStatus FROM leads')) {
        return [[{ id:'lead-api', locationId:'location-1', status:'dnc_pending', dncStatus:'pending' }]];
      }
      if (sql.includes('SELECT id, contactData, dncStatus, dncCheckedAt')) {
        return [[{ id:'lead-api', contactData:JSON.stringify({ phone:'+1 (312) 555-0100' }), dncStatus:'pending' }]];
      }
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows:1 }];
      if (sql.includes('FROM owl_lead_pool_rules WHERE')) {
        return [DEFAULT_POOL_RULES.map((item, index) => ({
          id:`dnc-pool-${index}`, source_slug:'core', location_id:'location-1',
          pool_key:item.poolKey, label:item.label,
          status_values_json:JSON.stringify(item.statusValues), destination_status:item.destinationStatus,
          assignment_policy:item.assignmentPolicy, is_assignable:item.isAssignable ? 1 : 0,
          is_terminal:item.isTerminal ? 1 : 0, color:item.color, sort_order:item.sortOrder, is_enabled:1,
        }))];
      }
      if (sql.includes('FROM lead_source_links')) {
        return [[{ lead_id:'lead-api', external_record_id:'contact-api' }]];
      }
      throw new Error(`Unexpected DNC pool query: ${sql}`);
    },
  };
  const previousDncKey = process.env.DNC_SCRUB_KEY;
  const previousDncRetries = process.env.DNC_SCRUB_MAX_RETRIES;
  const dncFetch = global.fetch;
  let dncRequest;
  process.env.DNC_SCRUB_KEY = 'server-only-test-key';
  process.env.DNC_SCRUB_MAX_RETRIES = '0';
  global.fetch = async (url, options) => {
    dncRequest = { url:String(url), options };
    return new Response(JSON.stringify([
      { Phone:'3125550100', ResultCode:'B', Reason:'Configured no-call area code', LineType:'Wireless' },
    ]), { status:200, headers:{ 'Content-Type':'application/json' } });
  };
  try {
    const result = await scrubDncScreeningLead({ ...context, corePool:dncPool }, {
      locationId:'location-1', leadId:'lead-api',
    });
    assert.equal(result.dncStatus, 'review');
    assert.equal(result.source, 'dncscrub_api');
    assert.equal(result.decisionCategory, 'configuration_or_coverage');
    assert.equal(result.reviewRequired, true);
    assert.equal(result.reason, 'Configured no-call area code');
    assert.equal(dncRequest.options.headers.loginId, 'server-only-test-key');
    assert.equal(JSON.parse(dncRequest.options.body).phoneList, '3125550100');
    const stateWrite = dncWrites.find((entry) => entry.sql.startsWith('UPDATE leads SET dncStatus'));
    assert.equal(stateWrite.params[0], 'review');
    assert.equal(stateWrite.params[2], 'dncscrub_api');
    assert.equal(stateWrite.params[3], 'B');
    assert.equal(stateWrite.params[5], 'configuration_or_coverage');
    assert.equal(stateWrite.params[6], 1);
    assert.ok(dncWrites.some((entry) => entry.sql.startsWith('INSERT INTO dnc_pulse_events')));
    assert.doesNotMatch(JSON.stringify(dncWrites), /server-only-test-key|3125550100/);
  } finally {
    global.fetch = dncFetch;
    if (previousDncKey === undefined) delete process.env.DNC_SCRUB_KEY;
    else process.env.DNC_SCRUB_KEY = previousDncKey;
    if (previousDncRetries === undefined) delete process.env.DNC_SCRUB_MAX_RETRIES;
    else process.env.DNC_SCRUB_MAX_RETRIES = previousDncRetries;
  }

  process.env.SESSION_SECRET = 'owl-dnc-test-secret';
  const originalFetch = global.fetch;
  let tagRequest;
  global.fetch = async (url, options) => {
    tagRequest = { url: String(url), options };
    return new Response(JSON.stringify({
      contacts: [{ id: 'contact-pending', locationId: 'location-1', tags: ['dnc-clean'] }],
      total: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const records = await fetchCrmTagRecords({
      id: 'integration-pit', provider: 'leadconnector-pit', location_id: 'location-1',
      base_url: 'https://services.leadconnectorhq.com', auth_scheme: 'Bearer',
      credential_enc: encryptSecret('pit-test-token'), config_json: '{}',
    }, [{ leadId: 'lead-pending', externalId: 'contact-pending' }]);
    assert.deepEqual(records.get('lead-pending').tags, ['dnc-clean']);
    assert.ok(tagRequest.url.includes('/contacts/search'));
    assert.equal(tagRequest.options.method, 'POST');
    assert.equal(JSON.parse(tagRequest.options.body).locationId, 'location-1');
    assert.equal(tagRequest.options.headers.Authorization, 'Bearer pit-test-token');
  } finally {
    global.fetch = originalFetch;
  }

  const assignment = await assignLeads(context, {
    locationId: 'location-1', userId: 'user-1', leadIds: ['lead-1'],
  }, true);
  assert.equal(assignment.affected, 1);
  assert.equal(assignment.after[0].assignedTo, 'user-1');

  const dncMove = await moveLeadsToPool(context, {
    locationId: 'location-1', poolKey: 'dnc', leadIds: ['lead-1'],
  });
  assert.equal(dncMove.after[0].status, 'do_not_call');
  assert.equal(dncMove.after[0].assignedTo, null);

  const compliance = await getComplianceReport(context, 'location-1');
  assert.equal(compliance.summary.blocked, 1);
  assert.equal(compliance.summary.confirmedAttempts, 1);
  assert.equal(compliance.summary.attributedConfirmedAttempts, 1);
  assert.equal(compliance.attempts[0].leadName, 'Ada');
  assert.equal(compliance.checks[0].localTime, '2026-07-11 18:30:00');
  assert.equal(Object.prototype.hasOwnProperty.call(compliance.checks[0], 'leadLocalTime'), false);

  setPool(fakePool);
  await recordAudit({
    admin: { id: 'admin-1', username: 'root' }, context, locationId: 'location-1',
    action: 'leads.assign', entityType: 'lead_batch', entityId: 'user-1',
    before: assignment.before, after: assignment.after, detail: '1 lead assigned',
  });
  assert.ok(poolQueries.some((entry) => entry.sql.includes('INSERT INTO owl_audit_events')));
  setPool(null);

  const credentialQueries = [];
  let storedPasswordHash = null;
  const credentialPool = {
    async query(sql, params) {
      credentialQueries.push({ sql, params });
      if (sql.includes('SELECT id, locationId, username FROM users')) {
        return [[{ id:'user-credential', locationId:'location-1', username:'secure.agent' }]];
      }
      if (sql.includes('SELECT passwordHash FROM users')) {
        return [[{ passwordHash:storedPasswordHash }]];
      }
      if (sql.startsWith('UPDATE users SET passwordHash')) {
        storedPasswordHash = params[0];
        return [{ affectedRows:1 }];
      }
      if (sql.startsWith('UPDATE api_operator_sessions SET revoked_at')) return [{ affectedRows:2 }];
      throw new Error(`Unexpected credential query: ${sql}`);
    },
  };
  const credentialContext = {
    apiKeyId:'key-1', source:'core', corePool:credentialPool,
    sourceInfo:{ slug:'core', tables:CORE_TABLES },
  };
  const newPassword = 'StrongCredential9';
  const passwordResult = await changeUserPassword(
    credentialContext,
    'user-credential',
    { locationId:'location-1', password:newPassword }
  );
  assert.equal(await bcrypt.compare(newPassword, storedPasswordHash), true);
  assert.notEqual(storedPasswordHash, newPassword);
  assert.equal(passwordResult.credentialVerified, true);
  assert.equal(passwordResult.sessionsRevoked, 2);
  assert.doesNotMatch(JSON.stringify(passwordResult), /StrongCredential9|passwordHash/);
  assert.deepEqual(
    credentialQueries.find((entry) => entry.sql.startsWith('UPDATE api_operator_sessions')).params,
    ['user-credential', 'location-1']
  );
  await assert.rejects(
    () => updateUser(credentialContext, 'user-credential', {
      locationId:'location-1', password:'AnotherStrong9',
    }),
    (error) => error.status === 400 && /dedicated password change/.test(error.message)
  );

  const recheckLeads = [
    { id:'lead-1', serviceType:'Roofing', contactData:'{}' },
    { id:'lead-2', serviceType:'Roofing', contactData:'{}' },
  ];
  const recheckPool = {
    async query(sql, params) {
      if (sql.includes('FROM leads') && sql.includes('serviceType')) {
        const after = sql.includes('id>?') ? params[2] : '';
        const limit = Number(params.at(-1));
        return [recheckLeads.filter((lead) => lead.id > after).slice(0, limit)];
      }
      if (sql.includes('FROM lead_source_links')) {
        const leadId = params[1];
        return [[{ leadId, contactId:`contact-${leadId}`, lastSeenAt:'2026-07-15' }]];
      }
      if (sql.includes('FROM crm_integrations i')) return [[{
        id:'integration-recheck', provider:'leadconnector-pit', location_id:'location-1',
        base_url:'https://services.leadconnectorhq.com', credential_enc:encryptSecret('recheck-token'),
        config_json:'{}', is_enabled:1,
      }]];
      throw new Error(`Unexpected recheck query: ${sql}`);
    },
  };
  const recheckContext = {
    apiKeyId:'key-1', source:'core', corePool:recheckPool,
    sourceInfo:{ slug:'core', tables:CORE_TABLES },
  };
  const fetchRecheck = async (url) => new Response(JSON.stringify({ contact:{ id:url.split('/').pop(), tags:[] } }), {
    status:200, headers:{ 'content-type':'application/json' },
  });
  const firstRecheckPage = await recheckServicePool(recheckContext, {
    locationId:'location-1', serviceType:'Roofing', dryRun:true, limit:1,
  }, fetchRecheck);
  assert.equal(firstRecheckPage.nextCursor, 'lead-1');
  assert.equal(firstRecheckPage.hasMore, true);
  assert.equal(firstRecheckPage.candidates, 1);
  const secondRecheckPage = await recheckServicePool(recheckContext, {
    locationId:'location-1', serviceType:'Roofing', dryRun:true, limit:1, afterLeadId:firstRecheckPage.nextCursor,
  }, fetchRecheck);
  assert.equal(secondRecheckPage.nextCursor, 'lead-2');
  assert.equal(secondRecheckPage.candidates, 1);

  console.log('OWL tests passed');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
