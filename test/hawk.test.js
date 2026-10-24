const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
Object.assign(process.env, {
  INSTANCE_ID: 'd91de3d6-e11f-4c9a-8e21-9d630a9c2671',
  PUBLIC_API_BASE_PATH: '/suite42/api',
  WEBHOOK_BASE_PATH: '/suite42/hooks',
  HEALTH_PATH: '/suite42/status',
  API_KEY_PREFIX: 'q42_',
  AUTOMATION_NAMESPACE: 'suite42',
  SESSION_COOKIE_NAME: 'c_suite42',
  OPERATOR_COOKIE_NAME: 'o_suite42',
  API_DISPLAY_NAME: 'Store Connector',
  API_METADATA_HEADERS_ENABLED: 'false',
  API_METADATA_HEADER_PREFIX: 'Suite42',
});
const {
  defaultGraph, validateGraph, renderTemplates, evaluateCondition, safeData, runGraph,
  normalizeTriggerData, buildImportSchema, buildImportPreview, STANDARD_FIELD_CATALOG,
  buildExportPackage,
  ACTION_TYPES, ACTION_DEFINITIONS, TRIGGER_TYPES, TRIGGER_DEFINITIONS, buildGhlRequest,
  listConnections,
  searchTestRecords,
  isLeadConnectorConnection,
  createFlow,
  runGhlAction,
  runOutboundWebhook,
  validateOutboundWebhookUrl,
} = require('../src/services/hawk');
const { verifyWebhookAuth, normalizeWebhookPayload, matchesTrigger } = require('../src/services/hawkWebhooks');
const { classifyControlRequest, surfaceFor } = require('../src/middleware/controlPlaneSentinel');
const { materializeInstanceData } = require('../src/routes/instanceData');

function readInstancePack(filePath) {
  return JSON.parse(materializeInstanceData(fs.readFileSync(filePath, 'utf8'), null, path.basename(filePath)));
}

async function run() {
  const readableConnections = await listConnections({ apiKeyId:'key-1', locationId:'location-1' }, {
    query:async (sql, params) => {
      assert.match(sql, /g\.allow_read=1/);
      assert.doesNotMatch(sql, /g\.allow_manage_leads=1/);
      assert.deepEqual(params, ['key-1','location-1']);
      return [[{ id:'crm-1', name:'CRM', provider:'leadconnector-pit', location_id:'location-1', is_enabled:1,
        allow_read:1, allow_import:0, allow_manage_leads:0 }]];
    },
  });
  assert.equal(readableConnections[0].capabilities.manageLeads, false);
  assert.equal(isLeadConnectorConnection({ provider:'custom-crm', base_url:'https://services.leadconnectorhq.com' }), true);
  assert.equal(isLeadConnectorConnection({ provider:'custom-crm', base_url:'https://example.com' }), false);
  let flowInsert = null;
  const scopedFlow = await createFlow({
    apiKeyId:'key-1', locationId:'location-1', dataSourceSlug:'vibedialer', name:'Database-bound flow', graph:defaultGraph(),
  }, { id:'admin-1' }, { query:async (sql, params) => {
    if (sql.startsWith('INSERT INTO hawk_flows')) { flowInsert=params; return [{ affectedRows:1 }]; }
    if (sql.includes('FROM hawk_flows f')) return [[{
      id:flowInsert[0], api_key_id:'key-1', location_id:'location-1', data_source_slug:'vibedialer', integration_id:null,
      name:'Database-bound flow', description:'', status:'draft', draft_revision:1, draft_graph_json:JSON.stringify(defaultGraph()),
    }]];
    throw new Error(`Unexpected HAWK flow query: ${sql}`);
  } });
  assert.equal(flowInsert[3], 'vibedialer');
  assert.equal(scopedFlow.dataSourceSlug, 'vibedialer');
  const cachedRecords = await searchTestRecords({
    apiKeyId:'key-1', locationId:'location-1', integrationId:'crm-1', source:'contact_cache', query:'Jordan', limit:10,
  }, { query:async (sql, params) => {
    if (sql.includes('FROM crm_integrations i')) return [[{ id:'crm-1', location_id:'location-1', provider:'leadconnector-pit', is_enabled:1 }]];
    if (sql.includes('FROM crm_contact_records')) {
      assert.equal(params[2], '%Jordan%');
      return [[{ external_record_id:'contact-1', payload_json:JSON.stringify({ id:'contact-1', firstName:'Jordan', lastName:'Lee', email:'jordan@example.com', customFields:[{ id:'tier', value:'Gold' }] }), last_seen_at:'2026-07-13' }]];
    }
    throw new Error(`Unexpected HAWK test-record query: ${sql}`);
  } });
  assert.equal(cachedRecords.records[0].title, 'Jordan Lee');
  assert.equal(cachedRecords.records[0].payload.contactId, 'contact-1');
  assert.deepEqual(cachedRecords.records[0].payload.customFields, { tier:'Gold' });
  const graph = defaultGraph();
  const validation = validateGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.stats.nodes, 4);
  assert.equal(validation.stats.actions, 1);
  assert.ok(ACTION_TYPES.includes('ghl.create_task'));
  assert.ok(ACTION_TYPES.includes('ghl.create_object_record'));
  assert.ok(ACTION_TYPES.includes('suite42.evaluate_dialer_eligibility'));
  assert.ok(ACTION_TYPES.includes('suite42.assign_dialer'));
  assert.ok(ACTION_TYPES.includes('suite42.apply_call_outcome'));
  assert.ok(ACTION_TYPES.includes('webhook.send'));
  assert.ok(ACTION_TYPES.includes('parrot.inline'));
  const applyOutcome = ACTION_DEFINITIONS.find((item) => item.id === 'suite42.apply_call_outcome');
  assert.ok(applyOutcome);
  assert.ok(applyOutcome.fields.some((item) => item.key === 'outcome'));
  assert.ok(TRIGGER_TYPES.includes('webhook.received'));
  assert.ok(TRIGGER_TYPES.includes('message.inbound'));
  assert.equal(ACTION_DEFINITIONS.find((item) => item.id === 'ghl.send_message').scope, 'conversations/message.write');
  assert.equal(TRIGGER_DEFINITIONS.find((item) => item.id === 'opportunity.stage_changed').readiness, 'adapter_required');
  const eligibilityDefinition = ACTION_DEFINITIONS.find((item) => item.id === 'suite42.evaluate_dialer_eligibility');
  assert.ok(eligibilityDefinition.fields.some((item) => item.key === 'scrubAllPhones'));
  assert.ok(eligibilityDefinition.fields.some((item) => item.key === 'requireAlternatePhone'));

  const cycle = structuredClone(graph);
  const end = cycle.nodes.find((node) => node.id === 'end');
  end.type = 'action'; end.action = 'data.set'; end.nextNodeId = 'source_check';
  end.config = { key: 'loop', value: true };
  const cycleValidation = validateGraph(cycle);
  assert.equal(cycleValidation.valid, false);
  assert.ok(cycleValidation.errors.some((item) => item.code === 'FLOW_CYCLE'));

  const unknownAction = structuredClone(graph);
  unknownAction.nodes.find((node) => node.type === 'action').action = 'ghl.destroy_everything';
  assert.ok(validateGraph(unknownAction).errors.some((item) => item.code === 'ACTION_TYPE_INVALID'));

  const unsafeTemplate = structuredClone(graph);
  unsafeTemplate.nodes.find((node) => node.type === 'action').config.tags = ['{{trigger.authorization}}'];
  assert.ok(validateGraph(unsafeTemplate).errors.some((item) => item.code === 'TEMPLATE_PATH_INVALID'));

  assert.equal(evaluateCondition('Facebook', 'in', ['Facebook', 'Google']), true);
  assert.equal(evaluateCondition(['new-lead', 'priority'], 'contains', 'priority'), true);
  assert.equal(evaluateCondition('', 'not_exists'), true);
  assert.deepEqual(
    renderTemplates(
      { contactId: '{{trigger.contactId}}', note: 'Hello {{trigger.firstName}}', result: '{{steps.tag.response.status}}' },
      { trigger: { contactId: 'c-1', firstName: 'Jordan' }, data: {}, steps: { tag: { response: { status: 201 } } } }
    ),
    { contactId: 'c-1', note: 'Hello Jordan', result: 201 }
  );
  assert.deepEqual(safeData({ token: 'remove', nested: { password: 'remove', value: 'keep' } }), {
    token: '[redacted]', nested: { password: '[redacted]', value: 'keep' },
  });
  assert.deepEqual(normalizeTriggerData({ customFields: [
    { id: 'field_1', value: 'Gold' }, { fieldId: 'field_2', field_value: 42 },
  ] }).customFields, { field_1: 'Gold', field_2: 42 });

  const catalog = {
    fields: [
      ...STANDARD_FIELD_CATALOG,
      { label: 'Customer tier', objectModel: 'contact', runtimePath: 'trigger.customFields.field_1',
        template: '{{trigger.customFields.field_1}}', fieldId: 'field_1', fieldKey: 'contact.customer_tier',
        dataType: 'string', allowedValues: ['Gold', 'Silver'], writable: true },
    ],
    objects: [{ id: 'contact', label: 'Contact', fieldCount: 15 }],
  };
  const liveSchema = buildImportSchema(catalog);
  assert.ok(liveSchema.$defs.runtimePath.enum.includes('trigger.customFields.field_1'));
  assert.ok(liveSchema.$defs.runtimePath.enum.includes('trigger.serviceType'));
  assert.ok(liveSchema.$defs.runtimePath.enum.includes('trigger.callOutcome'));
  assert.ok(liveSchema.$defs.runtimePath.enum.includes('trigger.name'));
  assert.deepEqual(liveSchema['x-hawk-catalog'].runtimeFields.at(-1).allowedValues, ['Gold', 'Silver']);
  assert.ok(liveSchema['x-hawk-catalog'].actionDefinitions.some((item) => item.id === 'ghl.create_appointment'));
  const importPreview = buildImportPreview({ format: 'hawk-automation-1', flows: [{ name: 'Imported lead flow', graph }] }, catalog);
  assert.equal(importPreview[0].validation.valid, true, JSON.stringify(importPreview[0].validation.errors));
  const exported = buildExportPackage({
    id:'flow-1', locationId:'location-1', dataSourceSlug:'vibedialer', integrationId:'crm-1',
    name:'Exported lead flow', description:'Portable source', status:'active', draftRevision:7,
    publishedVersionNumber:3, graph,
  });
  assert.equal(exported.format, 'hawk-automation-1');
  assert.equal(exported.generatedFor.flowId, 'flow-1');
  assert.equal(exported.generatedFor.draftRevision, 7);
  assert.equal(exported.flows[0].integrationId, 'crm-1');
  assert.equal(buildImportPreview(exported, catalog)[0].validation.valid, true);
  const badImport = structuredClone(graph);
  badImport.nodes.find((node) => node.type === 'condition').config.field = 'trigger.customFields.missing';
  assert.ok(buildImportPreview({ format: 'hawk-automation-1', flows: [{ name: 'Bad import', graph: badImport }] }, catalog)[0]
    .validation.errors.some((item) => item.code === 'CATALOG_PATH_UNKNOWN'));

  const codeGraph = structuredClone(graph);
  const codeNode = codeGraph.nodes.find((node) => node.type === 'action');
  codeNode.action = 'code.run'; codeNode.config = { language: 'python', inputs: { value: '{{trigger.source}}' }, code: 'result = inputs["value"]' };
  assert.equal(validateGraph(codeGraph).valid, true);
  codeNode.config.language = 'ruby';
  assert.ok(validateGraph(codeGraph).errors.some((item) => item.code === 'CODE_LANGUAGE_INVALID'));

  const bundledPythonGraph = structuredClone(graph);
  const bundledNode = bundledPythonGraph.nodes.find((node) => node.type === 'action');
  bundledNode.action = 'parrot.inline';
  bundledNode.config = {
    language:'python', inputs:{ domain:'{{trigger.domain}}' }, capabilities:['network.dns'],
    code:'def run(inputs, context):\n    return {"domain": inputs.get("domain")}',
  };
  assert.equal(validateGraph(bundledPythonGraph).valid, true, JSON.stringify(validateGraph(bundledPythonGraph).errors));
  bundledNode.config.code = '';
  assert.ok(validateGraph(bundledPythonGraph).errors.some((item) => item.code === 'PARROT_SOURCE_REQUIRED'));

  const taskRequest = buildGhlRequest('ghl.create_task', {
    contactId: 'contact-1', title: 'Call lead', body: 'Review record', assignedTo: 'user-1',
    dueDate: '2026-07-15T16:00:00.000Z', completed: false,
  }, { location_id: 'location-1' });
  assert.deepEqual(taskRequest, {
    method: 'POST', path: '/contacts/contact-1/tasks',
    body: { title: 'Call lead', body: 'Review record', assignedTo: 'user-1', dueDate: '2026-07-15T16:00:00.000Z', completed: false },
  });
  const messageRequest = buildGhlRequest('ghl.send_message', {
    contactId: 'contact-1', type: 'SMS', message: 'Hello {{trigger.firstName}}',
  }, { location_id: 'location-1' });
  assert.equal(messageRequest.path, '/conversations/messages');
  assert.equal(messageRequest.body.status, 'pending');
  const objectRequest = buildGhlRequest('ghl.create_object_record', {
    schemaKey: 'custom_objects.dials', properties: { outcome: 'connected' },
  }, { location_id: 'location-1' });
  assert.equal(objectRequest.path, '/objects/custom_objects.dials/records?locationId=location-1');
  assert.throws(() => buildGhlRequest('ghl.create_object_record', { schemaKey: '../contacts', properties: {} }, { location_id: 'location-1' }), /schemaKey/);

  let ghlAttempts = 0;
  const retriedGhlAction = await runGhlAction('ghl.add_tags', {
    contactId:'contact-1', tags:['cc-pool-mold'],
  }, {
    location_id:'location-1', base_url:'https://services.leadconnectorhq.com', config_json:'{}',
  }, async () => {
    ghlAttempts += 1;
    if (ghlAttempts === 1) return new Response('{"message":"rate limited"}', {
      status:429, headers:{ 'content-type':'application/json', 'retry-after':'0' },
    });
    return new Response('{"tagsAdded":["cc-pool-mold"]}', { status:201, headers:{ 'content-type':'application/json' } });
  });
  assert.equal(ghlAttempts, 2);
  assert.equal(retriedGhlAction.status, 201);
  assert.equal(retriedGhlAction.attempts, 2);

  let networkAttempts = 0;
  const retriedNetworkAction = await runGhlAction('ghl.remove_tags', {
    contactId:'contact-1', tags:['cc-recheck'],
  }, {
    location_id:'location-1', base_url:'https://services.leadconnectorhq.com', config_json:'{}',
  }, async () => {
    networkAttempts += 1;
    if (networkAttempts === 1) throw new TypeError('fetch failed', { cause:{ code:'ECONNRESET' } });
    return new Response('{"tagsRemoved":["cc-recheck"]}', { status:200, headers:{ 'content-type':'application/json' } });
  });
  assert.equal(networkAttempts, 2);
  assert.equal(retriedNetworkAction.status, 200);
  assert.equal(retriedNetworkAction.attempts, 2);

  const inboundBody = Buffer.from(JSON.stringify({ type:'ContactTagUpdate', locationId:'location-1', id:'contact-1', tags:['cc-recheck'] }));
  const inboundPayload = normalizeWebhookPayload(JSON.parse(inboundBody));
  assert.equal(inboundPayload.contactId, 'contact-1');
  assert.equal(inboundPayload.eventName, 'ContactTagUpdate');
  const nestedCustomPayload = normalizeWebhookPayload({
    contact:{ id:'contact-2' },
    customData:{ eventName:'call_center.eligibility' },
  });
  assert.equal(nestedCustomPayload.contactId, 'contact-2');
  assert.equal(nestedCustomPayload.eventName, 'call_center.eligibility');
  assert.equal(matchesTrigger({ config:{ event:'webhook.received', eventName:'call_center.eligibility' } }, nestedCustomPayload).accepted, true);
  assert.equal(matchesTrigger({ config:{ event:'webhook.received', eventName:'call_center.eligibility' } }, { contactId:'contact-3' }).accepted, true);
  assert.equal(matchesTrigger({ config:{ event:'webhook.received', eventName:'call_center.eligibility' } }, { eventName:'call_center.outcome' }).accepted, false);
  assert.equal(matchesTrigger({ config:{ event:'contact.tag_added', tag:'cc-recheck' } }, inboundPayload).accepted, true);
  assert.equal(matchesTrigger({ config:{ event:'contact.tag_added', tag:'other-tag' } }, inboundPayload).accepted, false);
  assert.equal(verifyWebhookAuth('hawk-secret', { authorization:'Bearer hawk-secret' }, inboundBody), 'bearer');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = require('crypto').createHmac('sha256', 'hawk-secret').update(`${timestamp}.`).update(inboundBody).digest('hex');
  assert.equal(verifyWebhookAuth('hawk-secret', { 'x-hawk-timestamp':timestamp, 'x-hawk-signature':`sha256=${signature}` }, inboundBody), 'hmac');
  assert.throws(() => verifyWebhookAuth('hawk-secret', { authorization:'Bearer wrong' }, inboundBody), /authentication failed/);
  await assert.rejects(() => validateOutboundWebhookUrl('http://example.com/hook', async () => [{ address:'93.184.216.34' }]), /HTTPS/);
  await assert.rejects(() => validateOutboundWebhookUrl('https://127.0.0.1/hook'), /blocked network/);
  const sentWebhook = await runOutboundWebhook({ url:'https://example.com/hooks/abc?token=secret', method:'POST', body:{ contactId:'contact-1' } },
    async (url, request) => {
      assert.equal(url, 'https://example.com/hooks/abc?token=secret');
      assert.equal(request.method, 'POST');
      assert.deepEqual(JSON.parse(request.body), { contactId:'contact-1' });
      return { ok:true, status:202, text:async () => '{"accepted":true}' };
    }, async () => [{ address:'93.184.216.34' }]);
  assert.equal(sentWebhook.status, 202);

  const invalidTaskGraph = structuredClone(graph);
  const invalidTaskNode = invalidTaskGraph.nodes.find((node) => node.type === 'action');
  invalidTaskNode.action = 'ghl.create_task'; invalidTaskNode.config = { contactId: '{{trigger.contactId}}' };
  assert.ok(validateGraph(invalidTaskGraph).errors.some((item) => item.code === 'ACTION_INPUT_REQUIRED'));

  const calls = [];
  const successful = await runGraph(graph, { contactId: 'contact-1', source: 'Facebook' }, {
    mode: 'dry_run',
    actionRunner: async ({ node, config, mode }) => {
      calls.push({ node: node.id, config, mode });
      return { dryRun: true, status: 200 };
    },
  });
  assert.equal(successful.completed, true);
  assert.equal(successful.steps.length, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.contactId, 'contact-1');
  assert.equal(calls[0].mode, 'dry_run');

  const noBranch = await runGraph(graph, { contactId: 'contact-2', source: 'Referral' }, {
    actionRunner: async () => { throw new Error('No action should run'); },
  });
  assert.deepEqual(noBranch.steps.map((step) => step.nodeId), ['trigger', 'source_check', 'end']);

  const dataGraph = {
    schemaVersion: 1, startNodeId: 'trigger', nodes: [
      { id: 'trigger', type: 'trigger', name: 'Manual', config: { event: 'manual' }, nextNodeId: 'store', position: { x: 0, y: 0 } },
      { id: 'store', type: 'action', action: 'data.set', name: 'Store', config: { key: 'contact', value: '{{trigger.contactId}}' }, nextNodeId: 'end', position: { x: 0, y: 100 } },
      { id: 'end', type: 'end', name: 'End', config: {}, position: { x: 0, y: 200 } },
    ],
  };
  const dataRun = await runGraph(dataGraph, { contactId: 'contact-3' }, {
    actionRunner: async ({ config }) => ({ stored: true, ...config }),
  });
  assert.deepEqual(dataRun.data, { contact: 'contact-3' });

  assert.equal(surfaceFor('/api/hawk/flows'), 'hawk');
  const classified = classifyControlRequest('POST', '/api/hawk/flows/flow-1/test');
  assert.equal(classified.surface, 'hawk');
  assert.equal(classified.action, 'hawk.execution.test');
  assert.equal(classified.entityId, 'flow-1');
  const sampleClassified = classifyControlRequest('POST', '/api/hawk/flows/flow-1/webhook-sample');
  assert.equal(sampleClassified.action, 'hawk.webhook.sample.send');
  assert.equal(sampleClassified.entityId, 'flow-1');

  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'admin', 'hawk.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public', 'js', 'hawk-center.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'hawk.css'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'adminHawk.js'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8');
  assert.match(html, /HAWK Automation Center/);
  assert.match(html, /id="dataSource"/);
  assert.match(html, /Execution history/i);
  assert.match(html, /Replay this execution/i);
  assert.match(html, /Import HAWK JSON/i);
  assert.match(html, /Select a live CRM field/i);
  assert.match(html, /id="runtimeFieldList"/);
  assert.match(html, /data-test-input-mode="guided"/);
  assert.match(html, /id="codeInputRows"/);
  assert.match(html, /id="testRecordSource"/);
  assert.match(html, /id="testRecordResults"/);
  assert.match(html, /id="webhookTriggerFields"/);
  assert.match(html, /id="sendWebhookSampleButton"/);
  assert.match(html, /Send mapping sample/);
  assert.match(html, /Authorization: Bearer/);
  assert.match(html, /id="flowLibraryDialog"/);
  assert.match(html, /id="newFlowFolder"/);
  assert.match(html, /id="importFolder"/);
  assert.match(html, /id="exportButton"/);
  assert.match(html, /id="flowCodeDialog"/);
  assert.match(html, /Save Draft from Code/);
  assert.match(html, /Authenticated API/);
  assert.match(js, /\/api\/hawk\/executions/);
  assert.match(js, /dataSourceSlug:el\('dataSource'\)/);
  assert.match(js, /\/api\/hawk\/catalog/);
  assert.match(js, /function useRuntimeField/);
  assert.match(js, /function buildGuidedTestInput/);
  assert.match(js, /function searchTestRecords/);
  assert.match(js, /\/api\/hawk\/test-records/);
  assert.match(js, /function provisionWebhook/);
  assert.match(js, /function sendWebhookSample/);
  assert.match(js, /webhook-sample/);
  assert.match(js, /\/webhook/);
  assert.match(js, /function renderFlowLibrary/);
  assert.match(js, /\/api\/hawk\/folders/);
  assert.match(js, /\/organization/);
  assert.match(js, /function exportCurrentFlow/);
  assert.match(js, /function saveFlowCode/);
  assert.match(js, /\/source/);
  assert.match(css, /--hawk-yellow/);
  assert.match(css, /\.hawk-workspace\.inspector-expanded/);
  assert.match(css, /color-scheme:dark/);
  assert.match(css, /\.flow-library-dialog/);
  assert.match(css, /\.test-record-browser/);
  assert.match(css, /\.webhook-trigger-card/);
  assert.match(css, /\.webhook-sample-panel/);
  assert.match(css, /\.flow-code-dialog/);
  assert.match(routes, /flows\/:id\/export/);
  assert.match(routes, /flows\/:id\/source/);
  assert.match(routes, /flows\/:id\/webhook-sample/);
  assert.match(routes, /hawk\.webhook\.sample\.send/);
  assert.match(routes, /hawk\.flow\.source\.update/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'data', 'hawk-automation-ai-rules.md')));
  assert.ok(fs.existsSync(path.join(root, 'public', 'data', 'hawk-automation-template.json')));
  const samplePackage = readInstancePack(path.join(root, 'public', 'data', 'hawk-automation-template.json'));
  assert.equal(buildImportPreview(samplePackage, catalog)[0].validation.valid, true);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS hawk_execution_steps/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS crm_object_definitions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS hawk_flow_folders/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS hawk_webhook_endpoints/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS hawk_webhook_deliveries/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS owl_user_pool_permissions/);
  assert.match(schema, /fallback_user_id\s+VARCHAR\(128\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS hawk_dialer_assignment_events/);
  assert.match(schema, /folder_id\s+CHAR\(36\)/);
  assert.match(schema, /data_source_slug\s+VARCHAR\(63\)/);
  console.log('HAWK automation tests passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
