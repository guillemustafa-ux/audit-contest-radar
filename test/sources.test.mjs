// Parser tests with small inline fixtures shaped like the real payloads (captured 2026-10-28).
// Run: node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLive, sherlockStatusesToQuery, mapCantinaBounties, parseCodehawksListing } from '../sources.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const DAY = 86_400_000;

test('isLive: future end is live, past end is not, terminal status never is', () => {
  assert.equal(isLive({ endDate: new Date(NOW + DAY) }, NOW), true);
  assert.equal(isLive({ endDate: new Date(NOW - DAY) }, NOW), false);
  assert.equal(isLive({ endDate: null }, NOW), false);
  assert.equal(isLive({ endDate: new Date(NOW + DAY), status: 'finished' }, NOW), false);
});

test('isLive: an ongoing bounty has no end date and is live unless terminal', () => {
  assert.equal(isLive({ ongoing: true, endDate: null }, NOW), true);
  assert.equal(isLive({ ongoing: true, endDate: null, status: 'migrated' }, NOW), false);
});

test('sherlockStatusesToQuery keeps every non-terminal status the stats endpoint reports', () => {
  const stats = [
    { count: 301, status: 'FINISHED' },
    { count: 1, status: 'RUNNING' },
    { count: 2, status: 'SOME_NEW_STATUS' },
    { count: 0, status: 'CREATED' },
  ];
  assert.deepEqual(sherlockStatusesToQuery(stats), ['RUNNING', 'SOME_NEW_STATUS']);
});

test('sherlockStatusesToQuery queries nothing extra when stats is not a list', () => {
  assert.deepEqual(sherlockStatusesToQuery({ error: 'unavailable' }), []);
  assert.deepEqual(sherlockStatusesToQuery(null), []);
});

const bounty = (over) => ({
  id: 'b1', name: 'Rain Bug Bounty', kind: 'public_bounty', status: 'live',
  createdAt: '2026-09-18T16:19:53Z', timeframe: { start: '2026-10-28T21:30:00Z', end: null },
  totalRewardPot: '100000', currencyCode: 'USDC', url: 'https://cantina.xyz/bounties/b1',
  instructions: 'Lending protocol with Chainlink oracle', ...over,
});

test('mapCantinaBounties keeps public bounties opened in the last 7 days, as ongoing', () => {
  const out = mapCantinaBounties([bounty({})], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].platform, 'Cantina bounty');
  assert.equal(out[0].name, 'Rain Bug Bounty');
  assert.equal(out[0].ongoing, true);
  assert.equal(out[0].endDate, null);
  assert.equal(out[0].prizePoolUsd, 100000);
  assert.equal(out[0].url, 'https://cantina.xyz/bounties/b1');
  assert.equal(isLive(out[0], NOW), true);
});

test('mapCantinaBounties drops old, private and terminal bounties, and keeps one that opens later', () => {
  const rows = [
    bounty({ id: 'old', timeframe: { start: '2026-10-16T21:30:00Z', end: null } }),
    bounty({ id: 'priv', kind: 'private_bounty' }),
    bounty({ id: 'done', status: 'complete' }),
    bounty({ id: 'soon', timeframe: { start: '2026-11-05T00:00:00Z', end: null } }),
    bounty({ id: 'nostart', timeframe: { start: null, end: null }, createdAt: '2026-10-29T00:00:00Z' }),
  ];
  assert.deepEqual(mapCantinaBounties(rows, NOW).map((b) => b.id), ['soon', 'nostart']);
});

const codehawksPage = (contests) => `<html><body>
<script type="application/json" data-sveltekit-fetched data-url="/trpc/other.query?batch=1">{"status":200,"body":"[]"}</script>
<script type="application/json" data-sveltekit-fetched data-url="/trpc/competitions.getCompetitions?batch=1&amp;input=%7B%7D" data-hash="x">${JSON.stringify({ status: 200, statusText: '', headers: {}, body: JSON.stringify([{ result: { data: contests } }]) })}</script>
</body></html>`;

const hawk = (over) => ({
  id: 'c1', company: 'Acme', name: 'Acme Lending', protocolTags: 'foundry, solidity, lending',
  urlSlug: '2026-11-acme-lending', currencyUsdRate: 1, reward: 50000, currency: 'usdc',
  startDate: '2026-11-02T12:00:00.000Z', endDate: '2026-11-16T12:00:00.000Z', inviteOnly: false, ...over,
});

test('parseCodehawksListing reads dates, prize and stack from the embedded competitions payload', () => {
  const [c] = parseCodehawksListing(codehawksPage([hawk({})]));
  assert.equal(c.platform, 'CodeHawks');
  assert.equal(c.id, '2026-11-acme-lending');
  assert.equal(c.name, 'Acme Lending');
  assert.equal(c.startDate.toISOString(), '2026-11-02T12:00:00.000Z');
  assert.equal(c.endDate.toISOString(), '2026-11-16T12:00:00.000Z');
  assert.equal(c.prizePoolUsd, 50000);
  assert.equal(c.prizeLabel, '50,000 USDC');
  assert.deepEqual(c.stack, ['Solidity']);
  assert.equal(c.url, 'https://codehawks.cyfrin.io/c/2026-11-acme-lending');
  assert.equal(c.datesUnknown, undefined);
});

test('parseCodehawksListing leaves ETH prizes out of USD and skips invite-only contests', () => {
  const out = parseCodehawksListing(codehawksPage([
    hawk({ urlSlug: 'eth-one', reward: 7.25, currency: 'eth' }),
    hawk({ urlSlug: 'private-one', inviteOnly: true }),
  ]));
  assert.deepEqual(out.map((c) => c.id), ['eth-one']);
  assert.equal(out[0].prizePoolUsd, null);
  assert.equal(out[0].prizeLabel, '7.25 ETH');
});

test('parseCodehawksListing fails loudly when the payload is missing', () => {
  assert.throws(() => parseCodehawksListing('<html>redesigned</html>'), /CodeHawks/);
});
