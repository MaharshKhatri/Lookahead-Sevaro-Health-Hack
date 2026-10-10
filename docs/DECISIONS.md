# Decisions

Append-only log. Each entry: what was decided, why, and where it lives. Policy defaults for open questions point to docs/OPEN_QUESTIONS.md and `packages/engine/src/policy.ts`.

## Session 1: bootstrap, data reconnaissance, typed loaders (2026-10-10)

**D-01 Data package source.** The package first arrived as one merge-csv.com file. It kept only the first file's header and stripped the headers of the other 8 files, so it was not used. The 9 original CSVs were then uploaded individually and copied byte-for-byte into `data/raw/`. Their data rows are identical to the matching sections of the merged file (checked with `diff`). All 9 files are CRLF, ASCII, no BOM, no quoting.

**D-02 Brief extraction.** `docs/brief_c2.md` is the verbatim `pdftotext -layout` output of `docs/brief_c2.pdf`, wrapped in a text fence so table layout survives rendering. It contains the required sections: How Calls Reach Physicians, Operational Standards, Coverage and Split-Shift Eligibility, Notification and Safety Constraints, What Teams Must Demonstrate.

**D-03 Toolchain.** pnpm 10 workspace, Node >= 20 (22 in this container), TypeScript 5.9 strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, vitest 3, zod 3, luxon 3, csv-parse 5, tsx 4, ESLint 9 + typescript-eslint 8. TypeScript is pinned to 5.9 because typescript-eslint 8 supports TypeScript < 6.1 (latest TypeScript is 7). esbuild is allowed to run its install script (`onlyBuiltDependencies`), which tsx and vitest need.

**D-04 Pure parser, separate file loader.** `parseDataset(texts)` (pure, file name → text) holds all parsing. `loadDataset(dir)` in `src/data/loaders.ts` is the only file I/O in the engine (CLAUDE.md rule 3). Package exports: `@lookahead/engine` (pure, browser-safe) and `@lookahead/engine/loaders` (Node fs). The web app can then parse a file dropped in during the live demo with no server restart.

**D-05 Exact headers.** One zod schema per CSV, keyed by the exact column names. The expected header is derived from the schema keys, so names are written in one place (`src/data/schemas.ts`) and mapped once to camelCase domain types (`src/types.ts`) in `src/data/parse.ts`. A missing column is a fatal `DataParseError` (file:1). Extra or reordered columns produce warnings.

**D-06 Unknown values are errors, not guesses.** `event_type` must be in the brief's "Event types" list (slash forms expanded to 20 types). `current_stage`, `consult_type` and `self_reported_status` must be in the brief's lists. Anything else throws `DataParseError` with file:line, column and value. Categorical fields the brief does not enumerate (`role`, `preferred_channel`, `coverage_tier`, `desktop_agent`, `derived_state`, `dow_type`) are kept as strings. *Revisit when live single-event ingestion is built:* there, reject the one bad event and keep running state, rather than failing a whole file.

**D-07 Never drop rows.** The loader keeps every row, including the duplicate `EVT-00529`. Duplicates, unsorted `ingested_at`, unknown references, duplicate keys, credential-matrix and hospital mismatches, name mismatches, coverage blocks not tiling 24 h, and baselines without 24 hours are all *warnings* (`src/data/integrity.ts`). Removing duplicates is a replay decision (OQ-04). Fully blank lines are not rows; they are counted and reported as a warning.

**D-08 Timestamps.** Every timestamp must match ISO-8601 with an explicit `Z` or `±hh:mm` (regex) and is parsed by luxon with `setZone: true` to epoch ms UTC. A timestamp without an offset is rejected (CLAUDE.md rule 4; brief: "All timestamps include an explicit UTC offset"). Raw strings are kept next to the instants (`eventTimeRaw`, `ingestedAtRaw`, ...) for display and audit.

**D-09 Date-less clock values.** `*_et` columns and the snapshot's `stage_entered_at` become `ClockTime` / `TimeBlock` (seconds of day, with a wrap flag), not instants. `etWallClockToEpoch(etDate, secondOfDay)` in `src/time.ts` converts them using `ET_ZONE = 'America/New_York'`, with calendar-day rollover so DST days stay correct. Default anchor date: OQ-13.

**D-10 Snapshot handling.** Snapshot files are found by the patterns `snapshot_physicians_*.csv` and `snapshot_open_consults_*.csv`; the brief says `snapshot_*_1820.csv`. The suffix becomes `snapshot.label`. A missing snapshot is a warning (`snapshot: null`), because judges' new data may not include one. More than one match is fatal (ambiguous). `physician_id = "Unassigned"` is mapped to `null` (`SNAPSHOT_UNASSIGNED`).

**D-11 Credentialing columns.** Hospital columns are every header except `physician_id` and `name`, read from the file. The brief's printed table says the headers lack the `SYN-` prefix, but the actual file uses full hospital IDs. Cells must be `Y` or blank.

**D-12 Numeric parsing.** Counts and minutes are strict integers. `hours_worked_last_7d`, `mean_consults` and `p90_consults` accept decimals (whole numbers today), so new data with fractions still loads.

**D-13 Purity and no-hard-coding guards.** `test/no-hardcode.test.ts` enforces rule 5 (ID regex over engine source, with a self-check that the pattern matches every ID shape). `test/purity.test.ts` enforces rule 3 (no `Date.now()`, `new Date(`, `Math.random()`, and no I/O imports outside `src/data/loaders.ts`). ESLint repeats both for editor feedback. Both guards were seen to fail on a throwaway violating file, which was then deleted.

**D-14 Golden fixture.** `packages/engine/test/golden/reference_dataset.json` holds the reference package's expected row counts, event-type counts, duplicate IDs and snapshot label, taken from DATA_PROFILE.md. Loader tests compare loaded counts to it and to an independent raw line count.

**D-15 Recon definitions.** `pnpm recon` → `docs/DATA_PROFILE.md`, deterministic, with no generation timestamp.
- "Late" means event_time is below the max event_time of rows with a strictly earlier `ingested_at`: 13 rows. The file-order variant, where ties count as "before", is also reported: 23 rows.
- Percentiles use nearest-rank.
- `now` for the snapshot checks is the snapshot label (`1820`) as ET wall-clock on the ET date of the latest event.
- Recon's stage, state and count derivations are deliberately naive checks, not the replay engine.

**D-16 Policy defaults seeded.** `src/policy.ts` defines a named constant for each of OQ-01..OQ-23. Nothing reads them yet; later sessions must import them rather than re-decide. Changes made during this session after checking against the data:
- OQ-19: the spike is held across the projection horizon. Aging out known consults would end the SYN-005 surge gap at 19:15.
- OQ-18: the note anchor is the later of video end and call end (brief: "from end of video or call").
- OQ-23 added after the 18:09:10 routing failure.

**D-17 Snapshot is fully derivable.** Every column of both snapshot files is reproduced by the candidate derivations in DATA_PROFILE (18/18 consults, 8/8 physicians). These derivations are the acceptance tests for the replay session.

**D-18 Historical assignments only roughly follow the routing rules.** Of the 100 `physician_assigned` events:
- 6 happened less than 2 min after the assignee ended a call (one at 14 s).
- 3 happened 4–22 s before the assignee's video ended.

So the routing twin must model the brief's rules ("model its effect, do not replace it") and must not be fitted to reproduce every historical assignment. The 4 `routing_attempt_failed` events are the validation targets (all explained under OQ-23).
