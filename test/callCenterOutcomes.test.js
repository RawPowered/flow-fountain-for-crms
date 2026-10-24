const assert = require('assert/strict');
const {
  mapOutcomeToPoolKey,
  isTerminalSkipTag,
  terminalSkipReason,
  canonicalizeTag,
  applyCallCenterOutcome,
  OUTCOME_TO_POOL,
} = require('../src/services/callCenterOutcomes');

async function run() {
  assert.equal(mapOutcomeToPoolKey('not_interested'), 'not_interested');
  assert.equal(mapOutcomeToPoolKey('NOT-INTERESTED'), 'not_interested');
  assert.equal(mapOutcomeToPoolKey('cc-not-interested'), 'not_interested');
  assert.equal(mapOutcomeToPoolKey('dnc'), 'dnc');
  assert.equal(mapOutcomeToPoolKey('cc-dnc'), 'dnc');
  assert.equal(mapOutcomeToPoolKey('scheduled'), 'scheduled');
  assert.equal(mapOutcomeToPoolKey('requested_appointment'), 'scheduled');
  assert.equal(mapOutcomeToPoolKey('Requested Appointment'), 'scheduled');
  assert.equal(mapOutcomeToPoolKey('cc-scheduled'), 'scheduled');
  assert.equal(mapOutcomeToPoolKey('invalid'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('incorrect_number'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('Incorrect Number'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('wrong_number'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('Wrong Number'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('no_longer_at_address'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('No Longer At Address'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('cc-invalid'), 'invalid');
  assert.equal(mapOutcomeToPoolKey('closed_won'), 'closed_won');
  assert.equal(mapOutcomeToPoolKey('closed_lost'), 'closed_lost');
  assert.equal(mapOutcomeToPoolKey('closed_dnq'), 'closed_dnq');
  assert.equal(mapOutcomeToPoolKey('cc-converted-sale'), 'closed_won');
  assert.equal(mapOutcomeToPoolKey('no_answer'), null);
  assert.equal(mapOutcomeToPoolKey('voicemail'), null);
  assert.equal(mapOutcomeToPoolKey('follow_up'), null);
  assert.ok(Object.values(OUTCOME_TO_POOL).includes('invalid'));

  assert.equal(isTerminalSkipTag('cc-dnc'), true);
  assert.equal(isTerminalSkipTag('cc-not-interested'), true);
  assert.equal(isTerminalSkipTag('cc-scheduled'), true);
  assert.equal(isTerminalSkipTag('cc-invalid'), true);
  assert.equal(isTerminalSkipTag('wrong_number'), true);
  assert.equal(isTerminalSkipTag('incorrect_number'), true);
  assert.equal(isTerminalSkipTag('cc-converted-sale'), true);
  assert.equal(isTerminalSkipTag('cc-closed-won'), true);
  assert.equal(isTerminalSkipTag('closed_won'), true);
  assert.equal(isTerminalSkipTag('cc-won'), true);
  assert.equal(isTerminalSkipTag('cc-closed-lost'), true);
  assert.equal(isTerminalSkipTag('cc-dnq'), true);
  assert.equal(isTerminalSkipTag('DNQ'), true);
  assert.equal(isTerminalSkipTag('cc-pool-roofing'), false);
  assert.equal(isTerminalSkipTag('hawk-dialer-ready'), false);

  assert.equal(terminalSkipReason('cc-dnc'), 'dnc');
  assert.equal(terminalSkipReason('cc-not-interested'), 'not_interested');
  assert.equal(terminalSkipReason('cc-scheduled'), 'scheduled');
  assert.equal(terminalSkipReason('cc-invalid'), 'invalid');
  assert.equal(terminalSkipReason('cc-closed-won'), 'converted_sale');
  assert.equal(terminalSkipReason('cc-closed-lost'), 'closed_lost');
  assert.equal(terminalSkipReason('cc-dnq'), 'dnq');
  assert.equal(terminalSkipReason('cc-pool-mold'), null);
  assert.equal(canonicalizeTag('Closed Won'), 'cc-closed-won');
  assert.equal(canonicalizeTag('Wrong Number'), 'cc-invalid');

  const rules = {
    not_interested: {
      id: 'r-ni', source_slug: 'core', location_id: 'loc-1', pool_key: 'not_interested',
      label: 'Not Interested', status_values_json: '["not_interested"]',
      destination_status: 'not_interested', assignment_policy: 'clear',
      is_assignable: 0, is_terminal: 1, color: '#f97316', sort_order: 60, is_enabled: 1,
    },
    dnc: {
      id: 'r-dnc', source_slug: 'core', location_id: 'loc-1', pool_key: 'dnc',
      label: 'DNC', status_values_json: '["do_not_call","dnc"]',
      destination_status: 'do_not_call', assignment_policy: 'clear',
      is_assignable: 0, is_terminal: 1, color: '#ef4444', sort_order: 50, is_enabled: 1,
    },
    scheduled: {
      id: 'r-sch', source_slug: 'core', location_id: 'loc-1', pool_key: 'scheduled',
      label: 'Scheduled', status_values_json: '["appointment","scheduled"]',
      destination_status: 'appointment', assignment_policy: 'preserve',
      is_assignable: 0, is_terminal: 0, color: '#06b6d4', sort_order: 40, is_enabled: 1,
    },
    invalid: {
      id: 'r-inv', source_slug: 'core', location_id: 'loc-1', pool_key: 'invalid',
      label: 'Invalid', status_values_json: '["invalid"]',
      destination_status: 'invalid', assignment_policy: 'clear',
      is_assignable: 0, is_terminal: 1, color: '#ec4899', sort_order: 100, is_enabled: 1,
    },
  };

  let lead = {
    id: 'lead-1',
    locationId: 'loc-1',
    serviceType: 'Roofing',
    status: 'assigned',
    contactData: '{}',
    assignedTo: 'user-1',
    dncStatus: 'clean',
    phoneMarketingStatus: 'available',
  };
  const updates = [];
  const pool = {
    query: async (sql, params) => {
      if (sql.startsWith('INSERT IGNORE INTO owl_lead_pool_rules')) return [{ affectedRows: 0 }];
      if (sql.includes('FROM owl_lead_pool_rules')) {
        return [Object.values(rules)];
      }
      if (sql.includes('SELECT lead_id FROM lead_source_links')) {
        return [[{ lead_id: 'lead-1' }]];
      }
      if (sql.includes('SELECT id, locationId, status, assignedTo, dncStatus')
        || sql.includes('SELECT id,locationId,status,assignedTo,dncStatus')) {
        return [[{
          id: lead.id,
          locationId: lead.locationId,
          status: lead.status,
          assignedTo: lead.assignedTo,
          dncStatus: lead.dncStatus,
        }]];
      }
      if (sql.startsWith('UPDATE leads SET status')) {
        updates.push({ sql, params });
        lead = {
          ...lead,
          status: params[0],
          assignedTo: sql.includes('assignedTo = NULL') ? null : lead.assignedTo,
        };
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const ni = await applyCallCenterOutcome(pool, {
    locationId: 'loc-1', contactId: 'contact-1', outcome: 'not_interested',
  });
  assert.equal(ni.changed, true);
  assert.equal(ni.afterStatus, 'not_interested');
  assert.equal(ni.afterAssignedTo, null);
  assert.equal(ni.poolKey, 'not_interested');
  assert.ok(updates.some((u) => u.sql.includes('assignedTo = NULL')));

  // idempotent
  const ni2 = await applyCallCenterOutcome(pool, {
    locationId: 'loc-1', contactId: 'contact-1', outcome: 'not_interested',
  });
  assert.equal(ni2.changed, false);

  lead = {
    id: 'lead-1', locationId: 'loc-1', serviceType: 'Roofing', status: 'assigned',
    contactData: '{}', assignedTo: 'user-1', dncStatus: 'clean', phoneMarketingStatus: 'available',
  };
  updates.length = 0;
  const dnc = await applyCallCenterOutcome(pool, {
    locationId: 'loc-1', contactId: 'contact-1', outcome: 'dnc',
  });
  assert.equal(dnc.afterStatus, 'do_not_call');
  assert.equal(dnc.afterAssignedTo, null);

  lead = {
    id: 'lead-1', locationId: 'loc-1', serviceType: 'Roofing', status: 'assigned',
    contactData: '{}', assignedTo: 'user-1', dncStatus: 'clean', phoneMarketingStatus: 'available',
  };
  updates.length = 0;
  const sch = await applyCallCenterOutcome(pool, {
    locationId: 'loc-1', contactId: 'contact-1', outcome: 'requested_appointment',
  });
  assert.equal(sch.afterStatus, 'appointment');
  assert.equal(sch.afterAssignedTo, 'user-1');
  assert.equal(sch.assignmentPolicy, 'preserve');
  assert.ok(updates.some((u) => !u.sql.includes('assignedTo')));

  lead = {
    id: 'lead-1', locationId: 'loc-1', serviceType: 'Roofing', status: 'assigned',
    contactData: '{}', assignedTo: 'user-1', dncStatus: 'clean', phoneMarketingStatus: 'available',
  };
  updates.length = 0;
  const inv = await applyCallCenterOutcome(pool, {
    locationId: 'loc-1', contactId: 'contact-1', outcome: 'incorrect_number',
  });
  assert.equal(inv.poolKey, 'invalid');
  assert.equal(inv.afterStatus, 'invalid');
  assert.equal(inv.afterAssignedTo, null);

  lead = {
    id: 'lead-1', locationId: 'loc-1', serviceType: 'Roofing', status: 'assigned',
    contactData: '{}', assignedTo: 'user-2', dncStatus: 'clean', phoneMarketingStatus: 'available',
  };
  const inv2 = await applyCallCenterOutcome(pool, {
    locationId: 'loc-1', contactId: 'contact-1', outcome: 'wrong_number',
  });
  assert.equal(inv2.afterStatus, 'invalid');

  lead = {
    id: 'lead-1', locationId: 'loc-1', serviceType: 'Roofing', status: 'assigned',
    contactData: '{}', assignedTo: 'user-3', dncStatus: 'clean', phoneMarketingStatus: 'available',
  };
  const inv3 = await applyCallCenterOutcome(pool, {
    locationId: 'loc-1', contactId: 'contact-1', outcome: 'no_longer_at_address',
  });
  assert.equal(inv3.afterStatus, 'invalid');

  await assert.rejects(
    () => applyCallCenterOutcome(pool, {
      locationId: 'loc-1', contactId: 'contact-1', outcome: 'closed_won',
    }),
    (err) => err.code === 'POOL_NOT_FOUND' || /pool/i.test(err.message)
  );

  await assert.rejects(
    () => applyCallCenterOutcome(pool, {
      locationId: 'loc-1', contactId: '', outcome: 'dnc',
    }),
    (err) => err.code === 'CONTACT_ID_REQUIRED'
  );

  console.log('callCenterOutcomes.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
