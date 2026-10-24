const assert = require('assert');
const {
  DEFAULT_SERVICE_POOLS,
  matchServiceType,
  classifyLeadRecord,
  normalizeServicePool,
  normalizeCalendarIds,
  selectServiceCalendar,
} = require('../src/services/servicePools');

assert.deepStrictEqual(DEFAULT_SERVICE_POOLS, []);
const configuredPools = [
  normalizeServicePool('Research', {tagKeywords: ['research']}),
  normalizeServicePool('Other', {tagKeywords: [], isFallback: true}),
];
assert.strictEqual(matchServiceType(['RESEARCH'], configuredPools), 'Research');
assert.strictEqual(matchServiceType(['unknown'], configuredPools), 'Other');
assert.strictEqual(classifyLeadRecord({ firstName: 'A' }, DEFAULT_SERVICE_POOLS, 'Legacy Service'), 'Legacy Service');
assert.throws(() => normalizeServicePool('Empty', { tagKeywords: [] }), /require at least one tag keyword/);
assert.strictEqual(normalizeServicePool('Fallback', { tagKeywords: [], isFallback: true }).isFallback, true);
assert.throws(() => normalizeServicePool('Fallback', { tagKeywords: [], isFallback: true, isEnabled: false }), /must remain enabled/);
assert.deepStrictEqual(normalizeCalendarIds('cal-roof, cal-backup, cal-roof'), ['cal-roof', 'cal-backup']);
const calendarPool = normalizeServicePool('Roofing', {
  tagKeywords: ['roof'], calendarIds: ['cal-primary', 'cal-backup'], defaultCalendarId: 'cal-primary',
});
assert.deepStrictEqual(calendarPool.calendarIds, ['cal-primary', 'cal-backup']);
assert.strictEqual(calendarPool.defaultCalendarId, 'cal-primary');
assert.throws(() => normalizeServicePool('Roofing', {
  tagKeywords: ['roof'], calendarIds: ['cal-primary'], defaultCalendarId: 'cal-other',
}), /must be included/);
assert.strictEqual(selectServiceCalendar(calendarPool), 'cal-primary');
assert.strictEqual(selectServiceCalendar(calendarPool, 'cal-backup'), 'cal-backup');
assert.throws(() => selectServiceCalendar(calendarPool, 'cal-solar'), /not assigned/);
assert.throws(() => selectServiceCalendar(null, 'cal-primary'), /cannot be validated/);

console.log('servicePools tests passed');
