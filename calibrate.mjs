#!/usr/bin/env node
// Regression test for the fit scorer. Run this after ANY edit to profile.mjs.
//
//   node calibrate.mjs
//
// It scores every contest the adapters currently return and checks two things:
//   1. Contests squarely inside Guille's specialties reach ALTO.
//   2. Contests clearly outside them never do.
//
// Ground truth is drawn from real historical contests, with Metric as the anchor case:
// it is the contest whose stop-loss watermark, router refund and anchored-band paths
// were actually broken, so a scorer that does not rank it ALTO is miscalibrated.

import { fetchAll } from './sources.mjs';
import { scoreContest } from './profile.mjs';

// Must reach ALTO — each sits on at least one proven specialty.
const MUST_BE_HIGH = [
  'Metric',           // programmable pools, extensions, anchored pricing, permissionless deploy
  'redstone-oracle',  // oracle protocol
  'Reflector V3',     // price feed oracle
  'Yield Basis',      // Curve-native AMM
  'panoptic-core',    // options on Uniswap V3/V4
  'GMX',              // perpetuals, swap fees, price impact
];

// Known miss, kept visible on purpose: the API truncates its description to one
// generic line, leaving no signal to extract. It still reaches the digest as MEDIO.
const KNOWN_MISSES = ['balancer-v3'];

const { contests, errors } = await fetchAll();
for (const e of errors) console.log(`WARN source failed — ${e.source}: ${e.message}`);

const scored = contests.map((c) => ({ c, fit: scoreContest(c) }));
const describable = scored.filter(({ c }) => (c.description || '').length > 40);

const dist = {};
for (const { fit } of scored) dist[fit.level] = (dist[fit.level] || 0) + 1;
const altoPct = ((dist.ALTO || 0) / describable.length) * 100;

console.log(`scored ${contests.length} contests (${describable.length} with a usable description)`);
console.log(`levels: ${JSON.stringify(dist)}`);
console.log(`ALTO share: ${altoPct.toFixed(1)}%`);

let failures = 0;

console.log('\n--- must be ALTO ---');
for (const want of MUST_BE_HIGH) {
  const hit = scored.find(({ c }) => c.name.toLowerCase() === want.toLowerCase());
  if (!hit) { console.log(`  SKIP  ${want} (not in current feed)`); continue; }
  const ok = hit.fit.level === 'ALTO';
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${want.padEnd(18)} ${String(hit.fit.score).padStart(3)} -> ${hit.fit.level}`);
}

console.log('\n--- known misses (informational) ---');
for (const name of KNOWN_MISSES) {
  const hit = scored.find(({ c }) => c.name.toLowerCase() === name.toLowerCase());
  if (hit) console.log(`  ${name.padEnd(18)} ${String(hit.fit.score).padStart(3)} -> ${hit.fit.level}`);
}

console.log('\n--- negative control: must NOT be ALTO ---');
const negatives = scored.filter(({ c }) =>
  /\bnft\b|game|social|airdrop|domain name|governance only/i.test(`${c.name} ${c.description || ''}`) &&
  !/oracle|lending|amm|dex|perp|vault|swap/i.test(c.description || ''));
for (const { c, fit } of negatives) {
  const leak = fit.level === 'ALTO';
  if (leak) failures++;
  console.log(`  ${leak ? 'LEAK' : 'ok  '}  ${String(fit.score).padStart(3)} ${fit.level.padEnd(13)} ${c.name}`);
}

// A scorer that calls everything relevant is as useless as one that calls nothing.
if (altoPct > 25) {
  console.log(`\nFAIL: ALTO share ${altoPct.toFixed(1)}% is too permissive (>25%)`);
  failures++;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
