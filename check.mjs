#!/usr/bin/env node
// Audit Contest Radar — detects newly announced smart contract audit contests
// across Sherlock, Cantina (contests and bounties), CodeHawks and Immunefi, and pushes a
// Telegram digest only when something new shows up.
//
// Usage:
//   node check.mjs                 normal run (notifies + updates state)
//   node check.mjs --dry-run       print what it would send; touches nothing
//   node check.mjs --reset         wipe state first (re-notifies everything live)
//   node check.mjs --test-telegram send a test message and exit

import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchAll, isLive } from './sources.mjs';
import { scoreContest, LEVEL_MARK } from './profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, 'state.json');
const REPORT_FILE = join(HERE, 'last-report.md');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const RESET = args.has('--reset');
const TEST_TELEGRAM = args.has('--test-telegram');

const MIN_PRIZE_USD = Number(process.env.MIN_PRIZE_USD ?? 20000);
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').replace(/"/g, '');
const TG_CHAT = (process.env.TELEGRAM_CHAT_ID || '1601885628').replace(/"/g, '');

// ------------------------------------------------------------------ helpers

const fmtDate = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : '?');

function daysBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date) || isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

async function loadState() {
  if (RESET) {
    // --dry-run promises to touch nothing, so honour that even when combined
    // with --reset: start from an empty state in memory without deleting the file.
    if (!DRY_RUN) await rm(STATE_FILE, { force: true });
    return { notified: {} };
  }
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { notified: {} };
  }
}

async function sendTelegram(text) {
  if (!TG_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Telegram API: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// A contest is actionable if there is still time to join it (shared rule in sources.mjs).
function isActionable(c, now) {
  return isLive(c, now);
}

function passesPrize(c) {
  // Unknown prize is never a reason to stay quiet.
  if (c.prizePoolUsd == null) return true;
  return c.prizePoolUsd >= MIN_PRIZE_USD;
}

// ------------------------------------------------------------------ render

function renderContest(c, fit, now) {
  const mark = LEVEL_MARK[fit.level] ?? '•';
  const window = c.ongoing
    ? `Bounty abierto desde ${fmtDate(c.startDate)}, sin fecha de cierre`
    : `Abre: ${fmtDate(c.startDate)} · Cierra: ${fmtDate(c.endDate)}` +
      (daysBetween(c.startDate, c.endDate) != null ? ` (${daysBetween(c.startDate, c.endDate)} dias)` : '');

  const startsIn = c.startDate instanceof Date && !isNaN(c.startDate) && c.startDate > now
    ? ` — arranca en ${daysBetween(now, c.startDate)} dias`
    : '';

  const hits = fit.matches.flatMap((m) => m.hits).slice(0, 5);
  const hitStr = hits.length ? ` — matchea ${hits.map((h) => `"${h}"`).join(', ')}` : '';

  return [
    `${mark} <b>[${c.platform}]</b> ${escapeHtml(c.name)} — ${c.prizeLabel ?? 'premio no publicado'}`,
    `   ${window}${startsIn}`,
    `   Stack: ${(c.stack ?? []).join(', ') || '?'}`,
    `   Fit: <b>${fit.level}</b> — ${escapeHtml(fit.reason)}${escapeHtml(hitStr)}`,
    `   ${c.url}`,
  ].join('\n');
}

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// -------------------------------------------------------------------- main

async function main() {
  if (TEST_TELEGRAM) {
    await sendTelegram('🛰️ <b>Audit Contest Radar</b>\nMensaje de prueba. Si lees esto, el canal funciona.');
    console.log('Test message sent to chat ' + TG_CHAT);
    return;
  }

  const now = new Date();
  const state = await loadState();
  const { contests, errors } = await fetchAll();

  const actionable = contests.filter((c) => isActionable(c, now));
  const relevant = actionable.filter(passesPrize);

  const fresh = relevant.filter((c) => !state.notified[`${c.platform}:${c.id}`]);
  // Best fit first, then biggest prize.
  const ORDER = { 'ALTO': 0, 'MEDIO': 1, 'SIN DATOS': 2, 'BAJO': 3, 'FUERA DE ZONA': 4 };
  const scored = fresh
    .map((c) => ({ c, fit: scoreContest(c) }))
    .sort((a, b) => (ORDER[a.fit.level] - ORDER[b.fit.level]) || ((b.c.prizePoolUsd ?? 0) - (a.c.prizePoolUsd ?? 0)));

  // ---- console summary (this is what Task Scheduler logs)
  console.log(`[${now.toISOString()}] fetched ${contests.length} | actionable ${actionable.length} | above $${MIN_PRIZE_USD.toLocaleString('en-US')} ${relevant.length} | new ${scored.length}`);
  for (const e of errors) console.log(`  SOURCE FAILED — ${e.source}: ${e.message}`);

  const lines = scored.map(({ c, fit }) => renderContest(c, fit, now));

  if (!scored.length) {
    console.log('  nothing new to report');
    if (errors.length && !DRY_RUN) {
      // Sources breaking is itself worth knowing — but only complain if ALL of them died,
      // otherwise a flaky scraper would ping every 12 hours forever.
      if (errors.length === 5) {
        await sendTelegram('⚠️ <b>Audit Contest Radar</b>\nLas 5 fuentes fallaron. El radar esta ciego.\n' +
          errors.map((e) => `• ${e.source}: ${escapeHtml(e.message)}`).join('\n'));
      }
    }
    await writeReport(now, contests, actionable, scored, errors);
    return;
  }

  const header = `🛰️ <b>Audit Contest Radar</b> — ${scored.length} contest${scored.length > 1 ? 's' : ''} nuevo${scored.length > 1 ? 's' : ''}`;
  const footer = errors.length
    ? `\n\n⚠️ Fuentes caidas: ${errors.map((e) => e.source).join(', ')}`
    : '';
  const message = `${header}\n\n${lines.join('\n\n')}${footer}`;

  console.log('\n' + message.replace(/<[^>]+>/g, ''));

  await writeReport(now, contests, actionable, scored, errors);

  if (DRY_RUN) {
    console.log('\n[--dry-run] nothing sent, state untouched');
    return;
  }

  // Send first, persist second. If the push fails the state does not advance and
  // the contest is retried on the next run instead of being lost forever.
  await sendTelegram(message);

  for (const { c } of scored) {
    state.notified[`${c.platform}:${c.id}`] = { name: c.name, firstSeen: now.toISOString() };
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log(`\nnotified ${scored.length} contest(s); state updated`);
}

async function writeReport(now, all, actionable, scored, errors) {
  const md = [
    `# Audit Contest Radar — ${now.toISOString()}`,
    '',
    `- Contests recuperados: **${all.length}**`,
    `- Accionables (cierre en el futuro): **${actionable.length}**`,
    `- Nuevos en esta corrida: **${scored.length}**`,
    `- Umbral de premio: $${MIN_PRIZE_USD.toLocaleString('en-US')}`,
    errors.length ? `- Fuentes caidas: ${errors.map((e) => `${e.source} (${e.message})`).join('; ')}` : '- Todas las fuentes respondieron',
    '',
    '## Nuevos',
    scored.length ? '' : '_Nada nuevo._',
    ...scored.map(({ c, fit }) =>
      `### ${c.platform} — ${c.name}\n` +
      `- Premio: ${c.prizeLabel ?? '?'}\n` +
      `- Ventana: ${fmtDate(c.startDate)} -> ${fmtDate(c.endDate)}\n` +
      `- Stack: ${(c.stack ?? []).join(', ')}\n` +
      `- Fit: **${fit.level}** (score ${fit.score}) — ${fit.reason}\n` +
      `- Especialidades tocadas: ${fit.matches.map((m) => m.label).join(', ') || 'ninguna'}\n` +
      `- ${c.url}\n`),
    '',
    '## Accionables ya conocidos',
    ...actionable.map((c) => `- [${c.platform}] ${c.name} — ${c.prizeLabel ?? '?'} — cierra ${fmtDate(c.endDate)} — ${c.url}`),
  ].join('\n');
  await writeFile(REPORT_FILE, md, 'utf8');
}

main().catch((e) => {
  console.error('FATAL: ' + (e?.stack ?? e));
  process.exit(1);
});
