# Lookahead

Entry for Sevaro Challenge 2 (Tele-Neurology Operations Command Center), Rutgers Health Hack 2026. Judging: Sunday 1 PM. Correctness is the whole game.

Lookahead rebuilds operational state from Sevaro's raw event stream, detects what needs attention now and in the next 60–90 minutes, recommends interventions (reassign, escalate, split-shift offer) with full rule-by-rule explanations, and runs a human-approved closed loop (coordinator proposes → clinical lead approves → off-shift physician accepts on phone). A seeded Monte Carlo "routing twin" models the routing rules to show an intervention's effect, including the split-shift trap. LLMs are NEVER in the decision path; they may only narrate engine-computed facts.

Layout:
- `packages/engine/`: pure TypeScript library: `src/data` (loaders, schema-adaptive `ingest.ts`), `src/replay` (event-time state), `src/detect` (routing, standards, demand, coverage, attention), `src/decide` (needs, eligibility ledger, trap, what-if, interventions, offer text + PHI guard; `decide()`), `src/act` (append-only action log, `applyCommand`, offer state machine, audit). Tests in `packages/engine/test/`, expected answers in `packages/engine/test/golden/`.
- `packages/engine/src/policy.ts`: named defaults for every open question.
- `apps/web/`: Next.js 15 Command Center (Sessions 6–7).
  - `src/server/` (server-only):
    - `store.ts`: single in-memory store (dataset + injected rows, action log, sim clock, version; one mutex; activate/revert datasets), persisting through `repo/`: `file.ts` (default, `data/live/<datasetKey>/`) and `dynamo.ts` (`STORE=dynamo`), with a fallback wrapper.
    - `view.ts`: memoized `computeView` = `decideWithLog` reshaped into DTOs.
    - `grid.ts`, `ledger.ts`, `offers.ts`, `integrity.ts`.
    - `auth.ts`: offer link tokens, lead PIN cookie.
    - `dataset.ts`: staged uploads, ingest report, snapshot check.
    - `narrate/`: facts, fidelity guard, Bedrock Converse narrator.
    - `archive.ts`: S3 audit archive.
  - `src/app/api/*`: view, integrity, events, commands, clock, offers/[id], audit/[offerId], audit.csv, stream (SSE), demo/reset, dataset (+ mapping, activate, revert), auth/lead, narrate, health.
  - Pages: `/`, `/state`, `/integrity`, `/inject`, `/admin/dataset`, `/audit/[offerId]`, phone `/lead` (PIN) and `/offer/[id]?t=`.
  - Tests: route tests in `apps/web/test/`; Playwright in `apps/web/e2e/` (screenshots to `docs/screens/`; `e2e:remote` against `PLAYWRIGHT_BASE_URL`).
  - Engine code runs only server-side; client components import engine types only. AWS SDK code lives only in `src/server/`, and every AWS feature degrades to the local path.
- `scripts/aws/`: `create-table.ts` (`pnpm aws:create-table`), `iam-policy.json`, `ec2-trust-policy.json`, `user-data.sh`, `deploy-ec2.md`. `docs/RUNBOOK.md`: judging-day operations.
- `scripts/recon.ts`: `pnpm recon` writes `docs/DATA_PROFILE.md`. `scripts/detect-report.ts`: `pnpm report:detect` writes `docs/DETECT_1820.md`. `scripts/decide-report.ts`: `pnpm report:decide` writes `docs/DECIDE_1820.md`. `scripts/demo-loop.ts`: `pnpm demo:loop` writes `docs/ACT_LOOP.md`.
- `data/raw/`: the Sevaro data package, unmodified.
- `docs/`: `brief_c2.pdf`/`brief_c2.md` (the brief), `DATA_PROFILE.md`, `OPEN_QUESTIONS.md`, `DECISIONS.md`.

Commands: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm recon`, `pnpm report:detect`, `pnpm report:decide`, `pnpm demo:loop`, `pnpm lint`. Web: `pnpm --filter web dev` (port 3000), `pnpm --filter web build && pnpm --filter web start`, `pnpm --filter web e2e` (builds, then Playwright), `pnpm --filter web screens`. Timing tests enforce their limits only with one vitest worker (`--no-file-parallelism`); see D-62.

## Rules

1. The brief (docs/brief_c2.md) is the source of truth. Cite the brief section in code comments for every rule you implement. If the brief is silent or ambiguous, do NOT guess: add an entry to docs/OPEN_QUESTIONS.md with a default interpretation, implement the default behind a named constant in packages/engine/src/policy.ts, and log it in docs/DECISIONS.md.
2. Never invent columns, values, event types, or IDs. Inspect the CSVs. Column names in code must match the files exactly (map once, in src/data/).
3. The engine is pure and deterministic: all functions take `now` (epoch ms UTC) as an argument; no Date.now(), no Math.random() (use the seeded RNG we will add later), no I/O inside packages/engine/src except src/data/loaders that read files passed in by path.
4. All instants are epoch milliseconds UTC internally. Parse every timestamp with its explicit offset. Local-time logic uses the hospital's IANA zone from hospitals.csv. Never use the machine's local time zone.
5. No hard-coding of answers. Engine source (packages/engine/src) must never contain literal physician, consult, hospital, or event IDs (regex /\b(PHY|CON|SYN|EVT)-\d+/). Expected answers belong ONLY in test/golden fixtures. A test enforces this.
6. Test-first. Every rule gets a unit test that cites the brief line it encodes. A task is done only when `pnpm typecheck && pnpm test` pass. Paste the actual command output in your final report; never claim a pass you did not run.
7. Keep functions small and typed. Physician state and consult state are separate models (brief: "Physician state and consult state are separate").
8. When you finish a task, update docs/DECISIONS.md and give the report format requested by the prompt.
