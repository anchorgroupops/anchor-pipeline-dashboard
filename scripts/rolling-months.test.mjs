import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingMonths, monthKey } from './rolling-months.mjs';

// The dashboard's "as of" export date (shown in the footer) is formatted in
// America/New_York. The GitHub Actions cron runs at 06:00 ET so this never
// bites in production, but a manual `workflow_dispatch` run late in the
// evening ET on the last day of a month exposes the bug: UTC has already
// rolled into the next day (and, on the 1st-of-month boundary, the next
// month), so the newest rolling-month bucket disagrees with the ET calendar
// month the export date actually reports.
test('newest rolling-month bucket matches the ET calendar month, not UTC', () => {
  // 2026-01-31 23:30 America/New_York (EST, UTC-5) == 2026-02-01 04:30 UTC.
  const lateJan31Et = new Date('2026-02-01T04:30:00Z');

  const { keys } = rollingMonths(3, lateJan31Et);

  assert.strictEqual(keys[keys.length - 1], '2026-01');
});

// FUB returns createdAt as a UTC instant. ET is UTC-4/-5, so a contact created
// in the last few hours of an ET month carries a UTC timestamp already in the
// next month — and rollingMonths keys its buckets by the ET month.
test('monthKey buckets a late-ET-evening createdAt into the ET month', () => {
  // 2026-01-31 22:00 America/New_York (EST, UTC-5) == 2026-02-01 03:00 UTC.
  assert.strictEqual(monthKey('2026-02-01T03:00:00Z'), '2026-01');
});

test('monthKey agrees with the rolling-month bucket list on the normal cron run', () => {
  // GitHub Actions cron fires 06:00 ET on 1 Feb 2026 == 11:00 UTC.
  const { keys } = rollingMonths(30, new Date('2026-02-01T11:00:00Z'));
  const key = monthKey('2026-02-01T03:00:00Z');

  assert.strictEqual(key, '2026-01');
  assert.ok(keys.includes(key));
});

test('monthKey keeps a late-month manual dispatch inside the bucket list', () => {
  // 2026-01-31 23:30 ET — the newest ET bucket has not rolled to Feb yet, so a
  // UTC-derived '2026-02' key would fall outside keys and drop the contact.
  const { keys } = rollingMonths(30, new Date('2026-02-01T04:30:00Z'));

  assert.ok(keys.includes(monthKey('2026-02-01T03:00:00Z')));
});

test('monthKey slices date-only values as-is and passes through empties', () => {
  // closingDate carries no instant to convert; it is already a local calendar date.
  assert.strictEqual(monthKey('2026-02-01'), '2026-02');
  assert.strictEqual(monthKey(null), null);
  assert.strictEqual(monthKey(''), null);
});
