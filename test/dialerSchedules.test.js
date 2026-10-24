const assert = require('assert/strict');
const {
  getScheduleWeek,
  calculateScheduledMinutes,
  normalizeScheduleData,
  assertWeeklyScheduleSubmitted,
} = require('../src/services/dialerSchedules');

async function run() {
  const summerWeek = getScheduleWeek(new Date('2026-07-11T18:00:00Z'));
  assert.equal(summerWeek.weekStart, '2026-07-06');
  assert.equal(summerWeek.weekEnd, '2026-07-12');
  assert.equal(summerWeek.deadlineAt, '2026-07-06T04:00:00.000Z');
  assert.equal(summerWeek.timeZone, 'America/New_York');

  const nextWeek = getScheduleWeek(new Date('2026-07-13T04:00:00Z'));
  assert.equal(nextWeek.weekStart, '2026-07-13');

  const winterWeek = getScheduleWeek(new Date('2026-01-07T18:00:00Z'));
  assert.equal(winterWeek.deadlineAt, '2026-01-05T05:00:00.000Z');

  assert.equal(calculateScheduledMinutes({
    days: {
      monday: { start: '09:00', end: '17:00', breakMinutes: 30 },
      tuesday: [{ start: '18:00', end: '22:00' }],
      friday: { start: '22:00', end: '02:00' },
    },
  }), 930);
  assert.equal(calculateScheduledMinutes({ totalHours: 32.5 }), 1950);
  assert.throws(() => normalizeScheduleData('not-json'), (error) => error.status === 400);
  assert.throws(() => normalizeScheduleData([]), (error) => error.status === 400);

  let scheduleRow = null;
  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM users WHERE id = ?')) return [[{ id: 'user-1' }]];
      if (sql.includes('FROM user_schedule_weeks')) return [[scheduleRow].filter(Boolean)];
      throw new Error(`Unexpected schedule query: ${sql}`);
    },
  };
  await assert.rejects(
    () => assertWeeklyScheduleSubmitted(pool, {
      locationId: 'location-1', userId: 'user-1', now: new Date('2026-07-11T18:00:00Z'),
    }),
    (error) => error.status === 409 && error.code === 'WEEKLY_SCHEDULE_REQUIRED' && error.schedule.state === 'missing'
  );
  scheduleRow = { userId: 'user-1', scheduleData: '{}', submittedAt: null };
  await assert.rejects(
    () => assertWeeklyScheduleSubmitted(pool, {
      locationId: 'location-1', userId: 'user-1', now: new Date('2026-07-11T18:00:00Z'),
    }),
    (error) => error.schedule.state === 'draft'
  );
  scheduleRow.submittedAt = '2026-07-05 22:00:00.000';
  const compliant = await assertWeeklyScheduleSubmitted(pool, {
    locationId: 'location-1', userId: 'user-1', now: new Date('2026-07-11T18:00:00Z'),
  });
  assert.equal(compliant.row.userId, 'user-1');

  console.log('Dialer schedule tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
