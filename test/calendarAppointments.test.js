const assert = require('assert');
const { encryptSecret } = require('../src/services/secretBox');
const {
  CALENDAR_VERSION,
  eventDate,
  isActiveCalendarEvent,
  calendarRequestUrl,
  fetchCalendarEvents,
  bookingContext,
  createScheduledCallRelease,
} = require('../src/services/calendarAppointments');

async function run() {
  const now = new Date('2026-07-13T16:00:00.000Z');
  assert.equal(eventDate('2026-07-13 16:30:00').toISOString(), '2026-07-13T16:30:00.000Z');
  assert.equal(isActiveCalendarEvent({
    contactId:'contact-1', appointmentStatus:'confirmed', startTime:'2026-07-14T15:00:00Z',
  }, 'contact-1', now), true);
  assert.equal(isActiveCalendarEvent({
    contactId:'contact-1', appointmentStatus:'cancelled', startTime:'2026-07-14T15:00:00Z',
  }, 'contact-1', now), false);
  assert.equal(isActiveCalendarEvent({
    contactId:'contact-1', appointmentStatus:'confirmed', startTime:'2026-07-12T15:00:00Z',
  }, 'contact-1', now), false);
  assert.equal(isActiveCalendarEvent({
    contactId:'contact-2', appointmentStatus:'confirmed', startTime:'2026-07-14T15:00:00Z',
  }, 'contact-1', now), false);

  const integration = {
    id:'integration-1', provider:'leadconnector-pit', location_id:'location-1',
    base_url:'https://services.leadconnectorhq.com', auth_scheme:'Bearer',
    config_json:'{}', credential_enc:encryptSecret('private-token'),
  };
  const url = calendarRequestUrl(integration, 'calendar-1', now);
  assert.equal(url.origin, 'https://services.leadconnectorhq.com');
  assert.equal(url.pathname, '/calendars/events');
  assert.equal(url.searchParams.get('locationId'), 'location-1');
  assert.equal(url.searchParams.get('calendarId'), 'calendar-1');
  assert.ok(Number(url.searchParams.get('startTime')) < now.getTime());
  assert.ok(Number(url.searchParams.get('endTime')) > now.getTime());

  let observedHeaders;
  const events = await fetchCalendarEvents(integration, 'calendar-1', now, async (_url, options) => {
    observedHeaders = options.headers;
    return response(200, JSON.stringify({ events:[{ id:'event-1', contactId:'contact-1' }] }));
  });
  assert.equal(events[0].id, 'event-1');
  assert.equal(observedHeaders.Authorization, 'Bearer private-token');
  assert.equal(observedHeaders.Version, CALENDAR_VERSION);

  let attempts = 0;
  const retriedEvents = await fetchCalendarEvents(integration, 'calendar-1', now, async () => {
    attempts += 1;
    return attempts < 3
      ? response(429, '{}', { 'retry-after':'1' })
      : response(200, JSON.stringify({ events:[{ id:'event-after-retry' }] }));
  }, async () => {});
  assert.equal(attempts, 3);
  assert.equal(retriedEvents[0].id, 'event-after-retry');

  await assert.rejects(
    fetchCalendarEvents(integration, 'calendar-1', now,
      async () => response(429, '{}', { 'retry-after':'45' }), async () => {}),
    (error) => error.code === 'CALENDAR_RATE_LIMITED'
      && error.compliance.nextEligibleAt === '2026-07-13T16:00:45.000Z'
  );
  await assert.rejects(
    fetchCalendarEvents(integration, 'calendar-1', now, async () => { throw new Error('socket timeout'); }),
    (error) => error.status === 503 && error.code === 'CALENDAR_VERIFICATION_UNAVAILABLE'
  );

  const bookingPool = {
    query:async (sql) => {
      if (sql.includes('FROM lead_source_links sl')) return [[{ lead_id:'lead-1', external_record_id:'contact-1' }]];
      if (sql.startsWith('SELECT id,locationId,serviceType')) return [[{
        id:'lead-1', locationId:'location-1', serviceType:'Roofing', assignedTo:'user-1',
        contactData:JSON.stringify({ firstName:'Ada', phone:'+15555550100' }),
      }]];
      if (sql.includes('FROM crm_contact_records')) return [[{
        payload_json:JSON.stringify({ lastName:'Lovelace', email:'ada@example.com' }),
      }]];
      if (sql.includes('FROM owl_service_pools')) return [[{
        calendar_ids_json:JSON.stringify(['calendar-1','calendar-2']), default_calendar_id:'calendar-1',
      }]];
      throw new Error(`Unexpected booking query: ${sql}`);
    },
  };
  const context = await bookingContext(bookingPool, {
    apiKeyId:'key-1', locationId:'location-1', contactId:'contact-1', userId:'user-1',
  });
  assert.equal(context.fields.name, 'Ada Lovelace');
  assert.equal(context.fields.email, 'ada@example.com');
  assert.equal(context.defaultCalendarId, 'calendar-1');
  assert.deepEqual(context.calendarIds, ['calendar-1','calendar-2']);

  const releaseQueries = [];
  const releasePool = { query:async (sql, params) => {
    releaseQueries.push({ sql, params });
    if (sql.startsWith('SELECT id FROM leads')) return [[{ id:'lead-1' }]];
    if (sql.startsWith('SELECT id FROM appointments')) return [[{ id:42 }]];
    if (sql.startsWith('INSERT INTO lead_call_restriction_overrides')) return [{ affectedRows:1 }];
    throw new Error(`Unexpected release query: ${sql}`);
  } };
  const release = await createScheduledCallRelease(releasePool, {
    locationId:'location-1', leadId:'lead-1', reason:'Troubleshoot calendar issue', minutes:30, uses:1,
    adminId:'admin-1', adminUsername:'root',
  });
  assert.equal(release.remainingUses, 1);
  assert.ok(releaseQueries.some((item) => item.sql.includes('lead_call_restriction_overrides')));
  await assert.rejects(createScheduledCallRelease(releasePool, {
    locationId:'location-1', leadId:'lead-1', reason:'short',
  }), /at least 10 characters/);

  console.log('Calendar appointment tests passed');
}

function response(status, body, extraHeaders = {}) {
  const headers = new Map(Object.entries({ 'content-length':String(Buffer.byteLength(body)), ...extraHeaders }));
  return {
    status, ok:status >= 200 && status < 300,
    headers:{ get:(key) => headers.get(String(key).toLowerCase()) || null },
    text:async () => body,
  };
}

run().catch((error) => { console.error(error); process.exit(1); });
