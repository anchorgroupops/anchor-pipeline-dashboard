#!/usr/bin/env node
/**
 * scripts/fub-refresh.mjs
 * Fetches all contacts from Follow Up Boss, aggregates server-side (no PII),
 * and hot-swaps the const D={...} block in index.html. Runs via GitHub Actions.
 *
 * Requires: FUB_API_KEY env var  (GitHub Secret: Settings → Secrets → Actions)
 * Node 18+  (built-in fetch + top-level await via .mjs ESM)
 *
 * PRIVACY: Raw contact data (names, phones, addresses) is never written to disk
 * or committed. Only team-member names + aggregated counts/values reach the HTML.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const API_KEY = process.env.FUB_API_KEY;
if (!API_KEY) { console.error('ERROR: FUB_API_KEY env var not set'); process.exit(1); }

const FUB_BASE = 'https://api.followupboss.com/v1';
const AUTH_HDR = 'Basic ' + Buffer.from(API_KEY + ':').toString('base64');
const HEADERS  = { Authorization: AUTH_HDR, 'X-System': 'AnchorGroupDashboard/1.0' };

// Stage → CSS class map (matches .fn-fill classes in index.html)
const STAGE_CLASS = {
  'Nurture': 's0',           'Lead': 's1',              'Attempted Contact': 's2',
  'Spoke w/ Customer': 's3', 'Appointment Set': 's4',   'Met w/ Customer': 's5',
  'Showing Homes': 's6',     'Submitting Offers': 's7', 'Under Contract': 's8',
  'Active Listing': 's9',    'Listing Agreement': 's10','Closed': 's11'
};
const STAGE_ORDER = Object.keys(STAGE_CLASS);
const SR_STAGES   = ['Closed', 'Under Contract', 'Nurture', 'Active Listing', 'Showing Homes'];
const TF_ORDER    = ['0-3 Months', '3-6 Months', '6-12 Months', '12+ Months', 'No Plans'];

// ─── FUB API ──────────────────────────────────────────────────────────────────
async function fubGet(endpoint) {
  const res = await fetch(FUB_BASE + endpoint, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FUB API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchAllPeople() {
  const all = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data  = await fubGet(`/people?limit=${limit}&offset=${offset}&sort=id`);
    const batch = data.people ?? [];
    all.push(...batch);
    const total = data._metadata?.total ?? '?';
    process.stderr.write(`  people: ${all.length}/${total}    \r`);
    if (batch.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 120)); // ~8 req/s — FUB allows 25 req/s burst
  }
  console.error(`\nFetched ${all.length} total people`);
  return all;
}

// ─── Aggregate (no raw PII — only team-member names + aggregated values) ──────
function getCustomField(person, nameFragment) {
  return (person.customFields ?? []).find(f =>
    (f.name ?? f.label ?? '').toLowerCase().includes(nameFragment.toLowerCase())
  )?.value ?? null;
}

function aggregate(people) {
  const stageCounts = {}, stageRevenue = {};
  const agentMap   = {}, sourceMap = {}, tfMap = {}, clMap = {}, lkMap = {};

  for (const p of people) {
    const stage     = (p.stage ?? 'Unknown').trim();
    const agent     = (typeof p.assignedTo === 'string' ? p.assignedTo : '').trim() || 'Unassigned';
    const price     = parseFloat(p.price) || 0;
    const source    = (p.source ?? 'Unknown').trim() || 'Unknown';
    const contacted = p.contacted === true;
    const tf        = getCustomField(p, 'Timeframe') ?? getCustomField(p, 'Purchase Timeframe');
    const createdYM = p.createdAt   ? p.createdAt.slice(0, 7)   : null;  // YYYY-MM
    const closeYM   = p.closingDate ? p.closingDate.slice(0, 7) : null;

    // Global tallies
    stageCounts[stage]  = (stageCounts[stage]  || 0) + 1;
    if (price > 0) stageRevenue[stage] = (stageRevenue[stage] || 0) + price;
    sourceMap[source] = (sourceMap[source] || 0) + 1;
    if (tf)        tfMap[tf]        = (tfMap[tf]        || 0) + 1;
    if (createdYM) lkMap[createdYM] = (lkMap[createdYM] || 0) + 1;

    // Closing month: prefer closingDate field; fall back for stage=Closed
    const effectiveClose = closeYM ?? (stage === 'Closed' ? createdYM : null);
    if (effectiveClose) clMap[effectiveClose] = (clMap[effectiveClose] || 0) + 1;

    // Per-agent (team member names intentional — no client PII)
    if (agent === 'Unassigned') continue;
    if (!agentMap[agent]) agentMap[agent] = {
      tl: 0, contacted: 0, cd: 0, cv: 0, apv: 0,
      uc: 0, show: 0, nurt: 0, atmp: 0, src: {}
    };
    const a = agentMap[agent];
    a.tl++;
    if (contacted) a.contacted++;
    if (stage === 'Closed')            { a.cd++; if (price > 0) a.cv += price; }
    else if (price > 0)                  a.apv += price;
    if (stage === 'Under Contract')      a.uc++;
    if (stage === 'Showing Homes')       a.show++;
    if (stage === 'Nurture')             a.nurt++;
    if (stage === 'Attempted Contact')   a.atmp++;
    a.src[source] = (a.src[source] || 0) + 1;
  }

  return { stageCounts, stageRevenue, agentMap, sourceMap, tfMap, clMap, lkMap };
}

// ─── Build D object (exact shape expected by index.html charts/tables) ────────
function buildD({ stageCounts, stageRevenue, agentMap, sourceMap, tfMap, clMap, lkMap }) {
  // D.ag — agents sorted by active pipeline value
  const ag = Object.entries(agentMap).map(([name, a]) => ({
    n:     name,
    tl:    a.tl,
    cr:    a.tl > 0 ? +(a.contacted / a.tl * 100).toFixed(1) : 0,
    cd:    a.cd,
    cv:    Math.round(a.cv),
    apv:   Math.round(a.apv),
    uc:    a.uc,
    show:  a.show,
    nurt:  a.nurt,
    atmp:  a.atmp,
    calls: 0,  // not available via FUB REST API (comes from call-integration webhooks)
    texts: 0,  // same — zeroed so swAnalysis guard skips the Low Logged Activity check
    avgpx: a.cd > 0 ? Math.round(a.cv / a.cd) : 0,
    src:   Object.entries(a.src).sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'Unknown'
  })).sort((a, b) => b.apv - a.apv);

  // D.st — stage funnel
  const knownSt = STAGE_ORDER
    .filter(n => stageCounts[n])
    .map(n => ({ n, c: stageCounts[n], s: STAGE_CLASS[n] }));
  const otherSt = Object.entries(stageCounts)
    .filter(([n]) => !STAGE_ORDER.includes(n) && n !== 'Unknown')
    .map(([n, c]) => ({ n, c, s: 's0' }))
    .sort((a, b) => b.c - a.c);
  const st = [...knownSt, ...otherSt].sort((a, b) => b.c - a.c);

  // D.sr — revenue by stage
  const srL = [], srV = []; let srOther = 0;
  for (const s of SR_STAGES)
    if (stageRevenue[s]) { srL.push(s); srV.push(Math.round(stageRevenue[s])); }
  for (const [s, v] of Object.entries(stageRevenue))
    if (!SR_STAGES.includes(s)) srOther += v;
  if (srOther > 0) { srL.push('Other'); srV.push(Math.round(srOther)); }

  // D.ls — lead sources (top 4 + Other)
  const lsSorted = Object.entries(sourceMap).sort((a, b) => b[1] - a[1]);
  const lsL = [], lsV = []; let lsOther = 0;
  lsSorted.forEach(([l, v], i) => i < 4 ? (lsL.push(l), lsV.push(v)) : (lsOther += v));
  if (lsOther > 0) { lsL.push('Other'); lsV.push(lsOther); }

  // D.tf — buyer readiness timeframe
  const tfL = [], tfV = [];
  for (const l of TF_ORDER) if (tfMap[l]) { tfL.push(l); tfV.push(tfMap[l]); }
  for (const [l, v] of Object.entries(tfMap))
    if (!TF_ORDER.includes(l)) { tfL.push(l); tfV.push(v); }

  // Rolling month windows — always relative to run date
  function rollingMonths(count) {
    const now = new Date();
    const labels = [], keys = [];
    for (let i = count - 1; i >= 0; i--) {
      const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
      const lbl = d.toLocaleString('en-US', { month:'short', timeZone:'UTC' }).slice(0,3)
                + String(d.getUTCFullYear()).slice(2);
      keys.push(key); labels.push(lbl);
    }
    return { labels, keys };
  }
  const cl18 = rollingMonths(18);
  const lk30 = rollingMonths(30);

  return {
    ag, st,
    sr: { l: srL, v: srV },
    ls: { l: lsL, v: lsV },
    tf: { l: tfL, v: tfV },
    cl: { lb: cl18.labels, d: cl18.keys.map(k => clMap[k] || 0) },
    lk: { lb: lk30.labels, d: lk30.keys.map(k => lkMap[k] || 0) }
  };
}

// ─── Inject into index.html ───────────────────────────────────────────────────
function updateHtml(D, totalPeople) {
  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  const START = '// <!--DATA_START-->';
  const END   = '// <!--DATA_END-->';

  // First run: auto-inject sentinel markers around existing const D={...} block
  if (!html.includes(START) || !html.includes(END)) {
    console.error('DATA markers not found — injecting for first time...');
    html = html.replace('<script>\nconst D=', `<script>\n${START}\nconst D=`);
    html = html.replace('\n};\nconst COL=',  `\n};\n${END}\nconst COL=`);
    if (!html.includes(START)) throw new Error('Auto-inject failed: DATA_START not found after substitution');
    if (!html.includes(END))   throw new Error('Auto-inject failed: DATA_END not found after substitution');
  }

  // Guard calls/texts check in swAnalysis — zeroed API values must not false-flag everyone
  html = html.replace(
    'if((a.calls+a.texts)<15&&a.tl>=30)',
    'if(a.calls>0&&(a.calls+a.texts)<15&&a.tl>=30)'
  );

  // Build and splice in the new data block
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'
  });
  const block = [
    START,
    `// Auto-refreshed ${dateStr} — ${totalPeople.toLocaleString()} contacts — no PII stored`,
    `const D=${JSON.stringify(D)};`,
    END
  ].join('\n');

  const si = html.indexOf(START);
  const ei = html.indexOf(END);
  html = html.slice(0, si) + block + html.slice(ei + END.length);

  // Update sidebar footer date + counts
  html = html.replace(
    /<strong>[^<]+ Export<\/strong>[^<]+ contacts &middot; [0-9]+ agents/,
    `<strong>${dateStr} Export</strong>${totalPeople.toLocaleString()} contacts &middot; ${D.ag.length} agents`
  );

  // Update topbar subtitle
  html = html.replace(
    /Owner View &middot; [^<"]+/,
    `Owner View · ${dateStr}`
  );

  // Update page footer
  html = html.replace(
    /Pipeline Dashboard &middot; [^&]+&middot;/,
    `Pipeline Dashboard · ${dateStr} ·`
  );

  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`✓ index.html updated — ${totalPeople.toLocaleString()} contacts, ${D.ag.length} agents, ${dateStr}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.error('→ Fetching all people from Follow Up Boss...');
const people = await fetchAllPeople();

console.error('→ Aggregating metrics (no PII)...');
const agg = aggregate(people);
const D   = buildD(agg);

// Sanity checks — refuse to overwrite dashboard with empty/failed data
if (D.ag.length === 0) { console.error('ERROR: 0 agents found — aborting to protect dashboard'); process.exit(1); }
if (D.st.length === 0) { console.error('ERROR: 0 stages found — aborting to protect dashboard'); process.exit(1); }

console.error(`→ Agents: ${D.ag.length} | Stages: ${D.st.length} | Sources: ${D.ls.l.length} | TF buckets: ${D.tf.l.length}`);
updateHtml(D, people.length);
