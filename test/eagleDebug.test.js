const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { listScheduleDebug, resetSchedule } = require('../src/services/eagleDebug');

const NOW = '2026-07-13T12:00:00Z';
const integration = { id:'integration-1', location_id:'location-1' };

async function run() {
  const listPool = {
    async query(sql) {
      if (sql.includes('FROM crm_integrations i')) return [[integration]];
      if (sql.includes('FROM users u')) return [[
        { userId:'user-1', username:'agent', crmUserName:'CRM Agent', crmUserId:'crm-1', scheduledMinutes:480, submittedAt:'2026-07-13 13:00:00.000', updatedAt:'2026-07-13 13:00:00.000', hasSchedule:1 },
        { userId:'user-2', username:'draft', scheduledMinutes:120, submittedAt:null, hasSchedule:1 },
        { userId:'user-3', username:'missing', scheduledMinutes:null, submittedAt:null, hasSchedule:0 },
      ]];
      if (sql.includes('FROM eagle_debug_actions')) return [[{
        id:'audit-1', actorUsername:'admin', action:'schedule_submission_cleared', userId:'user-1',
        reason:'Reproduce schedule defect', beforeJson:'{"state":"submitted"}', afterJson:'{"state":"draft"}', createdAt:'2026-07-13',
      }]];
      throw new Error(`Unexpected list query: ${sql}`);
    },
  };
  const listed = await listScheduleDebug({ integrationId:'integration-1', apiKeyId:'key-1', now:NOW }, listPool);
  assert.equal(listed.users[0].state, 'submitted');
  assert.equal(listed.users[1].state, 'draft');
  assert.equal(listed.users[2].state, 'missing');
  assert.equal(listed.actions[0].after.state, 'draft');

  const reopened = await performReset('submission_only');
  assert.ok(reopened.sql.some((value) => value.startsWith('UPDATE user_schedule_weeks')));
  assert.ok(!reopened.sql.some((value) => value.startsWith('DELETE FROM user_schedule_weeks')));
  assert.equal(reopened.result.before.state, 'submitted');
  assert.equal(reopened.result.after.state, 'draft');

  const cleared = await performReset('schedule_and_submission');
  assert.ok(cleared.sql.some((value) => value.startsWith('DELETE FROM user_schedule_weeks')));
  assert.ok(cleared.sql.some((value) => value.startsWith('DELETE FROM user_schedules')));
  assert.equal(cleared.result.after.state, 'missing');
  const audit = cleared.audits[0];
  assert.equal(audit[6], 'schedule_cleared');
  assert.doesNotMatch(audit[10], /scheduleData|monday|tuesday/i);
  assert.doesNotMatch(audit[11], /scheduleData|monday|tuesday/i);

  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'admin', 'eagle.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public', 'js', 'eagle-dashboard.js'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8');
  assert.match(html, /id="debugScheduleMode"/);
  assert.match(html, /Clear submission status/);
  assert.match(client, /function resetSchedule/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS eagle_debug_actions/);
  console.log('EAGLE schedule debug tests passed');
}

async function performReset(mode) {
  const sql = []; const audits = [];
  const conn = {
    async beginTransaction() { sql.push('BEGIN'); },
    async commit() { sql.push('COMMIT'); },
    async rollback() { sql.push('ROLLBACK'); },
    release() { sql.push('RELEASE'); },
    async query(statement, params) {
      const normalized = statement.trim(); sql.push(normalized);
      if (normalized.startsWith('SELECT id,username,crmUserName FROM users')) return [[{ id:'user-1', username:'agent', crmUserName:'CRM Agent' }]];
      if (normalized.startsWith('SELECT scheduledMinutes,submittedAt,updatedAt FROM user_schedule_weeks')) return [[{ scheduledMinutes:480, submittedAt:'2026-07-13 13:00:00.000', updatedAt:'2026-07-13 12:00:00.000' }]];
      if (normalized.startsWith('SELECT updatedAt FROM user_schedules')) return [[{ updatedAt:'2026-07-13' }]];
      if (normalized.startsWith('INSERT INTO eagle_debug_actions')) { audits.push(params); return [{ affectedRows:1 }]; }
      if (/^(UPDATE|DELETE)/.test(normalized)) return [{ affectedRows:1 }];
      throw new Error(`Unexpected reset query: ${normalized}`);
    },
  };
  const pool = {
    async query(statement) {
      if (statement.includes('FROM crm_integrations i')) return [[integration]];
      throw new Error(`Unexpected authorization query: ${statement}`);
    },
    async getConnection() { return conn; },
  };
  const result = await resetSchedule({
    integrationId:'integration-1', apiKeyId:'key-1', userId:'user-1', mode,
    reason:'Reproduce schedule defect', now:NOW,
  }, { id:'admin-1', username:'root-admin' }, pool);
  assert.ok(sql.includes('COMMIT'));
  assert.ok(!sql.includes('ROLLBACK'));
  assert.equal(audits.length, 1);
  return { result, sql, audits };
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
