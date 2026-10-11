# Lookahead

Tele-neurology operations command center for Sevaro Challenge 2, Rutgers Health Hack 2026.

Lookahead rebuilds operational state from Sevaro's raw event stream. It detects what needs attention now and over the next three hours, forecasts surges, pre-positions standby neurologists, and recommends interventions (reassign, escalate, split-shift offer, standby pre-alert) with rule-by-rule explanations. Every intervention runs through a human-approved closed loop: the coordinator proposes, the clinical lead approves, and the off-shift physician answers on a phone. **AI narrates. Humans decide.** A language model may only narrate engine-computed facts, behind a fidelity guard; it never chooses a physician, sends a message or changes state.

The brief is `docs/brief_c2.md`. Engineering rules are in `CLAUDE.md`, decisions in `docs/DECISIONS.md`, open questions with their defaults in `docs/OPEN_QUESTIONS.md`, and the brief-to-code map in `docs/REQUIREMENTS_TRACE.md`.

## What's new (final build, 2026-10-11)

- **Opener** (`/opener`, or `/?opener=1` over the console): the single most impactful episode from the rewind, in three computed sentences, with a timeline and the latency assumptions it used.
- **Patient clock** on every page: the longest-waiting unassigned stroke consult, ranked first by whether any credentialed physician can take it now, with elapsed time on the sim clock and a neuron-loss estimate (Saver 2006, labelled as an extrapolation).
- **Clinical impact on `/rewind`**: stroke consult-minutes averted by anticipation, extrapolated to neurons, synapses and brain aging, with the sources and the 1:1 assumption on `/clinical-sources`.
- **`/architecture`**: what AI does and never does, the decision pipeline, live counters from the audit log (decisions made by AI: computed, not typed), the hard-coded-ID scan and the last real test run, and a live x20 scale test.
- **Stress Test** drawer in the console: "prove it" (late event, duplicate flood, deadlock and recovery, trap proof, generalization on an isolated dataset, deterministic forecast hashes, PHI audit) and "break it" (declines, a second stroke, heartbeat loss, status flaps, an uncovered stroke, seeded chaos), each through the real ingest and command paths and recorded in the audit log.
- **Upstream Event Simulator** (`/simulator`): signed event pushes into `POST /api/v1/events` and a dev webhook sink, with per-event timing.
- **Status line**: `/api/health` checks DynamoDB and Bedrock with fast timeouts; green "Live on AWS" only when both answer.
- **Integration API**: `POST /api/v1/events` (HMAC-signed, idempotent), `GET /api/v1/{forecast,standby,coverage,alerts,incidents}`, signed outbound webhooks, `/embed/surge`, `docs/openapi.yaml` checked against the route files.
- **Design system**: Night and Day themes with a WCAG contrast test, a component kit, the Horizon Line (now − 30 to now + 180 min), a detail column, the ⌘K command palette and a shortcut sheet (`?`). Living style guide at `/design`; plan in `docs/DESIGN.md`.

## Quick start

```sh
pnpm install
pnpm typecheck && pnpm test        # engine + web unit and route tests
pnpm --filter web dev              # http://localhost:3000
pnpm --filter web build && pnpm --filter web start
pnpm --filter web e2e              # build + Playwright
pnpm final-check                   # every automated pre-judging check, fails loudly on any red
```

Docker: `docker build -t lookahead . && docker run -p 3000:3000 --env-file .env lookahead` (see `Dockerfile`, `docker-compose.yml`, `.env.example`).

Demo defaults (change them for anything but a demo): `DEMO_MODE=true` lets anyone act as the coordinator; the clinical lead PIN is `LEAD_PIN` (default `2026`) in every mode; physician links carry an HMAC token.

## Pages

| Page | What it shows |
|---|---|
| `/` | Command center: Horizon Line, NOW (ranked attention or incidents), coverage grid, surge radar, standby bench, timeline, policy, ACT (next best actions, recommendation, ledger, trap, what-if, offers), Stress Test |
| `/opener`, `/rewind`, `/clinical-sources` | The day replayed as if Lookahead had been running, and the clinical extrapolation |
| `/quality` | Forecast backtest against baseline and persistence |
| `/architecture` | AI narrates, humans decide; live counters; scale test |
| `/simulator` | Upstream event simulator (demo only) |
| `/lead`, `/offer/[id]?t=`, `/standby/[id]?t=` | Phones: clinical lead approvals, physician offer and standby |
| `/state`, `/integrity`, `/inject`, `/audit/[offerId]`, `/admin/dataset`, `/design`, `/embed/surge` | State models, replay integrity, live test rows, audit, dataset swap, style guide, embeddable radar |

## Reports

`pnpm report:detect`, `report:decide`, `report:forecast`, `report:rewind`, `demo:loop`, `scale:bench`, `test:report` regenerate the measured documents in `docs/` (`DETECT_1820.md`, `DECIDE_1820.md`, `FORECAST_BACKTEST.md`, `REWIND.md`, `ACT_LOOP.md`, `SCALE.md`, `test-report.json`). Every number in them, and on every page, is computed by code at run time.

## AWS (optional; everything degrades to local)

| Env | Effect | Without it |
| --- | --- | --- |
| `STORE=dynamo`, `TABLE_NAME`, `AWS_REGION` | Action log and injected events in DynamoDB with conditional writes (D-76) | file store in `data/live/` |
| `BEDROCK_MODEL_ID`, `BEDROCK_GUARDRAIL_ID`; `NARRATION=off` to disable | Bedrock writes Explain text, checked by the fidelity guard | template text |
| `AUDIT_BUCKET` | audit CSV and action log archived to S3 before each reset or dataset swap | nothing archived |
| `DEPLOYED_URL` | shown in the status modal; checked by `pnpm final-check` | not shown |

EC2 deployment: `scripts/aws/deploy-ec2.md`. Judging-day operations: `docs/RUNBOOK.md`. Integration: `docs/INTEGRATION.md`. Architecture: `docs/ARCHITECTURE.md`.

## Limitations

- One synthetic day of data. The forecast backtest (`docs/FORECAST_BACKTEST.md`) does not beat the baseline-only model on count metrics; the clinical numbers are an extrapolation from published averages, not an outcome measurement.
- The x20 scale benchmark (`docs/SCALE.md`) shows a full uncached recompute well over an interactive budget; the hot spots and unapplied fixes are listed there.
- No real Synapse, scheduling or messaging adapter: messages are simulated, approvals happen in the `/lead` inbox, and the event API is ours (`docs/INTEGRATION.md`). Shadow mode was not built.
