import test from 'node:test';
import assert from 'node:assert/strict';
import { addScheduleTime, localDateTimeValue, parseLocalDateTime, scheduleDuration, scheduleErrors } from '../../src/core/tournamentSchedule.ts';

test('schedule rejects missing or impossible dates instead of silently normalizing them', () => {
  for (const value of ['', 'invalid', '2026-02-31T08:00', '2026-02-29T08:00', '2026-10-29T24:15']) assert.equal(parseLocalDateTime(value), null);
  assert.equal(localDateTimeValue(parseLocalDateTime('2028-02-29T23:45')), '2028-02-29T23:45');
});

test('quick scheduling crosses midnight and year boundaries', () => {
  assert.equal(addScheduleTime('2026-12-31T23:45', 1), '2027-01-01T23:45');
  assert.equal(addScheduleTime('2027-01-01T23:45', 0, 30), '2027-01-02T00:15');
  assert.equal(addScheduleTime('', 1), '');
  assert.equal(scheduleDuration('2026-12-31T23:45', '2027-01-02T00:15'), '1 ngày 30 phút');
});

test('registration and preparation each require at least 24 hours', () => {
  assert.deepEqual(scheduleErrors('2026-10-29T08:00', '2026-10-30T08:00', '2026-10-31T08:00'), {opens:'',closes:'',starts:''});
  assert.ok(scheduleErrors('2026-10-29T08:00', '2026-10-30T07:59', '2026-10-31T08:00').closes);
  assert.ok(scheduleErrors('2026-10-29T08:00', '2026-10-30T08:00', '2026-10-31T07:59').starts);
  assert.ok(scheduleErrors('2026-10-29T08:00', '2026-10-29T08:00', '2026-10-29T09:00').closes);
  assert.ok(scheduleErrors('2026-10-29T08:00', '2026-10-29T09:00', '2026-10-29T09:00').starts);
  assert.ok(scheduleErrors('', '2026-10-29T09:00', '2026-10-29T10:00').opens);
});
