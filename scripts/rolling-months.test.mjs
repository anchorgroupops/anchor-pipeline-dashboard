import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollingMonths } from './rolling-months.mjs';

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
