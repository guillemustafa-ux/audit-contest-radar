# Audit Contest Radar

Detects newly announced smart contract audit contests across **Sherlock, Code4rena,
Cantina, CodeHawks and Immunefi**, scores each one against a fixed auditor profile,
and pushes a Telegram digest only when something new appears.

Runs twice a day via Task Scheduler (10:07 and 16:07 local).

## Why it watches announcements, not openings

Every JSON source exposes a contest's start date *before* the contest goes live. So the
radar keys off "this ID was not in `state.json` yesterday", not "this contest is open
right now". A contest announced today for next Thursday shows up today.

## Sources

| Platform | Method | Notes |
|---|---|---|
| Sherlock | `mainnet-contest.sherlock.xyz/contests` | JSON, paginated 10/page, epoch-second dates |
| Code4rena | `code4rena.com/api/v1/audits` | JSON, list nested at `data.audits`, 25/page |
| Cantina | `cantina.xyz/api/v0/competitions` | JSON, flat array, private contests filtered out |
| CodeHawks | `codehawks.cyfrin.io/contests` | HTML scrape — no public API, every `/api/*` returns 400 |
| Immunefi | `immunefi.com/audit-competition/` | Next.js RSC payload scrape |

### Known limitation: CodeHawks dates

CodeHawks publishes neither dates nor status in its listing markup, and the page serves
the full archive back to 2023. The only liveness signal available is the `YYYY-MM` prefix
on the contest slug, so the adapter keeps contests whose slug is within
`CODEHAWKS_RECENT_MONTHS` (2) of today and drops the rest.

Consequence: a recently-finished CodeHawks contest can surface once as a false positive.
It is reported a single time and then suppressed by `state.json` forever. The alternative
— dropping undated entries — would mean missing live CodeHawks contests entirely, which
is the worse failure for a radar.

## Fit scoring

`profile.mjs` scores each contest against five specialties: oracle-anchored pricing,
inconsistent price conventions, hook/extension architectures and the reentrancy they
enable, permissionless factories, and fixed-point math. Stack is a hard gate — a
Rust/Solana/Cairo/Move contest is marked `FUERA DE ZONA` regardless of keyword hits.

Levels: `ALTO` (score >= 20), `MEDIO` (>= 10), `BAJO`, `SIN DATOS`, `FUERA DE ZONA`.

### Two layers, and why

The scorer originally looked only for audit vocabulary — `staleness`, `mulDiv`,
`rounding`, `deviation`. Measured against 265 real contests, that produced **1 ALTO out
of 265**, and rated Metric — the contest whose stop-loss watermark, router refund and
anchored-band paths were actually broken — a 5/`MEDIO`. RedStone, Reflector, Balancer,
Yield Basis, Panoptic and GMX all landed in `MEDIO` too.

The cause: contest descriptions are two-sentence marketing pitches. They never contain
audit vocabulary, because that vocabulary lives in the code. What a pitch does reveal is
the *kind* of protocol, and the kind implies the attack surface.

So `DOMAIN_SIGNALS` is the coarse layer — a DEX always has price conventions between
components, a lending market always leans on an oracle, a protocol advertising
"programmable pools" or "extensions" always ends up calling contracts it does not
control. `SPECIALTIES` remains the fine layer, for when a pitch happens to name something
specific.

### Retuning

Edit `DOMAIN_SIGNALS` (coarse) or `SPECIALTIES` (fine) — patterns are plain regexes,
weights are integers — then **always** re-run the regression test:

```powershell
node calibrate.mjs
```

It fails (exit 1) if a ground-truth contest drops out of `ALTO`, if an off-profile
contest leaks into `ALTO`, or if the `ALTO` share exceeds 25% — a scorer that calls
everything relevant is as useless as one that calls nothing.

Current state: 6/6 ground truth pass, 7/7 negative controls clean, `ALTO` share 10.6%.

**Known miss:** `balancer-v3` scores 16/`MEDIO`. Its API description is truncated to one
generic line, leaving nothing to extract. It is left failing on purpose rather than
lowering the threshold to catch it. Note that `MEDIO` still reaches the digest — the
levels order the list, they do not filter it.

## Usage

```powershell
node check.mjs                  # normal run: notifies and advances state
node check.mjs --dry-run        # print what it would send; touches nothing
node check.mjs --reset          # wipe state, then run
node check.mjs --test-telegram  # send a test message and exit
node run.mjs                    # stateless: print actionable contests as JSON, no state, no notify
```

### Cloud scheduled task

A Claude Code cloud scheduled task also runs the radar, with this repository selected as
its only source and `node run.mjs` as the command. Auto mode trusts the session's working
directory, so the task runs this repo's own committed code there. The earlier setup cloned
the repo mid-run and wrote the runner on the fly, which the classifier denied as
`[Code from External]`.

## Configuration

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(required)* | Bot token used to push the digest |
| `TELEGRAM_CHAT_ID` | `1601885628` | Destination chat |
| `MIN_PRIZE_USD` | `20000` | Contests below this are ignored. Unknown prizes always pass. |

Set the token once, at user scope, so Task Scheduler inherits it:

```powershell
[Environment]::SetEnvironmentVariable('TELEGRAM_BOT_TOKEN', '<token>', 'User')
```

## Design notes

**No status whitelist.** This was built while every platform was between contests, so the
string each one uses for a live contest could not be observed. Whitelisting an unseen
value would make the radar silently miss the exact event it exists to catch. Liveness is
derived from `endDate > now`, with a blacklist of known-terminal statuses as defence in
depth.

**Notify before persisting.** `check.mjs` sends the Telegram message *first* and writes
`state.json` only on success. A failed push means the state does not advance and the
contest is retried on the next run rather than lost.

**A dead source is never fatal.** Adapters run under `Promise.allSettled`. Four working
sources beat zero because one site changed its markup. The digest names any source that
failed. Telegram is only pinged about breakage when *all five* die — otherwise a flaky
scraper would alert twice a day forever.

## Files

- `sources.mjs` — one adapter per platform, normalizing to a common shape
- `profile.mjs` — two-layer fit scoring (domain signals + specialty keywords)
- `check.mjs` — orchestration, diffing, rendering, Telegram push
- `run.mjs` — stateless JSON runner used by the cloud scheduled task
- `calibrate.mjs` — regression test for the scorer; run after touching `profile.mjs`
- `run.ps1` — Task Scheduler wrapper, appends to `radar.log`
- `state.json` — generated; IDs already notified
- `last-report.md` — generated; the full digest for Claude to read in-session
