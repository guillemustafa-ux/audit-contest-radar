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
  'sherlock_judging', 'judging', 'ended', 'closed',
]);

export function isTerminal(status) {
  return status ? TERMINAL_STATUSES.has(String(status).toLowerCase()) : false;
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

async function sherlock() {
  const out = [];
  // Paginated, 10 per page. Live and upcoming contests surface on the first pages;
  // 3 pages is a wide margin over anything actionable.
  for (let page = 1; page <= 3; page++) {
    const data = await getJson(`https://mainnet-contest.sherlock.xyz/contests?page=${page}`);
    const items = data?.items ?? [];
    for (const c of items) {
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
  return out;
}

// --------------------------------------------------------------- Code4rena

async function code4rena() {
  const out = [];
  // 25 per page, sorted newest-first. Two pages covers anything live or upcoming.
  for (let page = 1; page <= 2; page++) {
    const data = await getJson(`https://code4rena.com/api/v1/audits?page=${page}`);
    // The payload nests the list as data.audits. Fall back to any array under data
    // so a key rename degrades into a warning rather than a silently empty source.
    const rows = data?.data?.audits
      ?? (Array.isArray(data?.data) ? data.data : Object.values(data?.data ?? {}).find(Array.isArray))
      ?? [];
    if (!rows.length && page === 1) throw new Error('Code4rena returned no rows — payload shape may have changed');
    for (const c of rows) {
      out.push({
        platform: 'Code4rena',
        id: String(c.contestId ?? c.uid ?? c.slug),
        name: c.title ?? c.slug,
        prizePoolUsd: parseAmount(c.formattedAmount),
        prizeLabel: c.formattedAmount ?? null,
        startDate: c.startTime ? new Date(c.startTime) : null,
        endDate: c.endTime ? new Date(c.endTime) : null,
        stack: inferStack(c.title, c.details, c.repo, c.league),
        status: c.status ?? null,
        url: c.slug ? `https://code4rena.com/audits/${c.slug}` : 'https://code4rena.com/audits',
        description: c.details ?? '',
      });
    }
    if (!data?.pagination?.nextPage) break;
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

// --------------------------------------------------------------- CodeHawks
// No public API (every /api/* endpoint returns HTTP 400). The listing page is
// server-rendered HTML, and usefully labels the tech stack as tags.

const CODEHAWKS_TAGS = [
  'Solidity', 'Foundry', 'Rust', 'Cairo', 'Starknet', 'Solana', 'Move', 'Vyper',
  'Layer 2', 'DeFi', 'NFT', 'Staking', 'Bridge', 'Oracle', 'AMM', 'Lending',
];

// How far back a slug's YYYY-MM prefix may be and still plausibly be running.
// CodeHawks contests run 3-4 weeks, so two months is a generous margin.
const CODEHAWKS_RECENT_MONTHS = 2;

async function codehawks() {
  const html = await getText('https://codehawks.cyfrin.io/contests');
  const out = [];
  const seen = new Set();

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CODEHAWKS_RECENT_MONTHS);

  // Each contest links to /c/<slug>. Take the surrounding markup as its card.
  for (const m of html.matchAll(/href="(\/c\/([^"?#]+))"/g)) {
    const slug = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);

    // The listing is the full historical archive with no dates or status in the
    // markup, so the slug prefix is the only liveness signal available. Without
    // this filter the radar reports every contest since 2023 as "new".
    const dateMatch = slug.match(/^(\d{4})-(\d{2})-/);
    if (!dateMatch) continue;
    const slugDate = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, 1);
    if (slugDate < cutoff) continue;

    const card = html.slice(Math.max(0, m.index - 6000), m.index + 6000);
    const text = card.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

    const amount = text.match(/([\d,]+(?:\.\d+)?)\s*(USDC|USD|ETH|DAI)\b/i);
    const stack = CODEHAWKS_TAGS.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(text));

    // Slugs look like "2026-04-protocol-name"; recover a readable title.
    const name = slug.replace(/^\d{4}-\d{2}-/, '').replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (ch) => ch.toUpperCase());

    let prizePoolUsd = amount ? parseAmount(amount[1]) : null;
    // ETH prizes are not USD; leave the number out rather than compare apples to oranges.
    if (amount && /ETH/i.test(amount[2])) prizePoolUsd = null;

    out.push({
      platform: 'CodeHawks',
      id: slug,
      name,
      prizePoolUsd,
      prizeLabel: amount ? `${amount[1]} ${amount[2].toUpperCase()}` : null,
      startDate: slugDate,
      endDate: null, // not exposed in the listing markup
      stack: stack.length ? stack : inferStack(text),
      status: null,
      url: `https://codehawks.cyfrin.io${m[1]}`,
      description: text.slice(0, 400),
      datesUnknown: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Immunefi
// Audit competitions live in a Next.js App Router RSC payload. This is the most
// brittle source of the five, so failures here must never sink the run.

async function immunefi() {
  const html = await getText('https://immunefi.com/audit-competition/');
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)]
    .map((m) => m[1]).join('');
  const payload = chunks.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

  const out = [];
  const seen = new Set();
  // Look for objects carrying an audit-competition slug alongside a date.
  for (const m of payload.matchAll(/"slug":"([a-z0-9-]{4,})"/g)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const ctx = payload.slice(Math.max(0, m.index - 1200), m.index + 1200);
    if (!/endDate|startDate|maxBounty|reward/i.test(ctx)) continue;

    const end = ctx.match(/"endDate":"([^"]+)"/);
    const start = ctx.match(/"startDate":"([^"]+)"/);
    const pot = ctx.match(/"(?:maxBounty|rewardPool|totalRewards?)":"?([\d.]+)"?/i);
    const name = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

    out.push({
      platform: 'Immunefi',
      id: slug,
      name,
      prizePoolUsd: pot ? parseAmount(pot[1]) : null,
      prizeLabel: pot ? `$${Number(parseAmount(pot[1])).toLocaleString('en-US')}` : null,
      startDate: start ? new Date(start[1]) : null,
      endDate: end ? new Date(end[1]) : null,
      stack: inferStack(ctx.slice(0, 2000)),
      status: null,
      url: `https://immunefi.com/audit-competition/${slug}/`,
      description: '',
    });
  }
  return out;
}

export const ADAPTERS = [
  { name: 'Sherlock', run: sherlock },
  { name: 'Code4rena', run: code4rena },
  { name: 'Cantina', run: cantina },
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
