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

## Session 2: replay engine and snapshot verification (2026-10-10)

**D-19 Reducer design.** `replay(dataset, asOfMs, {mode})` (`src/replay/reduce.ts`) is pure.
- It builds private mutable drafts, folds the planned events through one dispatcher (an exhaustive `switch` over the 20 brief event types, with a `never` check, each case calling a small handler), then freezes the result into `NetworkState` (`src/replay/derive.ts`).
- Physician and consult state are separate models (brief "Important Data Model Concepts").
- Stage transitions are the recon mapping that reproduced 18/18 (OQ-18), now with OQ-25 for repeated and backward stages.
- Bad sequences never throw. Examples: video_ended without video_started, a call end with no call, events after sign-off, unknown consults, missing IDs, an unrecognised status. Each produces an integrity warning that names the event id. Events that cannot be applied at all are counted in `ignoredCount`.
- Physicians outside physicians_on_shift.csv are tracked (`onRoster: false`) with a warning.

**D-20 Knowledge-time semantics.** The correct-mode view at T is:
- dedupe (OQ-04);
- keep events with `ingested_at <= T` (`knownAt`);
- keep events with `event_time <= T` (a known future-dated event is deferred with a warning);
- order by `(event_time, ingested_at, event_id, payload)`;
- apply each event at its `event_time`.

The sort key never uses file position, so the result doesn't depend on input order; 20 seeded shuffles give identical state. The simulated clock and late events therefore behave the way the system would actually have seen them. At 18:15 the late video start is unknown and PHY-006 is flagged; at 18:18:05 it lands, backdated to 18:11:20.

**D-21 Naive mode.** `{mode: 'naive'}` is for the Integrity panel only. It uses arrival (array) order, no dedupe, and applies each event at its `ingested_at`. It reuses the same dispatcher and handlers; only the plan (which events, what order, which time accessor) differs, so there is no second implementation. At 18:20 it produces 40 consult-cell diffs and 0 physician diffs (recorded in `test/golden/naive_diffs_1820.json`).

**D-22 Provenance.** Explainable values are `Provenanced<T> = {value, because: EventRef[], rule: RuleCode}`. This covers `selfStatus`, `derivedState` and every flag; `agent` and `camera` carry `because` directly. `RuleCode` is the key set of `RULES` in `src/replay/rules.ts`, and each entry cites its brief section or OQ. Derived-state precedence is driven by `policy.DERIVED_STATE_PRECEDENCE` (OQ-15). Label strings are the snapshot's `derived_state` vocabulary, plus "In Meeting" from the brief's status list.

**D-23 Flags.**
- **EXTERNAL_VIDEO_SUSPECTED:** camera active, agent online, no Synapse video, status not In Meeting. This is the brief's rule as written; a concurrent phone call does not suppress it.
- **AGENT_OFFLINE_UNVERIFIED:** whenever the agent is offline.
- **TEMP_UNAVAILABLE_WITH_ASSIGNED:** lists every open consult still assigned, not only stroke consults. The UI can filter by consult type.
- **RINGING_UNANSWERED:** carries the seconds since ringing began; there is no timeout (OQ-17).
- **IN_MEETING_INTERRUPTIBLE:** whenever the status is In Meeting, with `cameraActive` noted.

Each flag carries `sinceMs`, which the late-event impact uses for correction windows.

**D-24 Snapshot projection and diff.** `toSnapshotPhysicianRows` and `toSnapshotConsultRows` output objects keyed by the exact snapshot column names, which come from the Session 1 zod schemas. Cells are formatted as in the files: ET `HH:mm` / `HH:mm:ss`, floored minutes, `"Unassigned"`, `"Online"` / `"Offline"`. `diffSnapshot` compares those cells with `referenceSnapshotRows(dataset.snapshot)`, so reference values always come from the loaded files. Missing or unexpected rows show as column `*`. `snapshotAsOfMs(dataset)` derives "now" from the snapshot label (OQ-13).

**D-25 Late-event impact.** `lateEventImpact(dataset, asOfMs)` takes each late event (OQ-12) known by `asOfMs`. It replays at that event's `ingested_at` twice, once with the event and once without, and compares the facts of every consult and physician. Comparing at the same instant, rather than at `ingestedAt − 1 ms`, isolates the event from anything else ingested at that moment. The correction window runs from the event's `event_time` (or a retracted flag's `sinceMs`, if later) to its `ingested_at`.

**D-26 Live append.**
- `parseEventRows` accepts event_stream.csv text with or without a header. A header is detected when any first-line cell, after the optional column `mapping`, is an event_stream column name. Header-less lines must have the file's 8 cells. It reuses the Session 1 csv reader (new header-less and relaxed-column modes) and the shared `mapEventRow`. `pendingEventSchema` allows a blank `ingested_at`. Bad lines become per-line errors.
- `appendEvents` never mutates its input:
  - duplicates (OQ-04) are skipped and reported;
  - a reused id with different content is accepted with a warning;
  - unknown hospital or physician ids are accepted with a warning;
  - an event missing a column its type needs is rejected (consult_id everywhere except physician-signal events, physician_id everywhere except received/triaged/routing failures, hospital_id on consult_received; pattern taken from DATA_PROFILE);
  - a blank `ingested_at` is stamped with `nowMs` and reported.
- `appendEventText` combines the two steps for the UI.

**D-27 Shift counters.** `consultsThisShift` and `callsThisShift` reset at `shift_started` (OQ-11, `SHIFT_COUNTERS_RESET_ON_SHIFT_STARTED`). This keeps multi-day replays honest (see the 10× bench) and doesn't change any count in the reference day.

**D-28 Performance.** Median replay is about 4–6 ms for the 1,164-event stream and about 19–21 ms for a 10× synthetic stream (10 day-shifted copies with remapped ids), against limits of 50 ms and 400 ms. `LOOKAHEAD_SKIP_BENCH=1` prints the timings but skips the thresholds on noisy CI.

**D-29 Data-layer additions.**
- `readCsvText` gained `columns` (header-less) and `relaxColumnCount` options, plus `CsvRow.cellCount`.
- `src/data/events.ts` holds the one event-row mapper, which the loader and live append both use.
- `fields.optionalInstant` was added.

## Session 3: detect layer (2026-10-10)

**D-30 Detection is built only on replay.** `detect(dataset, nowMs)` calls `replay` once and derives everything else from that state plus static facts (credentials, roster shifts, baseline, coverage blocks), gathered into a `StaffingModel`. Nothing in `src/detect` reads raw events for state. The one exception is a lookup table from event id to event reference, used only to cite evidence.
- Replay gained two provenance fields: `shiftStartedBy` and `lastCallEndedBy`.
- The brief's numeric rules live in `detect/brief-rules.ts`: the standards table, the 2-minute cooldown, low volume at 6 (day) / 4 (night), the 5-minute retry, the 90-minute minimum horizon, and the 60-minute open-notes window. Interpretations stay in `policy.ts`.

**D-31 Routability (OQ-24(b)).** `routableNow` returns every check with `affects: routable | verified | info`, a detail string and `because` refs.
- **Rule 1:** on shift (roster or scheduled arrival, half-open) and credentialed.
- **Rule 2:** active call; active video; EXTERNAL_VIDEO_SUSPECTED; Temporarily Unavailable; phone ringing (OQ-17); assigned-but-not-contacted (OQ-23, flagged `inferred: true`); call ended < 2 min ago (OQ-07, calls only).
- **Never blocking (info):** documenting (OQ-06) and In Meeting (brief).
- **Unverified:** agent offline, or no presence signals at all (a scheduled arrival with no events).
- **Per-consult checks:** with `forConsultId`, the consult's own ringing call or pending assignment is not "another call" (brief wording).

**D-32 Route choice (rules 3-5).** Candidates are everyone the replay tracks plus scheduled arrivals on shift.
- Order: low-volume tier first (consults ≤ 6 on a day shift, ≤ 4 on a night shift; OQ-10), then fewest consults, then least recently answered (never answered first), then id (OQ-26).
- `chosen: null` with rule ROUTE_NO_ONE_ELIGIBLE is a routing failure.
- Validation: all 4 `routing_attempt_failed` events are reproduced with the expected blockers. Historical agreement is 54/100 (informational).

**D-33 Standards.** Every row of the brief's table is evaluated for each open consult's current stage and type.
- Comparison: at or past the threshold on exact elapsed time (OQ-05).
- Clocks start at stage entry; the note clock uses `noteClockStartMs` (OQ-18).
- `warnAtMs` and `criticalAtMs` are always returned.
- Open notes near shift end: notes = assigned consults in Note Pending or Documentation. The window is `[shiftEnd − 60 min, …)`, inclusive. `levelAtWindow` projects the level for physicians whose window hasn't opened yet.

**D-34 Demand.** The trailing-60 count of `consult_received` (from replay `receivedMs`) in `(now − 60 min, now]` is compared strictly greater than the p90 for the ET hour containing now (OQ-03, OQ-19). Only weekday baselines exist (OQ-03 addendum).

**D-35 Projection semantics (OQ-24(a)).**
- **Timeline:** now, then every `PROJECTION_STEP_MIN` (5) to `PROJECTION_HORIZON_MIN` (120; detect refuses < 90), plus every exact boundary inside the horizon: roster shift ends, scheduled arrival starts and ends, and coverage block edges on today's and tomorrow's ET dates.
- **required** = block minimum (OQ-01) + 1 while the hospital spikes at now (OQ-19 hold).
- **staffed** = on shift at t + credentialed + current status not Temporarily Unavailable (OQ-28). Agent-offline physicians are counted and listed as unverified; arrivals are counted and listed.
- **Gaps:** contiguous points where staffed < required, merged. A gap starts exactly at a boundary, because staffing only changes at boundaries. It ends at the first point where coverage is restored, or `beyond_horizon`.
- **Causes**, computed against the previous point: shift_end (with the departing physician's `shift_started` event as evidence), block_change, spike (with consult_received evidence) and temp_unavailable.
- **Two outputs:** the default includes scheduled arrivals (OQ-27); `gapsExcludingArrivals` and `timelineExcludingArrivals` are reported alongside.
- **Routable-now counts** per hospital are separate fields.

**D-36 Scheduled arrivals.** Included by default, per the brief's roster note ("A scheduled night shift is not a split-shift offer"): a scheduled shift is coverage that is already arranged. Shift length is 12 h (OQ-27). Arrivals are routable from their start but unverified.

**D-37 Attention scoring.** score = Σ factors from `policy.ATTENTION_WEIGHTS`:
- **Kind base:** deadlock 60, breach 40, gap 35, imminent 20, open notes 20, spike 15, signal 10.
- **Level:** critical 30, warning 10. Deadlocks count as critical; an imminent item uses the level it will reach.
- **Stroke at risk:** 25.
- **Urgency:** 20 × (1 − timeToImpact / horizon).
- **Overdue:** 0.5 per minute past the crossed threshold, capped at 15.
- **Escalates to critical within 15 min:** 8.
- **Item-specific:** shortfall 10 per missing physician; spike excess 5 per consult over p90 (cap 20); 5 per open note; signal points per flag.

Severity comes from score bands (≥ 110 critical, ≥ 80 high, ≥ 50 medium). Items sort by score descending, then id ascending; ids are an FNV-1a hash of kind + entities.

At 18:20 this ranks the two routing deadlocks first (135), then the four stroke critical breaches (115.5–118). Every item carries ≥ 1 why-bullet citing rule and numbers, ≥ 1 event reference, a headline of ≤ 90 characters, and a score breakdown that sums to the score.

**D-38 One item per consult standard.** A consult/standard pair yields at most one item:
- a STANDARD_BREACH when already at warning or critical;
- otherwise an IMMINENT_BREACH when the warning threshold falls within `IMMINENT_WINDOW_MIN` (15).

A warning that turns critical within 15 minutes stays one STANDARD_BREACH item with an escalation bullet and +8 points, rather than also getting an IMMINENT item. IN_MEETING_INTERRUPTIBLE is not an attention item, because it is not a conflict.

**D-39 Deadlock definition.** A ROUTING_DEADLOCK is an open, unassigned consult for which `chooseRoute` (consult-specific) finds no routable physician. Its evidence is the routing failures plus the signals of the physicians who block it (on shift and credentialed), never of physicians excluded by credentials or shift.

**D-40 Time travel past the last event.** `detect` at a later instant uses only the known events. Activity with no ending event stays open (calls, videos), so standards keep escalating. PHY-011's scheduled shift appears at 19:00, PHY-003 and PHY-006 drop off at 19:00, and the SYN-005 spike ages out of the trailing window by 19:30. Simulating future activity is the routing twin's job, not detection's.

**D-41 Performance.** Labels for ET clock times are memoized, a timeline point's ET time of day is computed once, and the routability matrix is computed once and reused for routes and routable-now counts. `detect` at 18:20 takes about 7–10 ms median in isolation and about 18 ms with the full suite running in parallel, against a 30 ms target. `pnpm report:detect` renders `docs/DETECT_1820.md` from the same report.

## Session 4: decide layer (2026-10-10)

**D-42 Decide builds only on detect() and replay().** `decide(dataset, nowMs, opts?)` runs `detect`, then one longer coverage projection that reuses detect's state, staffing, demand and routability matrix (OQ-31). Everything after that is a pure function of those outputs: needs, ledger, recommended offer, trap, what-if, interventions and the top-issue recommendation. Nothing re-derives state, and no LLM is in the path. Decide-side brief constants live in `src/decide/brief-rules.ts`: 10 h rest, 60 h, 120 min, 1 open offer, 3 per week, 10-min expiry, and the decision rights.

**D-43 Arrival confirmation (OQ-29).** `ScheduledShift` now records `source` (roster / scheduled arrival / split-shift offer), `confirmation` (roster / confirmed / expected), `confirmedBy`, `scopeHospitalIds` and `seededConsults`.
- Coverage points and gaps carry `staffedConfirmed`, `staffedExpected` and `expectedIds`.
- `CoverageProjection.classification` lists the HARD_GAP and AT_RISK intervals. AT_RISK intervals cite `COVERAGE_ARRIVAL_CONFIRMATION`; numbers are those at the interval start.
- The existing `gaps` and `gapsExcludingArrivals` are unchanged, so the Session 3 expectations still hold.

**D-44 Needs (OQ-30–OQ-32).** Three kinds:
- `DEADLOCK_NOW`: one per hospital with routing deadlocks, from now to the first relief.
- `HARD_GAP` and `AT_RISK`: from the classification.

Needs start within the 120-min detection horizon, and their ends come from the 300-min decision projection. Only DEADLOCK_NOW and HARD_GAP qualify a hospital for offers; AT_RISK is advisory. Need ids are an FNV-1a hash of kind + hospital + start (`src/util/hash.ts`, shared with attention ids).

**D-45 Eligibility ledger.** Every off-shift roster physician gets one entry, with each of the six brief rules plus the two offer limits evaluated and explained with numbers. A rule that cannot apply (rule 6 with no qualifying need) is `null`, not a pass.
- Failures are attributed per rule (OQ-08 addendum): rule 6 is sized from needs + `MAX_OFFER_HOURS`, rule 5 from the next shift, rule 4 from the headroom.
- The offer window is the minimum of the four caps, and the binding cap is reported.
- Offer limits come from an offer log passed in (`opts.offerLog`; empty until Session 5's state machine). The weekly count uses the ISO week from Monday 00:00 ET (OQ-09).
- Ranking follows OQ-34.

**D-46 Recommended offer.** The top-ranked eligible entry becomes the offer:
- its window, scope (OQ-35 SCOPE) and seed (OQ-35 SEED);
- the value and the covered needs;
- `why[]`: rank, value terms, binding cap and trap bullets;
- the PHI-checked message.

No eligible physician means `recommendedOffer: null`, a valid outcome at other instants.

**D-47 Split-shift trap (OQ-35).** `analyzeTrap` compares the joiner's routing priority (rules 3–4, `compareRouteCandidates` from the routing module) at its start, before and after mitigation, at every credentialed hospital. Routing enforces SCOPE: `credentialCheck` fails with "outside split-shift scope" during a scoped shift. A scoped, seeded shift's consult count starts at the seed. Scheduled arrivals get an advisory SEED-only analysis.

**D-48 What-if.** `projectWithOffers(dataset, nowMs, offers)` adds each accepted offer as a scoped, seeded `split_shift_offer` shift. The shift is expected until confirmed by `shift_started`, so an offer turns a HARD_GAP into AT_RISK rather than OK until the physician shows up. The function re-projects coverage over the decision horizon and recomputes needs with the start filter at the decision-projection end. `decide().whatIf` compares before and after over the same 300 min:
- `compareNeeds` reports each before-need as closed, downgraded, shortened or unchanged, with the after segments;
- `introducedNeeds` lists after-needs with no before counterpart;
- `routableAtOfferStart` counts routable physicians at each scope hospital at the offer start.

Found while building it: filtering after-needs to the 120-min start window hid the SYN-005 HARD_GAP that reopens at 22:35 when the 4-h offer ends. It made a "shortened" gap look "downgraded". The comparison now uses the full decision projection.

**D-49 Offer message and PHI guard.**
- `draftOfferMessage` produces exactly five lines: the operations team, hospital names, start + hours + end, "Reason: projected coverage gap.", and reply/expiry.
- `findPhiViolations` / `assertNoPHI` check a word-boundary denylist (consult and event ids, record numbers, patient, age/sex including "67-year-old", clinical and imaging terms), plus an optional whitelist (vocabulary + allowed phrases such as hospital names).
- The message is checked in strict whitelist mode, and `draftOfferMessage` throws rather than return text that fails.
- "triaged", "stage" and "manage" do not trip the guard. "neuro*" does, by design.
- Fixed in this session: the age pattern missed hyphenated ages ("67-year-old").

**D-50 Interventions and decision rights.** Interventions are generated for the top `INTERVENTION_TOP_ITEMS = 10` attention items and for every need:
- **ROUTING_DEADLOCK:** reassign, escalate and offer.
- **Breach:** reassign and escalate, plus an offer if the consult is unassigned. Two exceptions: note completion gets a note handoff, and imaging pending gets escalate only, since imaging is a hospital-side step.
- **Coverage gap or spike:** escalate and offer.
- **Open notes:** a note handoff plan, one per physician.
- **Signal conflict:** TEMP_UNAVAILABLE_WITH_ASSIGNED gets reassign and escalate; other flags get VERIFY_PRESENCE.
- **AT_RISK need:** VERIFY_PRESENCE for each expected arrival.
- **HARD_GAP or deadlock need:** escalate and offer.

Interventions with the same kind and targets merge, keeping the union of links and why-bullets.

Reassignment uses `chooseRoute` for that consult, excluding the current assignee. With no candidate it says "No routable candidate: fall through to escalation." and lists each blocker's failed rules.

Decision rights follow brief "Users and Decision Rights":
- The coordinator proposes.
- The clinical lead approves escalations and offers.
- The off-shift physician accepts offers.
- `automationAllowed` is true only for VERIFY_PRESENCE, an internal coordinator alert ("Automated actions are permitted only for low-risk steps").

**D-51 Top-issue recommendation.** `recommendForTopIssue` bundles the interventions linked to the #1 attention item in the order reassign → escalate → offer → handoff → verify, with a four-line rationale. At 18:20: CON-2105 deadlock at SYN-010 → no reassignment candidate (PHY-002 on video, PHY-008 Temporarily Unavailable) → escalate → split-shift offer to PHY-009, 18:35–22:35, scoped to SYN-005/008/010, seeded at 14.

**D-52 Performance.** `decide` at 18:20 takes about 17–19 ms median (detect about 8 ms, plus a second 300-min projection, the what-if projection, and the ledger and interventions), against a 40 ms target (`test/decide.determinism.test.ts`). The output is identical across 20 seeded shuffles of the event order. `pnpm report:decide` renders `docs/DECIDE_1820.md`.

## Session 5: act layer, closed loop (2026-10-10)

**D-53 Action log.** `src/act/log.ts` keeps an append-only, frozen array of `ActionEvent {actionId, seq, atMs, actor {role, id}, commandId, type, payload}`. It is separate from Sevaro's event stream: no command reads or writes `dataset.events`, and replay ignores the log (`test/isolation.test.ts`: still 8/8 and 18/18).
- `actionId` is an FNV-1a hash of `commandId#index`.
- `seq` is 1-based; `expectedSeq` gives optimistic concurrency (CONFLICT on mismatch).
- `actionsKnownAt(log, now)` returns events with `atMs ≤ now`.
- The sim clock must not run backwards (INVALID_STATE).
- 14 event types, as specified.

**D-54 Pure command processor.** `applyCommand(ctx, log, command, nowMs)` returns either `{ok, log', emitted, replayed, coverage}` or `{ok: false, code, message}`. The 12 error codes form a closed union.
- **Roles:** `COMMAND_ROLES` is derived from `DECISION_RIGHTS`. Cancel follows OQ-42. Internal alerts may come from the system or the coordinator; only system alerts are marked automated ("Automated actions are permitted only for low-risk steps").
- **Idempotency:** a commandId already in the log returns its original events and appends nothing. Failed commands store nothing, so their retry is evaluated afresh. The action log is an audit of what happened; refusals are returned to the caller, not logged.
- **Decide:** `decideWithLog` calls `decide(dataset, now, {offerLog, acceptedOffers})` from the log. Each command recomputes it (about 16 ms; `applyCommand` about 16 ms median for propose and accept against a 60 ms target).

**D-55 Decide extension for accepted offers.**
- `detect`/`decide` accept `acceptedOffers`, which become scoped, seeded `split_shift_offer` shifts (`offerShift`, shared with the what-if), expected until `shift_started`.
- The ledger treats a physician's accepted shift as a scheduled shift (rule 5: overlap, and the window cap) and adds its hours to the 60-h count (rule 4).
- `offerFromEntry` builds the scoped, seeded, PHI-checked offer for any eligible entry; `recommend` uses it too.
- DEADLOCK_NOW need ids are now keyed by the deadlocked consult ids instead of `now`, so an id stays stable across instants and can be passed as `needIds`.
- Session 3/4 outputs are unchanged: `DETECT_1820.md` and `DECIDE_1820.md` regenerate byte-identical, and all earlier tests pass.

**D-56 Proposal freezes everything the audit needs.** `proposeOffer` checks, in order:
1. the physician is on the roster;
2. caps (OPEN_OFFER_EXISTS, WEEKLY_CAP per OQ-41);
3. `decideWithLog` at now;
4. needs not already filled (OQ-40);
5. eligibility from the ledger (NOT_ELIGIBLE with each failed rule's detail);
6. the sequential conflict (OQ-37).

It then freezes into `offer_proposed`:
- the window, scope and seed (from the ledger + trap at now);
- the value and the covered needs;
- the full ledger (6 rows with each rule's result and detail);
- the trap bullets, the roster channel, and the draft message.

**D-57 Approval sends.** `approveOffer` (clinical lead, status `proposed`) re-checks the frozen message with the strict PHI guard (denylist + vocabulary + frozen hospital names) and fails with PHI_BLOCKED if it does not pass, with nothing emitted. Otherwise it emits `offer_approved`, then `offer_sent` and `offer_delivered` from `system:delivery-sim`, carrying the frozen message, the channel and `expiresAtMs`. Delivery is simulated.

**D-58 Responses and the closed loop.** `respond` is allowed only for the offer's own physician (NOT_OWN_OFFER otherwise). A reply after expiry gets EXPIRED; cancelled or superseded gets NO_LONGER_AVAILABLE; any other state gets INVALID_STATE. Accept emits `offer_accepted` with the effective start (OQ-39) and a frozen coverage effect:
- `compareNeeds` of the needs before and after this acceptance over the 300-min projection;
- the routable count at each scope hospital at the start;
- the filled need ids.

It then emits `offer_superseded` for same-slot offers and `offer_cancelled` (cause `gap_filled`, with reason and `filledBy`) for other open offers whose needs are all filled. Both come from `system:act-engine`.

**D-59 Offer state machine.** `src/act/offers.ts` folds the log into offer records. The status is derived (`proposed → approved → sent → delivered → accepted | declined | expired | cancelled | superseded`; `proposed → rejected`), with expiry derived per OQ-36. `listOffers` returns status, timers (`msUntilExpiry`, `expiresAtMs`) and the allowed next actions per role for the UI. `offerLogEntries` and `acceptedOffersOf` adapt the log for decide.

**D-60 Audit.** `auditTrail(log, offerId)` and `auditCsv(log)` read only the log: who was considered, who was excluded and why, who proposed, who approved or rejected and why, when sent, the channel and message, the outcome with time and actor, the coverage effect, and the cancellations caused. They are identical after the dataset gains events (`test/audit.test.ts`). The 27 CSV columns are pinned, with one line per offer; message newlines become " / " in the CSV only.

**D-61 Demo.** `pnpm demo:loop` narrates the happy path at sim times (18:20 detect → 18:21 propose → 18:22 approve and deliver → 18:24 accept → coverage update → refusal of a second offer for the filled need → audit), then the decline branch (no next candidate, escalation raised and authorized) and the no-response branch (expired at 18:32:00, tick, a late accept refused). It writes `docs/ACT_LOOP.md`.


## Session 6: web app, Command Center and phone flows (2026-10-10)

**D-62 Timing tests under parallel load.** The decide() bench (40 ms) failed intermittently when vitest ran other test files at the same time. A vitest `globalSetup` (`packages/engine/test/bench.setup.ts`) provides the resolved worker count; `expectWithinBudget` (`test/bench.helpers.ts`) enforces each limit exactly when vitest runs **one** worker (`--no-file-parallelism` or `--maxWorkers=1`), relaxes it ×3 (`PARALLEL_FACTOR`) with more than one worker, and skips it with `LOOKAHEAD_SKIP_BENCH=1`. All four timing tests (replay, detect, decide, applyCommand) use it and log which limit applied. Isolated run: decide 20.0 ms vs 40 ms enforced.

**D-63 Web stack.** `apps/web` (package `web`): Next.js 15.5 App Router, React 19, Tailwind 4, TypeScript with the repo's strict base config. `transpilePackages: ['@lookahead/engine']` (the engine ships TS source). Engine code runs only in route handlers and server components; client components import engine *types* only (erased at build). Fonts are self-hosted IBM Plex via `@fontsource` so the build needs no Google Fonts fetch. Design tokens are the Session 6 palette, defined once in `src/app/globals.css` (`@theme`). Status is never colour-only: every chip and every non-OK grid cell carries a word, and HARD GAP / DEADLOCK / AT RISK cells also have distinct patterns.

**D-64 One store, one mutex.** `src/server/store.ts` is a `globalThis` singleton (route bundles and dev reloads share it). It holds the dataset (data/raw + injected rows), the action log, the sim clock `{nowMs, mode, speed}` and a `version` that every mutation bumps (SSE clients refetch on change). Every mutation (command, event append, clock move, reset) runs inside one promise-chain mutex. The engine stays pure: the store calls `applyCommand`/`appendEventText` and swaps immutable values.
- **Clock:** default the reference instant (`snapshotAsOfMs`, 18:20 ET), paused. Playing advances `speed` × 1 s of sim time per real second (speeds 1/10/60). Every clock move runs a system `tick` (commandId `tick@<now>`, so idempotent per instant) to materialize offer expiries (OQ-36). The clock is clamped to [first event, reference + 24 h].
- **Rewind is view-only:** moving the clock before the last action shows the past (actions and events are filtered by knowledge time), the tick is skipped, and new commands get the engine's INVALID_STATE ("the log is append-only in time").

**D-65 Persistence.** `data/live/events.jsonl` holds one record per accepted injected row: the sim time it was injected and the row re-serialized in event_stream.csv format with its stamped `ingested_at`. `data/live/actions.jsonl` holds every action event as emitted. On boot both are replayed (rows through `appendEventText` at their injection time; actions restored only if `seq` is contiguous) and the clock starts at max(reference instant, last action, last injection), paused. `POST /api/demo/reset` deletes both files. `data/live/` is git-ignored.

**D-66 Routes and errors.** Every handler is wrapped (`guard`) and answers JSON, never a crash page. Engine error codes map to HTTP (`src/lib/errors.ts`): FORBIDDEN_ROLE / NOT_OWN_OFFER 403; NOT_ELIGIBLE / PHI_BLOCKED / malformed 422/400; CONFLICT / OPEN_OFFER_EXISTS / WEEKLY_CAP / NEED_ALREADY_FILLED / INVALID_STATE 409; EXPIRED / NO_LONGER_AVAILABLE 410; UNKNOWN_OFFER 404. The actor always comes from `x-lookahead-role` / `x-lookahead-actor-id` (OQ-44); `system` is refused from clients. Command bodies are shape-checked so a missing field is a 400, not an engine exception. A physician's `respond` defaults `physicianId` to the actor. Messages returned to the physician role pass the engine's PHI denylist.

**D-67 View read model.** `computeView` runs `decideWithLog` once and reshapes its output into DTOs (`src/lib/dto.ts`); no rule is evaluated in the app. Memoized on (bootId, version, nowMs), so N SSE clients cost one computation per version (about 30–100 ms). QR codes depend on the requesting host and are added outside the memo (`qrcode` → SVG, cached per URL; `LOOKAHEAD_PUBLIC_ORIGIN` overrides the host so phones on the LAN get a reachable link). After an offer exists, decide() no longer recommends that physician (SAFETY_ONE_OPEN_OFFER / the accepted shift), so the TRAP and WHAT-IF tabs show the offer *as proposed*: decide() at the proposal instant over the log before the proposal, `offerFromEntry` for the trap, `projectWithOffersFrom` + `compareNeeds` for the what-if (cached per offer and dataset version). Once accepted, WHAT-IF shows the coverage effect frozen in `offer_accepted` (D-58).

**D-68 Coverage grid.** Hospitals × 15-min buckets over the 300-min decision projection; the console shows the first 2 h (detection horizon) with a 5-h toggle. The first bucket runs from now to the next quarter hour, then quarter hours, so 19:00 / 20:00 shift changes fall on bucket edges. A cell is the *worst* engine `coverageStatus` among the projection points inside it (numbers from that point), upgraded to DEADLOCK while a DEADLOCK_NOW need (over the decision projection) overlaps it. Cells read "confirmed+expected/required". Shift markers come from the staffing model (roster ends, expected arrivals, accepted offers). Rows with any non-OK cell in the shown window come first; all-OK hospitals collapse into one row.

**D-69 Ledger chips.** The engine's eligibility details carry the numbers; `src/server/ledger.ts` shortens them to chips ("Rest 11.6 h ≥ 10", "59+2=61 > 60") and falls back to the rule label when a detail does not match. `test/view.unit.test.ts` fails if any chip at 18:20 falls back, so engine wording drift is caught.

**D-70 Integrity page.** Correct vs naive at the reference instant over the current dataset (cached per dataset version), all consult cells with mismatches highlighted (toggle), `lateEventImpact` corrections, the duplicate, and a slider over [reference − 10 min, reference] in 30-s steps. The slider subject is the physician whose EXTERNAL_VIDEO_SUSPECTED flag a late event retracted, taken from `lateEventImpact` (no hard-coded id). Lanes: naive belief at t, Lookahead belief at t (knowledge time: both flag PHY-006 until 18:18:05, because nobody can know earlier), and what happened (the correction's "after" inside its window).

**D-71 Inject sample.** "Insert sample" writes two rows (consult_received, consult_triaged) for a new stroke consult at the hospital the engine reports as spiking, with the next free consult and event ids derived from the data, dated sim now + 1 min and + 1:45 with explicit `ingested_at` 2 s later. Because these are future-dated against the sim clock, they are unknown until the clock reaches them (D-20); the page therefore offers "advance the sim clock to when these rows are known" (on by default), which moves the clock to the latest ingestion/event time of the accepted rows. Rows with a blank `ingested_at` are stamped with the sim clock and apply at once.

**D-72 Stale-feed banner.** Per the Session 6 spec, the console shows "No new Sevaro events since HH:MM:SS — state is frozen at last known activity" whenever the sim clock is past the latest `ingested_at` known at that instant. At 18:20:00 this is already true (last event 18:19:43): the data package ends there (D-40).

**D-73 Tests.** `apps/web/test/routes.test.ts` (19) calls the route handlers directly on a temp `data/live`: view at 18:20 equals the engine (top item, recommended physician, ledger), integrity 8/8 · 18/18 · 0 diffs, grid classes vs engine needs, memoization; events accept/duplicate/reject with line numbers; 403 role errors, NOT_OWN_OFFER, idempotent commandId, stale expectedSeq → 409, concurrent same-seq commands (one 200, one 409), malformed → 400; the closed loop through the routes with PHI and QR checks; clock jump → tick → `offer_expired`, late accept → 410 EXPIRED; restart replay and reset; SSE hello + clock message. `test/view.unit.test.ts` (6): chips, bucket geometry, markers, ids, play loop. Playwright (`apps/web/e2e`, chromium, against `next start`): the closed loop across three browser contexts (console, lead phone, physician phone), the live-inject re-rank within 2 s via SSE without reload, role gating, and `screens.spec.ts`, which writes `docs/screens/*.png`. E2E expectations come from the engine's golden fixtures.

## Session 7: dataset swap, demo safety, AWS (DynamoDB, Bedrock, EC2) (2026-10-10)

The engine is unchanged in behavior. On data/raw, all 303 Session 6 engine tests still pass, plus 10 new ingest tests, and `pnpm report:detect` / `report:decide` / `demo:loop` regenerate their docs byte-identical. AWS lives only in `apps/web/src/server/`, behind interfaces with local fallbacks; with no AWS at all the demo is identical (file store + template text).

**D-74 Schema-adaptive ingestion (OQ-45).** `packages/engine/src/data/ingest.ts` is pure: texts in, `{dataset, report, texts}` out. `loaders.ingestDir(dir)` reads every `*.csv` plus an optional `mapping.json`.
- **File kinds.** Each file's kind comes from its name, else from its headers: the kind whose columns resolve best, if at least 60 % resolve (`FILE_KIND_MIN_HEADER_SCORE`).
- **Header matching** (`HEADER_ALIASES`, `HEADER_PREFIX_MIN_LENGTH`), in order: mapping override → exact → normalized (case and punctuation ignored: "Event time" = event_time) → alias (the brief's own table headers: "Phys.", "Hosp.", "Consult", …) → unique prefix of 3 or more characters.
- **Credentialing.** Hospital columns match with or without the "SYN-" prefix (`hospital_suffix`; the brief says the matrix headers lack it).
- **Fuzzy matches are suggestions only.** Edit-distance matches are never applied. A missing required column is reported with its closest headers.
- **Report contents.** `IngestReport` lists, per file: kind and how it was detected, every mapping with its method, unmapped headers, missing columns with suggestions, and row errors with 1-based line numbers (50 per file, then a count). It also lists missing files, errors and warnings.
- **Byte safety.** Only the header line is rewritten to canonical names before the existing loaders parse the text, so data bytes are untouched.

**D-75 Storage interface.**
- `src/server/repo/`:
  - `ActionRepo {load, append(expectedSeq, events) → ok | conflict, clear}`.
  - `EventRepo {load, append(rows), clear}`.
  - `FileRepo` (default) writes `data/live/<datasetKey>/actions.jsonl` and `events.jsonl`. This supersedes the D-65 layout; `persist.ts` is gone.
  - `DynamoRepo` is used with `STORE=dynamo`, `TABLE_NAME`, `AWS_REGION`.
- `datasetKey` is content-addressed: `ds-` + 16 hex of sha256 over the package's CSVs and mapping.json. Each dataset therefore has its own log partition.
- `withFallback` wraps DynamoDB. The first infrastructure error (no credentials, missing table, throttling, network) switches every repo to the file store for the rest of the process. The file store is seeded with an in-memory mirror of everything already written, so nothing is lost. `/api/health` reports `file (dynamo unavailable: <reason>)`. Conflicts are not failures and pass through.

**D-76 Storage-level double-accept guarantee.**
- **Table layout.** One table: `pk = "log#<datasetKey>"` or `"events#<datasetKey>"` (S), `sk = seq` (N), `body` = the JSON event. On-demand billing.
- **Append.** `append` writes all new items in one `TransactWriteItems`. Every Put has `ConditionExpression: attribute_not_exists(sk)`.
- **Race outcome.** When two servers race for the same seq, exactly one transaction commits. The other is cancelled with `ConditionalCheckFailed` and becomes `CONFLICT`. The store then reloads the log and re-applies the same command through the engine's `applyCommand` (new `expectedSeq`, up to 3 times). For a second "accept" the engine answers INVALID_STATE, because the offer is already accepted.
- **The guarantee.** **Two physicians can never both accept the same offer, and one offer can never be accepted twice, even across servers.** The engine's state machine decides who wins; the database guarantees only one write per seq.
- **Verified.** `apps/web/test/repo.test.ts` runs two `Store` instances on one mocked table, plus the conditional-failure path: exactly one `offer_accepted` is stored and `conflictsResolved` is 1.
- **File store.** Within one process it gives the same guarantee (mutex + head-seq check), but not across hosts.

**D-77 Dataset swap.**
- **Upload.** `/admin/dataset` and `POST /api/dataset` accept multipart CSVs or a .zip (fflate). The upload is staged in `data/live/uploads/<stageId>/`.
- **Report.** The response carries the ingest report and, when snapshot files are present, `diffSnapshot` as "x/8 physicians, y/18 consults" plus up to 200 cell diffs.
- **Mapping overrides.** `POST /api/dataset/mapping` writes `mapping.json` into the stage and re-ingests. The UI offers a select per missing column, preselected with the closest suggestion.
- **Activate** (`POST /api/dataset/activate`, lead PIN) swaps atomically under the store mutex:
  - `datasetVersion` + 1;
  - the new dataset's action log and injected events start empty;
  - clock = its snapshot's as-of time, else its last event time, paused;
  - the previous dataset is kept for one-click **Revert** (`POST /api/dataset/revert`, also fresh);
  - the active choice persists in `data/live/active-dataset.json`.
- **Snapshot mismatch.** Activation is still allowed. The console shows a red banner, "Replay differs from your snapshot: N cells", linking to `/integrity`.

**D-78 Offer link tokens and the lead PIN (OQ-44 update).**
- **Offer links.** Physician links are `/offer/<id>?t=<token>`, where token = first 22 chars of base64url(HMAC-SHA256(secret, "offer:" + id)).
  - The QR encodes the tokenized URL.
  - The phone page and `GET /api/offers/:id` require it.
  - The `respond` command requires it in `x-lookahead-offer-token` or `body.token` (403 BAD_TOKEN otherwise).
- **Lead PIN.** Clinical-lead commands and dataset activate/revert need the lead PIN (`LEAD_PIN`, default "2026").
  - `POST /api/auth/lead {pin}` sets an HttpOnly, SameSite=Lax cookie `lh_lead` for 12 h.
  - The cookie holds HMAC(secret, "lead:" + PIN), never the PIN.
  - Without the cookie the API answers 401 PIN_REQUIRED.
  - The console's role switch to Clinical lead asks for the PIN.
- **Secret.** `OFFER_LINK_SECRET`, else a random secret generated once into `data/live/.secret`.
- **Comparisons** are constant-time.
- **Still open.** Coordinator actions, inject and reset remain open, as OQ-44 says (demo-grade).

**D-79 Quiet-feed banner (OQ-46), supersedes D-72.** "No new Sevaro events since HH:MM:SS" appears only when `now − lastIngestedAt > QUIET_FEED_BANNER_MS` (120 000). At 18:20:00 the last event is 17 s old, so the console no longer opens with a stale-feed warning.

**D-80 Next candidate and escalation suggested.** After a decline, an expiry or a rejection, `ViewDTO.nextOffer` calls the engine's `recommendNext` (OQ-43). With nobody left, ACT step 3 reads "<name>'s offer was declined/expired/rejected … **Escalation suggested**", and step 2 (Raise escalation) is highlighted. At 18:20 only Dr. Grace Okafor is eligible, so all three paths end in "escalation suggested" (e2e). The inject page also accepts a CSV by file picker or drag-and-drop (it fills the textarea for review; nothing is sent until Submit).

**D-81 Narration (Bedrock) with a fidelity guard.** LLMs stay out of the decision path. `POST /api/narrate {kind: attention | recommendation | lead_briefing, id}` → `{text, source: bedrock | template, checks, modelId, fallbackReason}`.
- **Input.** Only compact engine facts for that item (`narrate/facts.ts`), de-identified before the model sees them:
  - no consult or event ids;
  - physician and hospital ids replaced by names;
  - "Stroke" → "time-critical", imaging → "workup";
  - OQ and brief citations stripped.
- **System prompt.** Only these facts, no clinical advice, no patient details, no ids, 2–3 sentences ≤ 60 words, times exactly as given (24-h ET), and do not tell the reader what to decide.
- **Model call.** Claude via Bedrock **Converse** (`@aws-sdk/client-bedrock-runtime`), 4 s timeout, maxTokens 1024, no sampling parameters.
  - The model is discovered with `ListInferenceProfiles`: Claude Haiku first, then Sonnet, the region's geo prefix first, newest id first. `BEDROCK_MODEL_ID` overrides.
  - For Claude 5.x ids the call adds `output_config.effort = low`. A model that rejects it is retried without it, and that is remembered.
  - The user's spec chose Converse + a Haiku inference profile in the event's AWS account, so we use that instead of the Anthropic SDK default. Narration needs latency, not depth.
- **Fidelity guard** (`narrate/guard.ts`). Each check names what failed:
  - (a) `phi`: the engine's PHI denylist (`findPhiViolations`) plus CON/EVT ids;
  - (b) `numbers`: every number and clock time in the text must appear in the facts. Times are normalized, so "6:35 PM" = 18:35; spelled numbers count;
  - (c) `names`: every id-like or capitalized proper-noun token must be in the facts' names or words;
  - (d) `length`: ≤ 60 words.
- **Fallback.** Any failure, timeout, credential error or unavailability serves the deterministic **template**: the title plus whole fact sentences up to 60 words, which passes its own guard for all 22 attention items and the recommendation at 18:20.
- **Cache.** Results are cached by (dataset key, dataset version, kind, id, facts hash). Only Bedrock successes and guard failures are cached; outages are retried.
- **UI.**
  - "Explain" sits on attention cards and on the recommendation.
  - `/lead` shows the briefing above Approve (auto).
  - The badge reads "AI-WRITTEN · VERIFIED" or "TEMPLATE"; hovering lists the checks.

**D-82 Health, deploy, audit archive.**
- **Health.** `GET /api/health` returns `{ok, store, bedrock, bedrockModel, bedrockReason, dataset, datasetVersion, version, clock, logSeq, conflictsResolved, bootWarnings, publicOrigin}`.
- **Deploy.** `scripts/aws/` holds:
  - `create-table.ts` (`pnpm aws:create-table`, on-demand, idempotent, checks the key schema);
  - `iam-policy.json`: DynamoDB PutItem/Query/DeleteItem/ConditionCheckItem on the table, `bedrock:InvokeModel` on the chosen profile and its foundation model, `bedrock:ListInferenceProfiles`, `s3:PutObject` on `lookahead/*` and `s3:GetObject` on `code/*` of one bucket. TransactWriteItems and Converse have no IAM actions of their own: they are authorized as PutItem and InvokeModel;
  - `ec2-trust-policy.json`;
  - `user-data.sh`: Amazon Linux 2023; Node 20 from nodejs.org with its SHA-256 verified; pnpm 10.28.0; 2 GB swap on small instances; code from S3, a presigned URL, git or a local tarball; `pnpm install --frozen-lockfile && pnpm --filter web build`; systemd `next start -p 80` as a non-root user with `CAP_NET_BIND_SERVICE`; env in `/etc/lookahead.env`; `LOOKAHEAD_PUBLIC_ORIGIN` from IMDSv2; the offer-link secret generated on the instance and kept across redeploys; releases kept for rollback;
  - `deploy-ec2.md`: CloudShell commands with expected output and fallbacks.
- **Credentials.** They come only from the instance profile.
- **Audit archive.** With `AUDIT_BUCKET` set, a reset or dataset swap first copies the audit CSV and the action log to S3 (best effort).
- **Remote e2e.** `PLAYWRIGHT_BASE_URL=… pnpm --filter web e2e:remote` runs the `@demo` e2e tests against a deployed server.

**D-83 Tests (Session 7).**
- **Engine:** `test/ingest.test.ts` (10).
- **Web vitest** (55 in total):
  - `routes.test.ts` (22): tokens, PIN, quiet banner, decline → escalation suggested;
  - `repo.test.ts` (6): DynamoRepo with `aws-sdk-client-mock` (per-item condition, ConditionalCheckFailed → conflict, infrastructure errors propagate, clear), the fallback to the file repo, the two-server race. FileRepo is covered unchanged by the Session 6 route tests (restart replay, reset);
  - `dataset.test.ts` (7): original files → 8/8 & 18/18; renamed headers "Event time"/"Phys." ingest; a missing required column → error with suggestion → override re-ingests; a .zip upload; nothing usable → 400; activation needs the PIN; activate → /api/view reflects it; mismatch reported; revert; the active dataset survives a restart;
  - `narrate.test.ts` (14): the guard rejects a hallucinated number, a CON id, "stroke" and an unknown name; mocked Bedrock success; template on timeout and on credential error; profile ranking.
- **Playwright** (11): closed loop with PIN + tokenized link, live inject, role gating with PIN, token refusal, decline / reject / expiry → escalation suggested, Explain, dataset swap (renamed headers, activate, revert), mismatch banner, screenshots (now incl. the PIN screen, Explain and the dataset report).

## Final build (2026-10-11): golden freeze, forecast, standby, rewind, incidents, integration

**D-84 Golden freeze (Phase 0).** `pnpm golden:freeze` writes `packages/engine/test/golden/freeze_1820.json` (detect + decide at 18:20 with the bulky routability matrix, per-consult event lists and per-point coverage objects compacted) and `apps/web/test/golden/view_1820.json` (GET /api/view at 18:20 minus bootId, QR and store kind). `golden.freeze.test.ts` in both packages compares as a SUBSET: every frozen field must stay deep-equal, new fields are allowed. This is the mechanical form of the "additive only" rule: later layers may add fields and views but never change brief-defined outputs. The `v0.9-pre-final` tag exists locally; the hosted git proxy refused the tag push (HTTP 403), so the tag is recorded here and can be pushed from a developer machine.

**D-85 Surge forecast (Phase 2, `packages/engine/src/forecast/`).** A per-hospital probabilistic forecast built only on the knowledge-time replay at t. Terms: (A) baseline intensity from `baseline_hourly_volume.csv` with the detector's ET-hour, weekday-only convention (OQ-03); (B) a Gamma-Poisson day-rate multiplier from arrivals older than 60 min (`FORECAST_DAY_RATE_PRIOR_A = 20`, `FORECAST_HOSPITAL_PRIOR_B = 6`); (C) Hawkes self-excitation with an exponential kernel, shared (eta, half-life) fitted by an exhaustive deterministic grid search (13 x 7) on the point-process log-likelihood, first generation only; (D) NegBin (x) Poisson predictive counts truncated at 40 and renormalized (tail < 1e-6 asserted), thinned by a Beta-posterior stroke share; (E) spike probability at a future T. At 18:20 on data/raw: eta 0.15, half-life 10 min, m_net 1.154 over 103 arrivals; the surging hospital has P(spike) = 1 at +0/+15/+30 and 0.42 at +45. Validation: at T = t the probability equals the deterministic detector's flag for every hospital at every 5-min asOf across the day (1,644 checks); PMFs match brute force; the fitter recovers eta 0.35 / half-life 20 on seeded Ogata-thinning simulations (0.35/20, 0.35/20, 0.30/20); injecting a consult never lowers that hospital's P(spike) or expectation with the fit held fixed (the live path memoizes the fit per dataset version and minute); byte-identical JSON under shuffles. Fit ~90 ms, warm forecast ~4 ms. All constants are in `policy.ts`, labelled LOOKAHEAD-DEFINED (illustrative). `src/util/rng.ts` adds seeded mulberry32 for every later Monte Carlo use.

**D-86 Spike window beyond t + 60 (OQ-47).** The Phase 2 note wrote K_h(T) = known arrivals in (T-60, t] + N_h(t, T). For T > t + 60 that would test a window longer than 60 minutes. We read N_h as the future part of the brief's trailing-60 window, (max(t, T-60), T], so every checkpoint tests exactly a 60-minute window; the two readings agree for T <= t + 60.

**D-87 Injection torture suite, seeded fuzz, generalization (Phase 1, tests only).** No engine or app source changed; every scenario passed on the existing code.
- `packages/engine/test/injection.scenarios.test.ts`: 15 scenarios, each appending rows through `appendEventText` (the `/api/events` path) to a fresh dataset and asserting brief-cited outcomes: surge +1 consult (spike 6 > p90, new ROUTING_DEADLOCK in the top 3, item ids stable), quiet hospital (chosen from the baseline, no spike, triaged clock), late video_started applied at event_time (OQ-12; OQ-15 precedence puts video above Temporarily Unavailable), OQ-04 duplicate (detect output deep-equal), OQ-29 confirmation (expected -> confirmed supply, AT_RISK ends), self-report vs derived state, agent offline (verified false, routable unchanged), external video (busy), note_signed clears a breach, physician_assigned clears a deadlock and its need, routing-failure burst (one item per consult), D-26 unknown ids and missing columns, malformed timestamps and cell counts, D-20 future-dated and known-but-deferred events, and an Act scenario where Sevaro assignments resolve the needs an open offer was proposed against ("withdrawn" = fewer covered needs, lower value, `recommendNext` offers nobody; a shift_started before the scheduled start does not confirm). There is no injected-event path to cancel-on-fill: cancellation happens only on acceptance (OQ-40), so the lead cancels manually.
- `packages/engine/test/fuzz.invariants.test.ts`: 50 seeds x 500 schema-valid random events (reference blank-column pattern, OQ-14 descriptions, UTC "Z" offsets), shuffled, appended, then replay/detect/decide at 18:20 and 19:30 with invariants (stage/history for received consults, D-19 warning for consults first seen through a later event, non-negative counts, confirmed + expected = staffed, no Temporarily Unavailable physician in routableNowIds, unique attention ids, score = sum of breakdown, ledger verdict = all rules pass, PHI-clean message). Then 5 seeds x 60 random commands (sequential and parallel dispatch, random actors, retried commandIds) with the Act invariants (append-only prefix, seq = position, one open offer per physician, weekly cap, approved before sent, PHI-clean offer_sent). ~9 s total. No throw and no violation were found.
- `packages/engine/test/mutate.helpers.ts` + `generalization.test.ts`: a package isomorphic to data/raw (monotone id maps PHY->DOC-9xxx, SYN->HOSP-2xx, CON->CASE-7xxx, EVT->E-5xxxx, including the credentialing header and snapshot files; invented names; every ISO timestamp +1 day; permuted rows) replays 8/8 and 18/18 against its own snapshot and gives the same deadlocks, spike, needs (kind, mapped hospital, offsets), ledger verdicts, recommended offer (mapped physician, scope, seed, value, window offsets) and attention (score, kind) sequence; no original id appears in the output. Two presentation orders legitimately differ and are compared order-insensitively: ledger rows follow roster row order, and equal-score attention items break ties on their hash id.
- `apps/web/test/injection.routes.test.ts` (scenarios 1, 4, 12, 13, 14 through POST /api/events, GET /api/view, POST /api/clock; future rows return `knownFromMs` and appear only once the clock is set there) and `apps/web/test/generalization.dataset.test.ts` (mutated CSVs uploaded through POST /api/dataset, ingest report 8/8 and 18/18, activated with the lead PIN, view recommends the mapped physician with mapped ledger verdicts, reverted).

**D-88 Action audit (Phase 0 gap).** The brief names three interventions (reassign a stranded consult, escalate to clinical leadership, offer a split shift); all three already ran through the Act layer with the roles of "Users and Decision Rights", but only offers reached `auditTrail`/`auditCsv` and the OFFERS tab. Additive fix, engine first: `packages/engine/src/act/audit.ts` gains `actionAuditRows(log, nowMs?)` (one row per action event known at nowMs: seq, time, type, actor role and id, subject id, physician/hospital/consult ids, `approvalState` and a one-line PHI-clean `detail`) and `actionsCsv` with the pinned `ACTION_CSV_COLUMNS` (11 columns); `auditTrail`, `auditCsv` and `AUDIT_CSV_COLUMNS` are untouched. Approval states: offers read awaiting/approved/rejected from the fold ("Every offer is approved by the clinical lead"); escalations read awaiting until an `escalation_authorized` exists, then authorized; `reassignment_requested` and `internal_alert_sent` are `n/a` (a coordinator right with no approval step, and the brief's permitted low-risk automation). Detail lines never contain a consult id or clinical term: `audit.actions.test.ts` runs `findPhiViolations` over every row. Web: `GET /api/audit/actions.csv`, `ViewDTO.reassignments` (`reassignmentDTOs` in `apps/web/src/server/offers.ts`), an "Other actions" list (escalations + reassignment requests) with "Download action audit" in the OFFERS tab, and a second link on `/audit/[offerId]`. Tests: `packages/engine/test/audit.actions.test.ts` (10) and `apps/web/test/audit.routes.test.ts` (2: raise -> 403 as coordinator / 401 without PIN -> authorize -> AUTHORIZED; reassignment found via `chooseRoute`, 403 as lead, listed in the view; CSV header, one line per action, approval states). The web golden freeze is a subset check, so the new `reassignments` field is allowed.

**D-89 Forecast backtest (Phase 3, `pnpm report:forecast`).** `scripts/lib/backtest.ts` runs rolling origins every 15 min from dayStart + 120 to lastEvent − 60 (34 origins x 12 hospitals = 408 pairs), refitting the forecast at each origin on knowledge-time state only; realized counts are distinct consult ids received in (o, o+60] after OQ-04 dedupe; the realized spike flag is realized count > p90 for the ET hour of o+60. Models: M0 baseline Poisson(Lambda0), M1 persistence Poisson(max(last-60, 0.1)), M2 Lookahead. Result on this one synthetic day, reported as it fell: M2 beats persistence on 4 of 5 metrics but does not beat the baseline-only M0 on count metrics (MAE 0.757 vs 0.708, RPS 0.478 vs 0.457, Brier 0.0727 vs 0.0713); M2's spike probabilities are well calibrated in the low bin (0.087 predicted vs 0.076 observed). First warning at P >= 0.5 happened once (lead 45 min) across 18 realized onsets. The leakage test shows byte-identical forecasts with and without events ingested after the origin. docs/FORECAST_BACKTEST.md states the limitations: one synthetic day whose spikes are 1-2 consult exceedances of p90 thresholds of 1-3; production would fit on Sevaro's history.

**D-90 Standby Neurologist Network (Phase 4, `packages/engine/src/standby/`, `src/act/standby.ts`).** A split-shift offer is reactive; the standby network pre-positions eligible off-shift physicians before a forecast surge. (4.1) The gap grid takes supply and the block minimum from the EXISTING decision projection at 15-min cells to +180 and sets P(gap) = max(1 if the existing class is HARD_GAP/DEADLOCK, {1 if supply < minimum; P(spike) if supply = minimum; else 0}); EUM_h = sum P(gap) x 15, stroke-weighted by (share + 0.25)/1.25. (4.2) Candidates are every off-shift roster physician; eligibility comes from CALLING `buildLedger` on the gap-risk hospitals rewritten as HARD_GAP-shaped needs, so all six brief rules and both offer limits apply unchanged; the standby window adds `STANDBY_APPROVAL_LATENCY_MIN` before time-to-online and must be >= 2 h. (4.3) Greedy probabilistic coverage with R(cell) *= (1 - pAccept), ranking by value / burden, stop under 10 EUM or at 3; tested against brute force on 200 seeded cases (always within (1 - 1/e), exact on most). At 18:20 on data/raw: PHY-009 round 1 (131.8 weighted EUM, covers SYN-004/005/008/010), PHY-010 round 2 (30.6, SYN-003/006/007); Cedar Ridge is an empty bench (its credentialed off-shift physicians fail the overlap and 60-h rules). (4.4) Lifecycle commands reuse the roles, 10-min expiry, PHI guard and audit: proposeStandby -> approveStandby (pre-alert sent, simulated) -> respondStandby ready/not_tonight; activation is recommended when a covered cell has P(gap) >= 0.6 within time-to-online + 15 min or a covered hospital is deadlocked, then proposeActivation -> approveActivation -> respondActivation; an activated standby is an accepted split shift (scope = covered hospitals, seed = median of peers via `analyzeTrap`) that flows into `acceptedOffersOf`, so projections, double-accept refusal and cancel-on-fill of other offers apply; the clinical lead releases an acknowledged standby with a release message. Stand-down is recommended after two quiet 5-min recomputes (hysteresis, OQ-51). The coordinator may force an activation with a reason; the lead still approves and the physician still accepts. (4.5) The same physician is never pre-alerted twice in one night; ties prefer lower burden; 7-day alert counts are reported.

**D-94 Rewind (Phase 5, `packages/engine/src/rewind/`, `pnpm report:rewind`).** Origins every 5 min from 16:00 ET to now run decide + forecast + standby plan + activation trigger on knowledge-time state only. The first pre-alert and activation recommended for a hospital that later had routing failures or a deadlock become a counterfactual online time with displayed latencies (lead approval 2, acknowledgment 3, activation approval 2, accept 2 min, then the roster's time to come online; OQ-39). The actual routing_attempt_failed events (and their 5-minute retries, rule 5) after that time are re-evaluated with the EXISTING routing model, the relief physician scoped and seeded (OQ-35); once selected they are busy for the day's empirical median engaged duration of that consult type (assignment to the last video/call end: Stroke 32.3 min, General Neuro 31.7 min). Beyond the stream's end the actual line assumes a deadlock persists until its first known relief (OQ-32); unassigned minutes are counted to now + 60 min. Result on data/raw, as it came out: actual 384.2 stroke consult-minutes unassigned over 60 stroke consults; reactive (split-shift offer at 18:20, online 18:39) 343.4; anticipatory (standby pre-alert recommended 17:20, 33 min before the spike rule tripped at 17:55; activation at the 18:10 deadlock; online 18:29) 333.4. The second deadlocked consult is not taken in either counterfactual because the relief physician is busy with the first until the scheduled 19:00 arrival. Tests: determinism, standby disabled gives the actual outcome, no future leakage, relief never increases a row.

**D-95 Coordinator intelligence (Phase 6, `packages/engine/src/incidents/`).** (1) Incidents group attention items that share a cause, each with the rule that linked them and its member items, so raw items stay reachable: hospital surge with credentialed capacity exhausted (the spike plus the deadlocks, unassigned breaches and coverage gaps at that hospital), a stranded consult (its deadlock plus its own standard breaches), a Temporarily Unavailable physician with assigned consults (plus the breaches on those consults), shift end with open notes (plus the note breaches), coverage gaps per hospital, remaining signal contradictions, and standalone items. Rules apply in that order and every item lands in exactly one incident. At 18:20 on data/raw: 22 items -> 14 incidents (36 % fewer alerts). (2) The horizon timeline (next 180 min) lists shift ends, confirmed and expected arrivals, surge bands (P(spike) >= 0.5), gap bands (P(gap) >= 0.5), offer and standby expiries and action deadlines ("pre-alert by T or the physician cannot be online before the first covered gap", using the standby approval latency, the rewind latencies and the roster's time to come online). (3) The next-best-action queue ranks one-click proposals (reassign, escalate, split-shift offer, standby pre-alert, note handoff, verify presence) by expected stroke-minutes averted per coordinator minute; the averted minutes are the time a stranded consult would wait for its first known relief (OQ-32), the offer's OQ-33 need-minutes or the standby's weighted EUM, times a success probability (roster-based P(accept) for offers and standbys; `NBA_SUCCESS_PROBABILITY` otherwise), with General Neuro minutes weighted 0.25 and coordinator minutes from `NBA_COORDINATOR_MINUTES`; all LOOKAHEAD-DEFINED (illustrative) and shown in the Policy panel. Each card carries the exact command the processor accepts and the approver from DECISION_RIGHTS. Tests: every item in exactly one incident, explainable groups, deterministic under shuffles, stable ranking, timeline sorted and within the horizon.
