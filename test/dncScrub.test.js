const assert = require('assert/strict');
const {
  DNC_SCRUB_ENDPOINT,
  getDncScrubConfig,
  normalizePhone,
  extractPhone,
  extractPhoneCandidates,
  classifyDncScrubResult,
  scrubPhoneNumbers,
  sanitizeProviderText,
  resetDncRateLimiter,
} = require('../src/services/dncScrub');

async function run() {
  const defaults = getDncScrubConfig({ DNC_SCRUB_KEY:'namecheap-key' });
  assert.equal(defaults.apiKey, 'namecheap-key');
  assert.equal(defaults.batchSize, 50);
  assert.equal(defaults.requestsPerMinute, 30);
  const clampedLegacyTuning = getDncScrubConfig({
    DNC_SCRUB_KEY:'key', DNC_SCRUB_BATCH_SIZE:'500', DNC_SCRUB_REQUESTS_PER_MINUTE:'90',
  });
  assert.equal(clampedLegacyTuning.batchSize, 50);
  assert.equal(clampedLegacyTuning.requestsPerMinute, 30);
  assert.equal(getDncScrubConfig({ DNC_SCRUB_KEY:'key', DNC_SCRUB_PROJECT_ID:'project-7' }).projectId, 'project-7');
  assert.equal(getDncScrubConfig({ DNC_SCRUB_KEY:'key', DNC_SCRUB_CAMPAIGN_ID:'campaign-9' }).campaignId, 'campaign-9');
  assert.equal(getDncScrubConfig({ DNC_SCRUB__KEY:'legacy-key' }).apiKey, 'legacy-key');
  assert.equal(getDncScrubConfig({ DNC_SCRUB_KEY:'canonical', DNC_SCRUB__KEY:'legacy' }).apiKey, 'canonical');
  assert.equal(normalizePhone('+1 (312) 555-0100'), '3125550100');
  assert.equal(normalizePhone('312-555-0100'), '3125550100');
  assert.equal(normalizePhone('5550100'), null);
  assert.equal(extractPhone({ contact: { mobilePhone: '+1 312 555 0100' } }), '3125550100');
  assert.equal(extractPhone(JSON.stringify({ phone: '(773) 555-0199' })), '7735550199');
  assert.equal(extractPhone({ note: '3125550100' }), null);
  assert.deepEqual(
    extractPhoneCandidates({
      phone:'+1 312 555 0100',
      customFields:[
        { id:'fixture-field-02', value:'773-555-0199' },
        { id:'fixture-field-03', field_value:'847-555-0188' },
      ],
    }).map((item) => [item.slot, item.phone]),
    [['primary', '3125550100'], ['alternative', '7735550199'], ['phone3', '8475550188']]
  );
  assert.deepEqual(
    extractPhoneCandidates({
      phone:'3125550100',
      customFields:{
        'fixture-field-02':'3125550100',
        'fixture-field-03':'8475550188',
      },
    }).map((item) => item.slot),
    ['primary', 'phone3']
  );

  assert.equal(classifyDncScrubResult({ Phone:'3125550100', ResultCode:'C' }).state, 'clean');
  assert.equal(classifyDncScrubResult({ Phone:'3125550100', ResultCode:'W' }).state, 'clean');
  const dnc = classifyDncScrubResult({ Phone:'3125550100', ResultCode:'D', Reason:'National (USA) 2020-01-01;;;' });
  assert.equal(dnc.state, 'blocked');
  assert.equal(dnc.decisionCategory, 'dnc_registry_match');
  assert.equal(dnc.reason, 'National (USA) 2020-01-01;;;');
  const coverage = classifyDncScrubResult({ Phone:'3125550100', ResultCode:'B', Reason:'Configured no-call area code' });
  assert.equal(coverage.state, 'review');
  assert.equal(coverage.decisionCategory, 'configuration_or_coverage');
  assert.equal(coverage.reviewRequired, true);
  assert.equal(classifyDncScrubResult({ Phone:'3125550100', ResultCode:'I' }).state, 'review');
  assert.equal(classifyDncScrubResult({ Phone:'3125550100', ResultCode:'L' }).state, 'review');
  const internalDnc = classifyDncScrubResult({ Phone:'3125550100', ResultCode:'P', Reason:'Project DNC' });
  assert.equal(internalDnc.decisionCategory, 'internal_dnc_match');
  assert.equal(internalDnc.reviewRequired, true);
  assert.equal(classifyDncScrubResult({ Phone:'3125550100', ResultCode:'?' }).state, 'pending');
  assert.equal(sanitizeProviderText('Call 312-555-0100\nnow', 255), 'Call [redacted-phone] now');

  let captured;
  const results = await scrubPhoneNumbers(['3125550100', '+1 (773) 555-0199'], {
    config: {
      apiKey:'secret-test-key', projectId:'project-7', campaignId:'campaign-9',
      timeoutMs:1000, batchSize:500, maxRetries:0,
    },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify([
        { Phone:'3125550100', ResultCode:'C', Reason:'Clean', LineType:'Wireless' },
        { Phone:'7735550199', ResultCode:'D', Reason:'National DNC' },
      ]), { status:200, headers:{ 'Content-Type':'application/json' } });
    },
  });
  assert.equal(captured.url, DNC_SCRUB_ENDPOINT);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.loginId, 'secret-test-key');
  assert.ok(!captured.url.includes('secret-test-key'));
  assert.deepEqual(JSON.parse(captured.init.body), {
    phoneList:'3125550100,7735550199', version:'5', output:'json',
    projId:'project-7', campaignId:'campaign-9',
  });
  assert.deepEqual(results.map((item) => item.state), ['clean', 'blocked']);

  resetDncRateLimiter();
  let clock = 1000;
  const rateWaits = [];
  const rateOptions = {
    config:{ apiKey:'rate-key', timeoutMs:1000, batchSize:500, maxRetries:0, requestsPerMinute:60 },
    now:() => clock,
    sleep:async (delay) => { rateWaits.push(delay); clock += delay; },
    fetchImpl:async () => new Response(JSON.stringify([{ Phone:'3125550100', ResultCode:'C' }]), { status:200 }),
  };
  await scrubPhoneNumbers(['3125550100'], rateOptions);
  await scrubPhoneNumbers(['3125550100'], rateOptions);
  assert.deepEqual(rateWaits, [1000]);
  resetDncRateLimiter();

  let retryCalls = 0;
  const retryWaits = [];
  const retried = await scrubPhoneNumbers(['3125550100'], {
    config:{ apiKey:'retry-key', timeoutMs:1000, batchSize:500, maxRetries:1 },
    sleep:async (delay) => retryWaits.push(delay),
    fetchImpl:async () => {
      retryCalls += 1;
      if (retryCalls === 1) return new Response('', { status:429, headers:{ 'Retry-After':'2' } });
      return new Response(JSON.stringify([{ Phone:'3125550100', ResultCode:'C' }]), { status:200 });
    },
  });
  assert.equal(retried[0].state, 'clean');
  assert.equal(retryCalls, 2);
  assert.deepEqual(retryWaits, [2000]);

  await assert.rejects(
    () => scrubPhoneNumbers(['3125550100', 'invalid'], {
      config: { apiKey:'key', timeoutMs:1000, batchSize:500, maxRetries:0 },
      fetchImpl: async () => { throw new Error('must not be called'); },
    }),
    (error) => error.code === 'DNC_SCRUB_INVALID_PHONE'
  );
  await assert.rejects(
    () => scrubPhoneNumbers(['3125550100'], {
      config: { apiKey:'bad-key', timeoutMs:1000, batchSize:500, maxRetries:0 },
      fetchImpl: async () => new Response('credential details', { status:401 }),
    }),
    (error) => error.code === 'DNC_SCRUB_AUTH_FAILED' && !error.message.includes('credential details')
  );
  await assert.rejects(
    () => scrubPhoneNumbers(['3125550100'], {
      config: { apiKey:'key', timeoutMs:1000, batchSize:500, maxRetries:0 },
      fetchImpl: async () => new Response('{bad json', { status:200 }),
    }),
    (error) => error.code === 'DNC_SCRUB_INVALID_RESPONSE'
  );

  console.log('DNCScrub client tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
