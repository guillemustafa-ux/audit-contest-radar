// One adapter per platform. Each returns a list of contests in a common shape:
//   { platform, id, name, prizePoolUsd, prizeLabel, startDate, endDate, stack, status, url, description }
// Dates are Date objects or null. prizePoolUsd is a Number or null.
//
// Design note: we deliberately do NOT whitelist "active" status strings. At the time this
// was written every platform was between contests, so the vocabulary for a live contest
// could not be observed. Whitelisting an unseen string would make the radar silently miss
// the very event it exists to catch. Liveness is derived from endDate instead, with a
// blacklist of known-terminal statuses as defence in depth.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html;q=0.9',
};

const TERMINAL_STATUSES = new Set([
  'finished', 'completed', 'complete', 'escalations_ended', 'reporting',
  'sherlock_judging', 'judging', 'ended', 'closed', 'evaluating', 'migrated',
]);

export function isTerminal(status) {
  return status ? TERMINAL_STATUSES.has(String(status).toLowerCase()) : false;
}

// A contest is live while there is still time to join it, judged by its end date (see the
// design note above). A bounty has no end date: its adapter flags it `ongoing` instead.
export function isLive(c, now = Date.now()) {
  if (isTerminal(c.status)) return false;
  if (c.ongoing) return true;
  const end = c.endDate instanceof Date ? c.endDate.getTime() : NaN;
  return Number.isFinite(end) && end > now;
}

const FETCH_TIMEOUT_MS = 25_000;

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// "$22,000 in USDC" / "80,000 USDC" / "2500000" -> 22000 / 80000 / 2500000
function parseAmount(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const m = String(raw).replace(/,/g, '').match(/[\d.]+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// Infer tech stack from free text when the platform does not label it.
const STACK_HINTS = [
  [/\bsolana\b|\banchor\b/i, 'Solana'],
  [/\brust\b/i, 'Rust'],
  [/\bcairo\b|\bstarknet\b/i, 'Cairo'],
  [/\bmove\b|\bsui\b|\baptos\b/i, 'Move'],
  [/\bcosmwasm\b|\bcosmos\b/i, 'CosmWasm'],
  [/\bvyper\b/i, 'Vyper'],
  [/\bsolidity\b|\bevm\b|\bfoundry\b|\berc-?20\b|\berc-?721\b/i, 'Solidity'],
];

function inferStack(...texts) {
  const blob = texts.filter(Boolean).join(' ');
  const found = STACK_HINTS.filter(([re]) => re.test(blob)).map(([, name]) => name);
  // Nothing matched: EVM/Solidity is the overwhelming default for these platforms,
  // but say so honestly rather than asserting it.
  return found.length ? [...new Set(found)] : ['Solidity?'];
}

// ---------------------------------------------------------------- Sherlock

// The public listing is sorted by prize pool, not by date, so a small new contest can sit
// past any fixed page count. The stats endpoint reports which statuses exist right now and
// every non-terminal one is listed in full: the statuses come from Sherlock, not from a
// whitelist here. Private contests are counted in the stats but never listed, so a
// non-terminal status can legitimately return no items. The first pages of the default
// listing are still read too: calibrate.mjs anchors its ground truth on the large finished
// contests there.
export function sherlockStatusesToQuery(stats) {
  if (!Array.isArray(stats)) return [];
  return stats.filter((s) => s.count > 0 && !isTerminal(s.status)).map((s) => s.status);
}

const SHERLOCK_MAX_PAGES = 20; // 10 per page; a guard against a has_next that never ends
const SHERLOCK_DEFAULT_PAGES = 3;

async function sherlock() {
  // Without stats, fall back to the default pages alone: the coverage this adapter had before.
  const stats = await getJson('https://audits.sherlock.xyz/api/contests/stats').catch(() => []);
  const queries = [
    ...sherlockStatusesToQuery(stats).map((s) => ({ filter: `status=${encodeURIComponent(s)}&`, pages: SHERLOCK_MAX_PAGES })),
    { filter: '', pages: SHERLOCK_DEFAULT_PAGES },
  ];
  const out = [];
  const seen = new Set();
  for (const { filter, pages } of queries) {
    for (let page = 1; page <= pages; page++) {
      const data = await getJson(`https://mainnet-contest.sherlock.xyz/contests?${filter}page=${page}`);
      for (const c of data?.items ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({
          platform: 'Sherlock',
          id: String(c.id),
          name: c.title ?? `contest ${c.id}`,
          prizePoolUsd: parseAmount(c.rewards ?? c.prize_pool),
          prizeLabel: c.prize_pool ? `$${Number(c.prize_pool).toLocaleString('en-US')} ${c.token ?? ''}`.trim() : null,
          startDate: c.starts_at ? new Date(c.starts_at * 1000) : null,
          endDate: c.ends_at ? new Date(c.ends_at * 1000) : null,
          stack: inferStack(c.title, c.short_description),
          status: c.status ?? null,
          url: `https://audits.sherlock.xyz/contests/${c.id}`,
          description: c.short_description ?? '',
        });
      }
      if (!data?.has_next) break;
    }
  }
  return out;
}

// ----------------------------------------------------------------- Cantina

async function cantina() {
  const data = await getJson('https://cantina.xyz/api/v0/competitions');
  const rows = Array.isArray(data) ? data : (Object.values(data).find(Array.isArray) ?? []);
  return rows.map((c) => ({
    platform: 'Cantina',
    id: String(c.id),
    name: c.name ?? c.company?.name ?? 'unnamed',
    prizePoolUsd: parseAmount(c.totalRewardPot),
    prizeLabel: c.totalRewardPot
      ? `$${Number(parseAmount(c.totalRewardPot)).toLocaleString('en-US')} ${c.currencyCode ?? ''}`.trim()
      : null,
    startDate: c.timeframe?.start ? new Date(c.timeframe.start) : null,
    endDate: c.timeframe?.end ? new Date(c.timeframe.end) : null,
    // instructions is often huge; only the head matters for stack inference.
    stack: inferStack(c.name, (c.instructions ?? '').slice(0, 4000)),
    status: c.status ?? null,
    url: c.url ?? `https://cantina.xyz/competitions/${c.id}`,
    description: (c.instructions ?? '').slice(0, 600),
    private: c.kind === 'private_contest',
  })).filter((c) => !c.private);
}

// -------------------------------------------------------- Cantina bounties
// A bounty has no end date: it stays open until the project closes it, so liveness cannot
// come from endDate. Only public bounties opened in the last BOUNTY_FRESH_DAYS (or about to
// open) are emitted, flagged `ongoing`; the alert dedup then reports each one once.

const BOUNTY_FRESH_DAYS = 7;

export function mapCantinaBounties(rows, now = Date.now()) {
  const since = now - BOUNTY_FRESH_DAYS * 86_400_000;
  return rows
    .filter((b) => b.kind === 'public_bounty' && !isTerminal(b.status))
    .map((b) => ({ b, opened: Date.parse(b.timeframe?.start ?? b.createdAt) }))
    .filter(({ opened }) => Number.isFinite(opened) && opened >= since)
    .map(({ b, opened }) => ({
      platform: 'Cantina bounty',
      id: String(b.id),
      name: b.name ?? b.company?.name ?? 'unnamed',
      prizePoolUsd: parseAmount(b.totalRewardPot),
      prizeLabel: b.totalRewardPot
        ? `$${Number(parseAmount(b.totalRewardPot)).toLocaleString('en-US')} ${b.currencyCode ?? ''}`.trim()
        : null,
      startDate: new Date(opened),
      endDate: null,
      ongoing: true,
      stack: inferStack(b.name, (b.instructions ?? '').slice(0, 4000)),
      status: b.status ?? null,
      url: b.url ?? `https://cantina.xyz/bounties/${b.id}`,
      description: (b.instructions ?? '').slice(0, 600),
    }));
}

async function cantinaBounties() {
  const data = await getJson('https://cantina.xyz/api/v0/bounties');
  const rows = Array.isArray(data) ? data : (Object.values(data).find(Array.isArray) ?? []);
  return mapCantinaBounties(rows);
}

// --------------------------------------------------------------- CodeHawks
// No public REST API (every /api/* endpoint returns HTTP 400). The listing page is
// SvelteKit and embeds the whole competitions tRPC response, real dates included, in a
// <script type="application/json" data-sveltekit-fetched> tag.

const CODEHAWKS_USD = /^(usdc|usdt|usd|dai)$/i;

export function parseCodehawksListing(html) {
  const tag = html.match(
    /<script type="application\/json" data-sveltekit-fetched data-url="[^"]*competitions\.getCompetitions[^"]*"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!tag) throw new Error('CodeHawks competitions payload not found — page markup may have changed');
  const rows = JSON.parse(JSON.parse(tag[1]).body)?.[0]?.result?.data;
  if (!Array.isArray(rows)) throw new Error('CodeHawks competitions payload has an unexpected shape');
  return rows.filter((c) => c.urlSlug && !c.inviteOnly).map((c) => {
    const reward = parseAmount(c.reward);
    return {
      platform: 'CodeHawks',
      id: c.urlSlug,
      name: c.name ?? c.urlSlug,
      // ETH prizes are not USD; leave the number out rather than compare apples to oranges.
      prizePoolUsd: CODEHAWKS_USD.test(c.currency ?? '') ? reward : null,
      prizeLabel: reward != null ? `${reward.toLocaleString('en-US')} ${(c.currency ?? '').toUpperCase()}`.trim() : null,
      startDate: c.startDate ? new Date(c.startDate) : null,
      endDate: c.endDate ? new Date(c.endDate) : null,
      stack: inferStack(c.protocolTags, c.name),
      status: null,
      url: `https://codehawks.cyfrin.io/c/${c.urlSlug}`,
      description: [c.company, c.protocolTags].filter(Boolean).join(' — '),
    };
  });
}

async function codehawks() {
  return parseCodehawksListing(await getText('https://codehawks.cyfrin.io/contests'));
}

// ---------------------------------------------------------------- Immunefi
// Audit competitions live in a Next.js App Router RSC payload. This is the most
// brittle source of the five, so failures here must never sink the run.
//
// Each competition is a JSON object starting with {"contentfulId":...,"slug":...}.
// We slice the payload per object so fields never leak from a neighbouring
// competition (a fixed +-N char window previously picked up the PREVIOUS
// contest's endDate and reported finished comps as live).

async function immunefi() {
  const html = await getText('https://immunefi.com/audit-competition/');
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)]
    .map((m) => m[1]).join('');
  const payload = chunks.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

  const starts = [...payload.matchAll(/\{"contentfulId":"[^"]+","slug":"([a-z0-9-]{4,})"/g)];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const slug = starts[i][1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : from + 4000;
    const obj = payload.slice(from, to);
    if (!/"endDate"|"launchDate"|"maxBounty"|"rewardsPool"/.test(obj)) continue;

    const field = (key) => obj.match(new RegExp(`"${key}":"([^"]*)"`))?.[1] ?? null;
    const num = (key) => obj.match(new RegExp(`"${key}":"?([\\d.]+)"?`))?.[1] ?? null;
    const list = (key) => (obj.match(new RegExp(`"${key}":\\[([^\\]]*)\\]`))?.[1] ?? '')
      .split(',').map((s) => s.replace(/"/g, '').trim()).filter(Boolean);

    const pot = num('rewardsPool') ?? num('maxBounty');
    const name = field('project')?.replace(/^Audit Comp(?:etition)?\s*\|\s*/i, '')
      ?? slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
    const start = field('launchDate');
    const end = field('endDate');
    const stackHint = [...list('language'), ...list('ecosystem'), ...list('technologies')].join(' ');

    out.push({
      platform: 'Immunefi',
      id: slug,
      name,
      prizePoolUsd: pot ? parseAmount(pot) : null,
      prizeLabel: pot ? `$${Number(parseAmount(pot)).toLocaleString('en-US')}` : null,
      startDate: start ? new Date(start) : null,
      endDate: end ? new Date(end) : null,
      stack: inferStack(stackHint || obj),
      status: field('auditCompetitionStatus'),
      url: `https://immunefi.com/audit-competition/${slug}/`,
      description: '',
    });
  }
  return out;
}

export const ADAPTERS = [
  { name: 'Sherlock', run: sherlock },
  { name: 'Cantina', run: cantina },
  { name: 'Cantina bounties', run: cantinaBounties },
  { name: 'CodeHawks', run: codehawks },
  { name: 'Immunefi', run: immunefi },
];

// Runs every adapter concurrently. A failing source is reported, never fatal:
// four working sources beat zero because one site changed its markup.
export async function fetchAll() {
  const settled = await Promise.allSettled(ADAPTERS.map((a) => a.run()));
  const contests = [];
  const errors = [];
  settled.forEach((res, i) => {
    const name = ADAPTERS[i].name;
    if (res.status === 'fulfilled') {
      contests.push(...res.value);
    } else {
      errors.push({ source: name, message: res.reason?.message ?? String(res.reason) });
    }
  });
  return { contests, errors };
}
