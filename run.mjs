// Stateless runner for the cloud scheduled task: prints actionable contests as JSON on stdout.
// Committed (not generated per run) so the task executes this repo's own code from its working directory.
import { fetchAll, isTerminal } from './sources.mjs';
import { scoreContest } from './profile.mjs';
const MIN = Number(process.env.MIN_PRIZE_USD || 20000);
const now = Date.now();
const { contests, errors } = await fetchAll();
const rows = [];
for (const c of contests) {
  if (isTerminal(c.status)) continue;
  const live = c.datesUnknown ? true : (c.endDate && !isNaN(new Date(c.endDate)) && new Date(c.endDate).getTime() > now);
  if (!live) continue;
  if (c.prizePoolUsd != null && c.prizePoolUsd < MIN) continue;
  const s = scoreContest(c);
  if (s.level === 'FUERA DE ZONA') continue;
  rows.push({ platform: c.platform, name: c.name, level: s.level, score: s.score, prize: c.prizeLabel, end: c.endDate, url: c.url, reason: s.reason });
}
rows.sort((a, b) => b.score - a.score);
console.log(JSON.stringify({ rows, errors, total: contests.length }));
