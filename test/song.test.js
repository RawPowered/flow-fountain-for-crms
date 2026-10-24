const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { setPool } = require('../src/db/pool');
const { createSongRuntimeRouter } = require('../src/routes/api/songRuntime');
const {
  defaultGraph,
  validateGraph,
  safeMetadata,
  createScript,
  getScript,
  saveDraft,
  publishScript,
  changeScriptLanguage,
  getRuntimeScript,
  recordRuntimeEvent,
  listVariableCatalog,
  listRuntimeScripts,
  resolveRuntimeVariables,
  vibeServiceToGraph,
  normalizeLanguageCode,
} = require('../src/services/song');

async function run() {
  const base = defaultGraph();
  const validation = validateGraph(base);
  assert.equal(validation.valid, true);
  assert.equal(validation.stats.nodes, 3);
  assert.ok(validation.stats.branches >= 3);
  assert.equal(normalizeLanguageCode('ES_us'), 'es-US');
  assert.throws(() => normalizeLanguageCode('not a language'), (error) => error.code === 'SONG_LANGUAGE_INVALID');

  const dynamic = structuredClone(base);
  dynamic.variables.push({ key:'creditScoreRange', label:'Credit score range', source:'field.crmCredit123', defaultValue:'' });
  dynamic.nodes[0].prompt += ' Credit profile: {{creditScoreRange}}';
  assert.equal(validateGraph(dynamic).valid, true);

  const catalogQueries = [];
  const catalog = await listVariableCatalog({ apiKeyId:'key-1', locationId:'location-1' }, {
    async query(sql) {
      catalogQueries.push(sql);
      if (sql.includes('FROM crm_integrations i')) return [[{ id:'integration-1' }]];
      if (sql.includes('FROM crm_object_field_definitions')) return [[
        { field_id:'crmCredit123', object_model:'contact', field_key:'contact.credit_score_range', field_name:'Credit Score Range', data_type:'TEXT' },
        { field_id:'crmBooks123', object_model:'contact', field_key:'contact.books', field_name:'Books', data_type:'TEXT' },
      ]];
      if (sql.includes('FROM crm_field_definitions')) return [[
        { field_key:'contact.books', field_label:'Books', data_type:'string' },
        { field_key:'contact.discretionary_income', field_label:'Discretionary Income', data_type:'number' },
      ]];
      throw new Error(`Unexpected catalog query: ${sql}`);
    },
  });
  assert.ok(catalog.some((item) => item.source === 'lead.firstName' && item.group === 'Contact'));
  assert.ok(catalog.some((item) => item.source === 'field.crmCredit123' && item.label === 'Credit Score Range'));
  assert.ok(catalog.some((item) => item.source === 'field.contact.discretionary_income'));
  assert.equal(catalog.filter((item) => item.source === 'field.crmBooks123').length, 1);
  assert.equal(catalogQueries.length, 3);

  const vibeGraph = vibeServiceToGraph({
    serviceType:'Roofing', reason:'a roof inspection',
    mainScript:{
      identity:'"{getGreeting()}, is this {contact.firstName}?"',
      reason:'"This is {agent.firstName} calling about your request in {contact.city}."',
    },
    concerns:[
      { id:'leak', label:'Active leak', response:'I understand. We should address that quickly.', action:'jump_to_stage', targetStage:'appointment' },
      { id:'tenant', label:'Not the owner', response:'Thank you for clarifying.', action:'end_call' },
    ],
    outcomes:['Appointment Booked','Not Interested'],
  });
  const vibeValidation = validateGraph(vibeGraph);
  assert.equal(vibeValidation.valid, true, JSON.stringify(vibeValidation.errors));
  assert.match(vibeGraph.nodes.find((node) => node.id === 'identity').prompt, /{{dynamicGreeting}}.*{{firstName}}/);
  assert.match(vibeGraph.nodes.find((node) => node.id === 'reason').prompt, /{{agentName}}.*{{city}}/);
  const leakBranch = vibeGraph.nodes.find((node) => node.id === 'diagnosis').branches[0];
  assert.equal(leakBranch.targetNodeId, 'appointment');
  assert.match(leakBranch.agentResponse, /address that quickly/);
  assert.equal(vibeGraph.nodes.find((node) => node.id === 'appointment').actions[0].config.useServicePoolCalendar, true);
  assert.equal(vibeGraph.nodes.find((node) => node.id === 'address').actions[0].type, 'capture_input');

  const richVibeGraph = vibeServiceToGraph({
    serviceType:'Solar', reason:'a solar consultation',
    mainScript:{
      identity:{
        text:'{getGreeting()}, is this {contact.firstName}?', type:'question',
        answers:[
          { id:'identity_yes', label:'Yes', action:'proceed' },
          { id:'identity_no', label:'Wrong person', action:'show_negative_path', negativePathText:'Thank you. I have the wrong number.', negativePathOutcome:'Wrong Number' },
        ],
      },
      reason:{
        text:'This is {agent.firstName} calling about {currentServiceData.reason} in {contact.city}.', type:'statement',
        answers:[
          { id:'reason_continue', label:'Continue', response:'Great, I will keep this brief.', action:'proceed' },
          { id:'reason_stop', label:'Not interested', action:'show_negative_path', negativePathText:'Understood. I will close the request.', negativePathOutcome:'Not Interested' },
        ],
      },
    },
    concerns:[], outcomes:['Appointment Booked','Not Interested','Wrong Number'],
  });
  assert.equal(validateGraph(richVibeGraph).valid, true);
  assert.ok(richVibeGraph.nodes.every((node) => !node.prompt.includes('[object Object]')));
  assert.match(richVibeGraph.nodes.find((node) => node.id === 'reason').prompt, /solar consultation.*{{city}}/);
  assert.match(richVibeGraph.nodes.find((node) => node.id === 'reason').branches[0].agentResponse, /keep this brief/);
  assert.match(richVibeGraph.nodes.find((node) => node.id === 'wrong_number').prompt, /wrong number/);
  assert.throws(
    () => vibeServiceToGraph({ serviceType:'Roofing', mainScript:{ reason:{ text:{ nested:true } } } }),
    (error) => error.code === 'SONG_VIBE_TEMPLATE_INVALID' && error.details.path === 'mainScript.reason.text'
  );

  const sampleTemplate = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'song-vibe-template.json'), 'utf8'));
  assert.equal(sampleTemplate.templateVersion, 'song-vibe-1');
  for (const service of sampleTemplate.services) {
    const graph = vibeServiceToGraph(service);
    const sampleValidation = validateGraph(graph);
    assert.equal(sampleValidation.valid, true, JSON.stringify(sampleValidation.errors));
    assert.ok(graph.nodes.every((node) => !node.prompt.includes('[object Object]')));
  }

  const resolvedVariables = await resolveRuntimeVariables({
    leadId:'lead-1', locationId:'location-1',
    operator:{ userId:'user-1', username:'agent', crmUserName:'Joseph Edwards', isAdmin:false },
    variables:[
      { key:'firstName', source:'lead.firstName', defaultValue:'' },
      { key:'agentName', source:'operator.displayName', defaultValue:'' },
      { key:'books', source:'field.crmBooks123', defaultValue:'Unknown' },
      { key:'income', source:'field.contact.discretionary_income', defaultValue:'Unknown' },
      { key:'greeting', source:'runtime.greeting', defaultValue:'Hello' },
    ],
    runtimeContext:{ greeting:'Good afternoon' },
  }, {
    async query(sql) {
      if (sql.includes('FROM leads WHERE')) return [[{
        id:'lead-1', locationId:'location-1', serviceType:'Roofing', assignedTo:'user-1',
        contactData:JSON.stringify({ firstName:'Marcus', customFields:[{ id:'crmBooks123', value:'History' }] }),
      }]];
      if (sql.includes('FROM lead_import_values')) return [[{
        field_key:'contact.discretionary_income', data_type:'number', value_number:'4200.00',
        value_text:null, value_datetime:null, value_boolean:null, value_json:null,
      }]];
      if (sql.includes('FROM crm_object_field_definitions d')) return [[]];
      throw new Error(`Unexpected resolver query: ${sql}`);
    },
  });
  assert.deepEqual(resolvedVariables, {
    greeting:'Good afternoon', firstName:'Marcus', agentName:'Joseph Edwards', books:'History', income:4200,
  });
  await assert.rejects(
    resolveRuntimeVariables({
      leadId:'lead-1', locationId:'location-1', operator:{ userId:'other-user', isAdmin:false },
      variables:[{ key:'firstName', source:'lead.firstName', defaultValue:'' }],
    }, {
      async query(sql) {
        if (sql.includes('FROM leads WHERE')) return [[{
          id:'lead-1', locationId:'location-1', serviceType:'Roofing', assignedTo:'user-1', contactData:'{}',
        }]];
        throw new Error(`Unexpected forbidden resolver query: ${sql}`);
      },
    }),
    (error) => error.status === 403 && error.code === 'SONG_RUNTIME_LEAD_FORBIDDEN'
  );

  const invalid = structuredClone(base);
  invalid.nodes[0].branches[0].targetNodeId = 'missing';
  const invalidResult = validateGraph(invalid);
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.errors.some((item) => item.code === 'BRANCH_TARGET_UNKNOWN'));

  const metadata = safeMetadata({
    duration:12, password:'remove', nested:{ authorization:'remove', result:'kept' },
  });
  assert.deepEqual(metadata, { duration:12, nested:{ result:'kept' } });

  const state = { script:null, versions:[], assignment:null, languageAssignment:null, serviceAssignmentWrites:0, events:[] };
  const pool = {
    query:async (sql, params = []) => {
      if (sql.startsWith('INSERT INTO song_scripts')) {
        state.script = {
          id:params[0], api_key_id:params[1], location_id:params[2], service_type:params[3],
          language_code:params[4], name:params[5], description:params[6], status:'draft', draft_revision:1,
          draft_graph_json:params[7], published_version_id:null,
          created_at:'2026-07-12 12:00:00', updated_at:'2026-07-12 12:00:00',
        };
        return [{ affectedRows:1 }];
      }
      if (sql.includes('FROM song_scripts s') && sql.includes('WHERE s.id=?') && !sql.includes("s.status='published'")) {
        if (!state.script || state.script.id !== params[0]) return [[]];
        const published = state.versions.find((item) => item.id === state.script.published_version_id);
        return [[{
          ...state.script,
          published_version_number:published?.versionNumber ?? null,
          published_at:published?.publishedAt ?? null,
          is_assigned:state.assignment?.scriptId === state.script.id ? 1 : 0,
          is_language_default:state.languageAssignment?.scriptId === state.script.id ? 1 : 0,
        }]];
      }
      if (sql.startsWith('UPDATE song_scripts SET name=')) {
        if (Number(params[9]) !== state.script.draft_revision) return [{ affectedRows:0 }];
        state.script.name = params[0]; state.script.description = params[1];
        state.script.service_type = params[2]; state.script.language_code = params[3];
        state.script.draft_graph_json = params[4];
        state.script.draft_revision += 1;
        return [{ affectedRows:1 }];
      }
      if (sql.includes('FROM song_service_assignments a') && sql.includes('v.compiled_json')) {
        const version = state.versions.find((item) => item.id === state.assignment?.versionId);
        return version ? [[{
          script_id:state.assignment.scriptId, version_id:version.id,
          compiled_json:version.compiledJson, checksum:version.checksum,
          published_at:version.publishedAt,
        }]] : [[]];
      }
      if (sql.includes('FROM song_service_language_assignments a') && sql.includes('v.compiled_json')) {
        const version = state.versions.find((item) => item.id === state.languageAssignment?.versionId);
        return version && params[3] === state.languageAssignment?.languageCode ? [[{
          script_id:state.languageAssignment.scriptId, version_id:version.id,
          compiled_json:version.compiledJson, checksum:version.checksum,
          published_at:version.publishedAt,
        }]] : [[]];
      }
      if (sql.includes('FROM song_scripts s') && sql.includes("s.status='published'") && sql.includes('WHERE s.id=?')) {
        const version = state.versions.find((item) => item.id === state.script?.published_version_id);
        return version && params[0] === state.script.id && params[1] === state.script.api_key_id
          && params[2] === state.script.location_id && params[3] === state.script.service_type
          && (params.length < 5 || params[4] === state.script.language_code)
          ? [[{
            script_id:state.script.id, version_id:version.id, compiled_json:version.compiledJson,
            checksum:version.checksum, published_at:version.publishedAt,
          }]] : [[]];
      }
      if (sql.startsWith('SELECT s.id AS script_id,s.service_type')) {
        const version = state.versions.find((item) => item.id === state.script?.published_version_id);
        return version ? [[
          {
            script_id:state.script.id, service_type:state.script.service_type,
            language_code:state.script.language_code,
            name:state.script.name, description:state.script.description,
            version_id:version.id, version_number:version.versionNumber,
            checksum:version.checksum, published_at:version.publishedAt,
            is_default:1, is_language_default:1,
          },
          {
            script_id:'91d972ba-188e-4af7-9ef3-6cdba44a6aa2', service_type:'Roofing',
            language_code:'es-US',
            name:'Roofing Follow Up', description:'Alternate published flow',
            version_id:'54872441-d693-48ce-8325-e39bba5b9a7a', version_number:2,
            checksum:'alternate-checksum', published_at:'2026-07-12 12:06:00',
            is_default:0, is_language_default:1,
          },
        ]] : [[]];
      }
      if (sql.includes('SELECT v.compiled_json FROM song_script_versions')) {
        const version = state.versions.find((item) => item.id === params[1] && state.script.id === params[0]);
        return version ? [[{ compiled_json:version.compiledJson }]] : [[]];
      }
      if (sql.startsWith('INSERT INTO song_runtime_events')) {
        state.events.push(params);
        return [{ insertId:1, affectedRows:1 }];
      }
      throw new Error(`Unexpected SONG pool query: ${sql}`);
    },
    getConnection:async () => ({
      beginTransaction:async () => {}, commit:async () => {}, rollback:async () => {}, release:() => {},
      query:async (sql, params = []) => {
        if (sql.includes('FROM song_scripts WHERE') && sql.includes('FOR UPDATE')) return [[state.script]];
        if (sql.startsWith('SELECT COALESCE(MAX(version_number)')) {
          return [[{ nextVersion:state.versions.length + 1 }]];
        }
        if (sql.startsWith('INSERT INTO song_script_versions')) {
          state.versions.push({
            id:params[0], scriptId:params[1], versionNumber:params[2], graphJson:params[3],
            compiledJson:params[4], checksum:params[5], publishedAt:'2026-07-12 12:05:00',
          });
          return [{ affectedRows:1 }];
        }
        if (sql.startsWith('SELECT graph_json,compiled_json,validation_json')) {
          const version = state.versions.find((item) => item.id === params[0] && item.scriptId === params[1]);
          return version ? [[{
            graph_json:version.graphJson, compiled_json:version.compiledJson,
            validation_json:JSON.stringify({ warnings:[], stats:{} }),
          }]] : [[]];
        }
        if (sql.startsWith("UPDATE song_scripts SET status='published'")) {
          state.script.status = 'published'; state.script.published_version_id = params[0];
          return [{ affectedRows:1 }];
        }
        if (sql.startsWith('UPDATE song_scripts SET language_code=?,published_version_id=')) {
          state.script.language_code = params[0]; state.script.published_version_id = params[1];
          return [{ affectedRows:1 }];
        }
        if (sql.startsWith('UPDATE song_scripts SET language_code=?,updated_by=')) {
          state.script.language_code = params[0];
          return [{ affectedRows:1 }];
        }
        if (sql.startsWith('DELETE FROM song_service_language_assignments')) {
          const matches = state.languageAssignment?.apiKeyId === params[0]
            && state.languageAssignment?.locationId === params[1]
            && state.languageAssignment?.serviceType === params[2]
            && state.languageAssignment?.languageCode === params[3]
            && state.languageAssignment?.scriptId === params[4];
          if (matches) state.languageAssignment = null;
          return [{ affectedRows:matches ? 1 : 0 }];
        }
        if (sql.startsWith('DELETE FROM song_service_assignments')) {
          const matches = state.assignment?.apiKeyId === params[0]
            && state.assignment?.locationId === params[1]
            && state.assignment?.serviceType === params[2]
            && state.assignment?.scriptId === params[3];
          if (matches) state.assignment = null;
          return [{ affectedRows:matches ? 1 : 0 }];
        }
        if (sql.startsWith('SELECT id,published_version_id FROM song_scripts')) return [[]];
        if (sql.startsWith('INSERT INTO song_service_assignments')) {
          state.serviceAssignmentWrites += 1;
          state.assignment = {
            apiKeyId:params[0], locationId:params[1], serviceType:params[2],
            scriptId:params[3], versionId:params[4],
          };
          return [{ affectedRows:1 }];
        }
        if (sql.startsWith('INSERT INTO song_service_language_assignments')) {
          state.languageAssignment = {
            apiKeyId:params[0], locationId:params[1], serviceType:params[2],
            languageCode:params[3], scriptId:params[4], versionId:params[5],
          };
          return [{ affectedRows:1 }];
        }
        throw new Error(`Unexpected SONG connection query: ${sql}`);
      },
    }),
  };

  const actor = { id:'admin-1', username:'root' };
  let script = await createScript({
    apiKeyId:'key-1', locationId:'location-1', serviceType:'Roofing', name:'Roofing Intake',
  }, actor, pool);
  assert.equal(script.draftRevision, 1);
  assert.equal(script.status, 'draft');
  assert.equal(script.languageCode, 'en-US');

  const saved = await saveDraft(script.id, {
    apiKeyId:'key-1', locationId:'location-1', expectedRevision:1,
    name:'Roofing Intake', graph:script.graph,
  }, actor, pool);
  script = saved.after;
  assert.equal(script.draftRevision, 2);
  await assert.rejects(
    saveDraft(script.id, {
      apiKeyId:'key-1', locationId:'location-1', expectedRevision:1,
      graph:script.graph,
    }, actor, pool),
    (error) => error.status === 409 && error.code === 'SONG_REVISION_CONFLICT'
  );

  const published = await publishScript(script.id, {
    apiKeyId:'key-1', locationId:'location-1', expectedRevision:2,
  }, actor, pool);
  assert.equal(published.version.number, 1);
  assert.equal(published.script.status, 'published');
  assert.equal(state.assignment.serviceType, 'Roofing');
  assert.equal(state.languageAssignment.languageCode, 'en-US');
  assert.equal(published.script.languageCode, 'en-US');

  const runtime = await getRuntimeScript({
    apiKeyId:'key-1', locationId:'location-1', serviceType:'Roofing',
  }, pool);
  assert.equal(runtime.scriptId, script.id);
  assert.equal(runtime.versionNumber, 1);
  assert.equal(Object.hasOwn(runtime.nodes[0], 'position'), false);
  assert.equal(Object.hasOwn(runtime, 'publishedBy'), false);

  const runtimeCatalog = await listRuntimeScripts({
    apiKeyId:'key-1', locationId:'location-1', serviceType:'Roofing', query:'Intake', limit:10,
  }, pool);
  assert.equal(runtimeCatalog.length, 2);
  assert.deepEqual(Object.keys(runtimeCatalog[0]).sort(), [
    'checksum','description','isDefault','isLanguageDefault','languageCode','name','publishedAt','scriptId','serviceType','versionId','versionNumber',
  ]);
  assert.equal(runtimeCatalog[0].scriptId, script.id);
  assert.equal(runtimeCatalog[0].isDefault, true);
  assert.equal(runtimeCatalog[0].languageCode, 'en-US');
  assert.equal(runtimeCatalog[0].isLanguageDefault, true);
  assert.equal(runtimeCatalog[1].isDefault, false);
  const selectedRuntime = await getRuntimeScript({
    apiKeyId:'key-1', locationId:'location-1', serviceType:'Roofing',
    scriptId:script.id, languageCode:'en-US',
  }, pool);
  assert.equal(selectedRuntime.scriptId, script.id);
  await assert.rejects(
    getRuntimeScript({ apiKeyId:'key-1', locationId:'location-1', serviceType:'Solar', scriptId:script.id }, pool),
    (error) => error.status === 404 && error.code === 'SONG_RUNTIME_NOT_FOUND'
  );
  const languageRuntime = await getRuntimeScript({
    apiKeyId:'key-1', locationId:'location-1', serviceType:'Roofing', languageCode:'en-US',
  }, pool);
  assert.equal(languageRuntime.languageCode, 'en-US');

  const event = await recordRuntimeEvent({
    apiKeyId:'key-1', locationId:'location-1', operatorUserId:'user-1',
    scriptId:runtime.scriptId, versionId:runtime.versionId,
    nodeId:'greeting', eventType:'node_viewed', metadata:{ token:'remove', visible:'yes' },
  }, pool);
  assert.equal(event.recorded, true);
  assert.equal(state.events.length, 1);
  assert.deepEqual(JSON.parse(state.events[0][10]), { visible:'yes' });

  const loaded = await getScript(script.id, { apiKeyId:'key-1', locationId:'location-1' }, pool);
  assert.equal(loaded.isAssigned, true);

  const routePool = {
    getConnection:pool.getConnection,
    query:async (sql, params) => {
      if (sql.includes('FROM api_operator_sessions s')) return [[{
        apiKeyId:'key-1', userId:'user-1', locationId:'location-1', isAdmin:0,
        expiresAt:'2026-07-12 18:30:00.000', username:'agent', crmUserName:'Agent',
      }]];
      if (sql.startsWith('UPDATE api_operator_sessions SET last_used_at')) return [{ affectedRows:1 }];
      if (sql.includes('COUNT(DISTINCT i.id)')) return [[{ integration_count:1, grant_count:1 }]];
      return pool.query(sql, params);
    },
  };
  setPool(routePool);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.apiKey = { id:'key-1' }; next(); });
  app.use('/api/song', createSongRuntimeRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/song`;
    const headers = { 'X-Operator-Token':'A'.repeat(43) };
    const runtimeResponse = await fetch(`${url}/runtime?serviceType=Roofing`, { headers });
    assert.equal(runtimeResponse.status, 200);
    assert.match(runtimeResponse.headers.get('cache-control'), /no-store/);
    const runtimeBody = await runtimeResponse.json();
    assert.equal(runtimeBody.runtime.versionId, runtime.versionId);
    const catalogResponse = await fetch(`${url}/scripts?serviceType=Roofing&languageCode=en-US&q=Intake&limit=10`, { headers });
    assert.equal(catalogResponse.status, 200);
    const catalogBody = await catalogResponse.json();
    assert.equal(catalogBody.scripts[0].scriptId, script.id);
    assert.equal(catalogBody.scripts[0].languageCode, 'en-US');
    assert.equal(Object.hasOwn(catalogBody.scripts[0], 'nodes'), false);
    const selectedResponse = await fetch(
      `${url}/runtime?serviceType=Roofing&languageCode=en-US&scriptId=${encodeURIComponent(script.id)}`,
      { headers }
    );
    assert.equal(selectedResponse.status, 200);
    assert.equal((await selectedResponse.json()).runtime.scriptId, script.id);
    const invalidSelectionResponse = await fetch(`${url}/runtime?serviceType=Roofing&scriptId=not-a-script-id`, { headers });
    assert.equal(invalidSelectionResponse.status, 400);
    assert.equal((await invalidSelectionResponse.json()).code, 'SONG_SCRIPT_ID_INVALID');
    const resolveResponse = await fetch(`${url}/runtime/resolve`, {
      method:'POST', headers:{ ...headers, 'Content-Type':'application/json' },
      body:JSON.stringify({ serviceType:'Roofing', languageCode:'en-US', runtimeContext:{ greeting:'Good evening', weatherSummary:'Clear, 78 F' } }),
    });
    assert.equal(resolveResponse.status, 200);
    const resolveBody = await resolveResponse.json();
    assert.equal(resolveBody.runtime.variableValues.agentName, 'agent');
    const eventResponse = await fetch(`${url}/events`, {
      method:'POST', headers:{ ...headers, 'Content-Type':'application/json' },
      body:JSON.stringify({
        scriptId:runtime.scriptId, versionId:runtime.versionId,
        nodeId:'greeting', eventType:'node_viewed',
      }),
    });
    assert.equal(eventResponse.status, 201);
    assert.deepEqual(await eventResponse.json(), { success:true, eventId:1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setPool(null);
  }
  const spanishScript = await createScript({
    apiKeyId:'key-1', locationId:'location-1', serviceType:'Roofing',
    languageCode:'es-US', name:'Techo - Alcance inicial',
  }, actor, pool);
  await publishScript(spanishScript.id, {
    apiKeyId:'key-1', locationId:'location-1', expectedRevision:1,
  }, actor, pool);
  assert.equal(state.serviceAssignmentWrites, 1);
  assert.equal(state.languageAssignment.languageCode, 'es-US');
  const unpublishedSpanishDraft = structuredClone(JSON.parse(state.script.draft_graph_json));
  unpublishedSpanishDraft.nodes[0].prompt = 'This unpublished draft must not enter the reclassified runtime.';
  state.script.draft_graph_json = JSON.stringify(unpublishedSpanishDraft);
  const reclassified = await changeScriptLanguage(spanishScript.id, {
    apiKeyId:'key-1', locationId:'location-1', languageCode:'fr-CA',
  }, actor, pool);
  assert.equal(reclassified.changed, true);
  assert.equal(reclassified.script.languageCode, 'fr-CA');
  assert.equal(reclassified.version.number, 3);
  assert.equal(state.languageAssignment.languageCode, 'fr-CA');
  const reclassifiedRuntime = JSON.parse(state.versions.at(-1).compiledJson);
  assert.equal(reclassifiedRuntime.languageCode, 'fr-CA');
  assert.equal(reclassifiedRuntime.nodes[0].prompt, JSON.parse(state.versions.at(-2).compiledJson).nodes[0].prompt);
  console.log('SONG tests passed');
}

run().catch((error) => {
  setPool(null);
  console.error(error);
  process.exitCode = 1;
});
