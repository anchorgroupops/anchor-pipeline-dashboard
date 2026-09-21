/**
 * scripts/rolling-months.mjs
 * Builds the { labels, keys } used to bucket FUB records into the last
 * N calendar months for the closings (cl) and leads (lk) charts.
 *
 * Extracted from fub-refresh.mjs's buildD() so it can be unit tested in
 * isolation (buildD/fetchAllPeople have side effects — network calls,
 * process.exit — that make the whole module unsafe to import directly).
 */

export function rollingMonths(count, referenceDate = new Date()) {
  // Anchor bucketing to the America/New_York calendar month — the same
  // timezone used to format the dashboard's displayed "as of" export date —
  // instead of raw UTC getters. ET is UTC-4/-5, so near a day (or, on the
  // 1st, month) rollover, UTC can already be in the next month while it is
  // still the prior calendar month in ET, making the newest bucket disagree
  // with the export date shown alongside it.
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(referenceDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const etYear = Number(etParts.year);
  const etMonth = Number(etParts.month) - 1; // 0-indexed, matches getUTCMonth()

  const labels = [];
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(etYear, etMonth - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const lbl = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).slice(0, 3)
      + String(d.getUTCFullYear()).slice(2);
    keys.push(key);
    labels.push(lbl);
  }
  return { labels, keys };
}

/**
 * The YYYY-MM bucket key for a single FUB timestamp, in the same
 * America/New_York calendar month rollingMonths() keys its buckets by.
 *
 * FUB returns createdAt as a UTC instant, so slicing YYYY-MM off it straight
 * files anything created after 19:00/20:00 ET into next month — and drops it
 * entirely when the newest ET bucket has not rolled over yet. Date-only
 * fields (closingDate) carry no instant to convert and are already local, so
 * they are sliced as-is.
 */
export function monthKey(value) {
  if (!value) return null;
  if (!String(value).includes('T')) return String(value).slice(0, 7);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(d).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}`;
}
