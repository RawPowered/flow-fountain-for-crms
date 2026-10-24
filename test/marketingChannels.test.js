const assert = require('assert/strict');
const {
  classifyMarketingChannels,
  applyMarketingChannelStatus,
  classifyDncScreening,
} = require('../src/services/crmImporter');

async function run() {
  const emailOnly = classifyMarketingChannels({ email:'lead@example.com', tags:[] });
  assert.deepEqual(
    [emailOnly.phoneStatus, emailOnly.emailStatus, emailOnly.smsStatus],
    ['unavailable', 'available', 'unavailable']
  );

  const split = classifyMarketingChannels({
    phone:'8135550100', email:'lead@example.com', tags:['DND Phone', 'DND Email'],
  });
  assert.deepEqual(
    [split.phoneStatus, split.emailStatus, split.smsStatus],
    ['blocked', 'blocked', 'available']
  );
  assert.equal(classifyDncScreening({ phone:'8135550100', tags:['DND Phone'] }).state, 'blocked');

  const rules = [
    { poolKey:'no_phone', destinationStatus:'no_phone', statusValues:['no_phone'], isEnabled:true },
    { poolKey:'dnc_pending', destinationStatus:'dnc_pending', statusValues:['dnc_pending'], isEnabled:true },
    { poolKey:'dnc', destinationStatus:'do_not_call', statusValues:['do_not_call'], isEnabled:true },
  ];
  const writes = [];
  const conn = { query:async (sql, params) => { writes.push({ sql, params }); return [{ affectedRows:1 }]; } };

  await applyMarketingChannelStatus(conn, 'lead-email', 'location-1', {
    email:'lead@example.com', tags:[],
  }, rules);
  const noPhoneWrite = writes.find((entry) => entry.params?.[0] === 'no_phone');
  assert.ok(noPhoneWrite, 'missing-phone contacts should enter the No Phone lifecycle pool');
  assert.match(noPhoneWrite.sql, /dncResultCode = 'PHONE'/);
  assert.equal(writes[0].params[3], 'available');
  assert.equal(writes[0].params[4], 'unavailable');

  writes.length = 0;
  await applyMarketingChannelStatus(conn, 'lead-restored', 'location-1', {
    phone:'8135550100', email:'lead@example.com', tags:['DND Email'],
  }, rules);
  const restoredWrite = writes.find((entry) => entry.params?.[0] === 'dnc_pending');
  assert.ok(restoredWrite, 'restored phones should return to DNC Screening');
  assert.match(restoredWrite.sql, /status IN/);
  assert.match(restoredWrite.sql, /DNC scrub required/);

  writes.length = 0;
  await applyMarketingChannelStatus(conn, 'lead-dnd-phone', 'location-1', {
    phone:'8135550100', email:'lead@example.com', tags:['DND Phone'],
  }, rules);
  const phoneBlockedWrite = writes.find((entry) => entry.params?.[0] === 'do_not_call');
  assert.ok(phoneBlockedWrite, 'DND Phone should block only the phone lifecycle');
  assert.match(phoneBlockedWrite.sql, /dncResultCode = 'DND_PH'/);
  assert.equal(writes[0].params[3], 'available');
  assert.equal(writes[0].params[4], 'available');

  console.log('Marketing channel routing tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
