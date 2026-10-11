# Open questions

Where the brief (docs/brief_c2.md) is silent or ambiguous. Each entry has a default interpretation, the named constant in `packages/engine/src/policy.ts` that holds it, and how we check it against the 18:20 snapshot or the event stream. Defaults are logged in docs/DECISIONS.md (CLAUDE.md rule 1). Evidence cites docs/DATA_PROFILE.md (`pnpm recon`).

Status key: **Open** = unverifiable from the data, ask Sevaro if possible. **Supported** = the data agrees with the default but does not prove it. **Verified** = the default reproduces a snapshot column exactly.

| ID | Topic | Status |
|---|---|---|
| OQ-01 | Coverage block boundaries | Open |
| OQ-02 | Meaning of "available" for coverage | Supported |
| OQ-03 | Baseline hour time zone | Supported |
| OQ-04 | Duplicate-detection key | Supported |
| OQ-05 | Breach comparison (>= vs >, exact vs floored) | Open |
| OQ-06 | Does documenting count as busy? | Supported |
| OQ-07 | Does "ended a call <2 min ago" include video? | Supported |
| OQ-08 | Does time-to-online count against the 2-hour minimum? | Open |
| OQ-09 | Source of per-week offer counts | Open |
| OQ-10 | Day vs night low-volume threshold | Open |
| OQ-11 | Snapshot "consults" and "calls" counts | Verified |
| OQ-12 | What counts as a "late" event | Supported |
| OQ-13 | Date-less clock values | Verified |
| OQ-14 | Values that exist only in description text | Verified |
| OQ-15 | Derived-state precedence | Supported |
| OQ-16 | When does an offline agent come back? | Supported |
| OQ-17 | incoming_call_ringing semantics | Supported |
| OQ-18 | Event-to-stage mapping and note timer anchor | Verified (mapping) / Open (phone-only) |
| OQ-19 | Demand spike window, comparison, projection | Supported |
| OQ-20 | As-of time of hours_worked_last_7d | Open |
| OQ-21 | Offer/shift overlap boundary; shift-end source | Open |
| OQ-22 | "Open notes within 60 min of shift end" | Open |
| OQ-23 | Assigned-but-not-contacted physician in routing | Supported |
| OQ-24 | Two notions of "available": staffed capacity vs routable now | Implemented (Session 3) |
| OQ-25 | Repeated or backward stage events | Open |
| OQ-26 | Ordering inside routing rule 3's low-volume tier | Open |
| OQ-27 | Scheduled arrivals from the off-shift roster | Supported |
| OQ-28 | Self-reported status during a projection | Open |
| OQ-29 | Arrival confirmation: expected vs confirmed staffing | Open |
| OQ-30 | Which needs make a "hospital with the gap" | Supported |
| OQ-31 | Decision horizon for sizing offers | Supported |
| OQ-32 | How long a routing deadlock lasts | Open |
| OQ-33 | Offer window length and "value of the offer" | Open |
| OQ-34 | Ranking several eligible physicians | Open |
| OQ-35 | Split-shift trap mitigation | Open |
| OQ-36 | Offer expiry boundary | Open |
| OQ-37 | Sequential vs parallel offers; K | Open |
| OQ-38 | What an escalation is | Open |
| OQ-39 | When an accepted offer starts counting | Open |
| OQ-40 | When a need is "filled" | Open |
| OQ-41 | Which offers count toward the weekly cap | Open |
| OQ-42 | Who may cancel an offer | Open |
| OQ-43 | Re-offering after a decline, expiry or rejection | Open |

---

### OQ-01 Coverage block boundaries
- **Brief:** "Each hospital has a minimum number of available, credentialed physicians per time block (coverage_requirements.csv)."
- **Data:** the column is `time_block_et`, so blocks are ET. The values are `07:00-16:00`, `16:00-22:00` and `22:00-07:00`, and they tile 24 h for all 12 hospitals. Which block owns an instant exactly at 16:00 or 22:00 is not stated.
- **Default:** start-inclusive, end-exclusive (`[start, end)`), with `22:00-07:00` wrapping midnight. `COVERAGE_BLOCK_BOUNDARY = 'start_inclusive_end_exclusive'`.
- **Verify:** no snapshot column exposes coverage, so this can't be checked. It only matters at the exact boundary instants.

### OQ-02 Meaning of "available" for coverage
- **Brief:** "A gap exists when that number is not met, either now or at a projected time (for example, when shifts end at 19:00)."
- **Question:** is "available" just on shift and credentialed? Or does it also exclude Temporarily Unavailable, or physicians who are momentarily busy on a call or video?
- **Default:** on shift + credentialed at the hospital + self-reported status not Temporarily Unavailable. A physician busy on a call or video still counts, because busy is momentary and coverage is about staffing. Agent-offline physicians count but are flagged (brief: "Agent offline ... Surface the risk"). `COVERAGE_EXCLUDED_STATUSES = ['Temporarily Unavailable']`, `COVERAGE_COUNTS_BUSY_PHYSICIANS = true`, `COVERAGE_COUNTS_AGENT_OFFLINE = true`.
- **Verify:** use the brief's hidden situation: "Exactly one off-shift physician is fully eligible to cover the projected gap right now. Several others look eligible but fail one rule each."
  - With this default plus OQ-19, a hand check (recon-style script) finds no gap at 18:20 and one projected gap at 19:00 and 19:50: SYN-005 needs 2 and only PHY-005 is left.
  - Off-shift physicians credentialed at SYN-005 are PHY-009, PHY-011, PHY-013 and PHY-014. PHY-009 passes every rule. PHY-011 overlaps their 19:00 shift, PHY-013 has opted out, and PHY-014 has 59 h + offer > 60. That's exactly one eligible, as the brief says.
  - If busy physicians were excluded, 6 of 8 physicians would be "unavailable" at 18:20 and most hospitals would show a gap now, which contradicts the brief's framing.
  - Re-check this once the detector exists.

### OQ-03 Baseline hour time zone
- **Brief:** "trailing 60-minute consults above the hospital's p90 baseline for that hour".
- **Data:** the column is `hour_start_et`. Every hospital's mean peaks at 17:00 ET, including Chicago, Denver and Los Angeles hospitals (DATA_PROFILE "Coverage requirements and baseline volume"). That is consistent with ET buckets, not hospital-local ones.
- **Default:** buckets are ET, and each row covers consults received in `[hour_start, hour_start + 1 h)`. `BASELINE_HOUR_ZONE = ET_ZONE`. "That hour" is the ET hour containing the evaluation time (OQ-19).
- **Addendum (Session 3):** baseline rows have `dow_type = weekday` only. On Monday–Friday ET those rows are used; on a weekend day there is no baseline, so no spike is evaluated (rather than borrowing weekday numbers). `BASELINE_WEEKDAY_DOW_TYPE = 'weekday'`.
- **Verify:** SYN-005 has 5 consults received in (17:20, 18:20] against p90 = 1 for 18:00 ET. That matches the hidden situation "A hospital generates several consults in under an hour, well above its baseline". No other hospital is above its p90.

### OQ-04 Duplicate-detection key
- **Brief:** "handling late and duplicate events"; "One event appears twice in the stream."
- **Data:** `EVT-00529` (video_started, CON-1035, PHY-005) appears on lines 530 and 531. The two rows are identical except `ingested_at` (12:01:38 vs 12:01:40). All three candidate keys catch exactly this pair and nothing else:
  - (a) event_id
  - (b) every column except event_id and ingested_at
  - (c) (event_type, consult_id, physician_id, hospital_id, event_time)
- **Default:** same event = same `event_id` AND identical in every column except `ingested_at`. Keep the earliest-ingested copy. If the same `event_id` arrives with different content, keep both and raise a conflict warning. Key (c) alone is rejected because it would merge two genuinely distinct same-second events. `DUPLICATE_EVENT_KEY = 'event_id_and_payload'`.
- **Verify:** all 18 consult-snapshot and 8 physician-snapshot derivation checks pass with this dedupe. Without it, a replay would start PHY-005's video twice.

### OQ-05 Breach comparison
- **Brief:** "Operational Standards" table, e.g. "Triaged, not yet assigned ... Warning 5 min, Critical 10 min".
- **Question:** is it `>=` or `>`, and on exact elapsed time or floored minutes?
- **Default:** breached when elapsed `>=` threshold, on exact milliseconds. For whole-minute thresholds that is the same as floored minutes `>=` threshold, which is how the snapshot counts minutes (`minutes_in_stage` = floor). `BREACH_COMPARISON = 'gte'`.
- **Verify:** the snapshot has no breach column, so this can't be checked. It only changes the label at exactly N:00 elapsed.

### OQ-06 Does documenting count as busy?
- **Brief:** busy = "On a Synapse call or video session" or camera active without Synapse video. Documentation isn't mentioned. The snapshot shows "Documentation / Note" as a derived state (PHY-004).
- **Default:** documentation is shown, but it does not make a physician busy for routing. `DOCUMENTATION_COUNTS_AS_BUSY = false`.
- **Verify:** in the event stream, 26 of 100 `physician_assigned` events went to a physician with an open note (note_started, not yet note_signed). Routing evidently does not treat documenting as busy.

### OQ-07 Does "ended a call less than 2 minutes ago" include video?
- **Brief:** routing rule 2: "anyone who ended a call less than 2 minutes ago".
- **Default:** hospital calls only (incoming and outgoing), not video. `CALL_COOLDOWN_INCLUDES_VIDEO = false`.
- **Verify:** 12 of 100 assignments happened less than 2 min after the assignee's video ended. Caveat: 6 assignments also happened less than 2 min after a *call* ended, as little as 14 s after. So the historical assignments only loosely follow rule 2 (see DECISIONS D-18). We implement the brief's rule as written.

### OQ-08 Does time-to-online count against the 2-hour minimum?
- **Brief:** "Offers are at least 2 hours long. The estimated time to come online counts against the value of the offer."
- **Default:** the offered window minus `est_minutes_to_online` must be at least 120 min. Example: PHY-009, with 15 min to online, needs an offer of at least 2 h 15 min. `OFFER_TIME_TO_ONLINE_COUNTS_AGAINST_MINIMUM = true`.
- **Verify:** no snapshot evidence. With either reading, PHY-009 stays the single eligible physician for the 19:00 SYN-005 gap (36 h + 2.25 h is under 60 h).
- **Addendum (Session 4):** the offered start is `now + est_minutes_to_online`, so the rule is `(end − now) − est_minutes_to_online = end − start ≥ 120 min`. The time to online is subtracted exactly once. Each rule is sized on its own so a failure is attributed to the rule that causes it:
  - rule 6 sizes the window from the covered needs and `MAX_OFFER_HOURS` only;
  - rule 5 checks that a 2-h offer fits before `next_shift_start`;
  - rule 4 checks that the 60-h headroom is at least 2 h.

  The final window is the minimum of all four caps (OQ-33). At 18:20: PHY-009 is offered 18:20–22:35 = 255 min, minus 15 min = 240 min, so it passes.

### OQ-09 Source of per-week offer counts
- **Brief:** "no more than 3 offers per physician per week".
- **Data:** the roster has `offers_declined_last_30d` (a 30-day decline count) but no offers-this-week column.
- **Default:** count offers from our own offer log in the current ISO week (Monday 00:00 ET), starting at 0 for every physician. Declines are a ranking signal only. `WEEKLY_OFFER_COUNT_SOURCE = 'offer_log_iso_week_et'`.
- **Verify:** not in the data. Show the count and its source in the UI.

### OQ-10 Day vs night low-volume threshold
- **Brief:** routing rule 3: "6 or fewer consults on days, 4 or fewer on nights".
- **Data:** physicians_on_shift.csv has no role column. The roster has `role` (Day / Night / Float). A mid-shift joiner's day/night status is undefined.
- **Default:** a shift or split-shift offer that starts in `[06:00, 18:00)` ET is a day shift, otherwise night. This applies to on-shift physicians (all 8 start 07:00–10:00, so all are day) and to joiners (by offer start, whatever their roster role). `DAY_SHIFT_START_WINDOW_ET`.
- **Verify:** later, by replaying routing at the 100 `physician_assigned` events (approximate only; see OQ-07).

### OQ-11 Snapshot "consults" and "calls" counts
- **Data:** `consults_this_shift` = count of `physician_assigned`. `calls_this_shift` = count of `incoming_call_started` + `outgoing_call_started`, with `incoming_call_ringing` excluded. Including ringing would give PHY-007 7 instead of 6.
- **Default:** as derived. "This shift" counters restart at the physician's `shift_started` event. In the reference data every physician has exactly one, at shift start, so the reset doesn't change any count. `CONSULT_COUNT_EVENT_TYPES`, `CALL_COUNT_EVENT_TYPES`, `SHIFT_COUNTERS_RESET_ON_SHIFT_STARTED = true`.
- **Verify:** reproduces 8/8 rows of snapshot_physicians_1820.csv, both in recon and in the engine replay (`test/golden.snapshot.test.ts`).

### OQ-12 What counts as a "late" event
- **Brief:** "Events can arrive late. Every event carries both event_time and ingested_at. State built only from arrival order will be wrong."
- **Data:**
  - Counted strictly against rows ingested earlier, 13 rows are late. Treating rows with an equal `ingested_at` as "before" gives 23.
  - All but one have a lag of 3–4 s, which is normal ingestion jitter (lags are 1–4 s for 1,163 of 1,164 rows).
  - The one real late arrival is `EVT-01161`: video_started for CON-2107 by PHY-006, event_time 18:11:20, ingested 18:18:05, lag 405 s. It matches the brief's "A video-start event arrives several minutes after it happened."
- **Default:** the replay always orders by `(event_time, ingested_at, file order)`, so lateness never changes state. The UI flags an event as late when its lag exceeds 60 s. `LATE_EVENT_FLAG_LAG_MS = 60_000`.
- **Verify:** PHY-006's derived_state "Video Consult In Progress" at 18:20 needs EVT-01161 placed at its event_time. Between 18:11:23 and 18:18:05, arrival-order state would show "Camera Active - No Synapse Session" instead: a false external-video flag.

### OQ-13 Date-less clock values
- **Data:** `stage_entered_at` (HH:MM:SS), `shift_et`, `shift_start_et`, `shift_end_et`, `time_block_et` and `hour_start_et` carry no date and no offset.
- **Default:** ET wall-clock on the ET date of the latest `event_time` (2026-03-17). An end at or before its start is on the next day. `SNAPSHOT_CLOCK_ZONE = ET_ZONE`.
- **Verify:** `minutes_in_stage` = floor((18:20 − stage_entered_at) / 1 min) reproduces 18/18. `minutes_to_shift_end` reproduces 8/8.

### OQ-14 Values that exist only in description text
- **Data:**
  - Self-reported status appears only as `physician_status_changed` description "Self-reported status: <value>" (values Available, In Meeting, Temporarily Unavailable).
  - Consult type appears only as `consult_received` description "<Stroke|General Neuro> consult request received".
  - Phone-only appears as "Call ends; phone-only consult (outside treatment window)".
- **Default:** parse these exact patterns. A value outside the brief's lists is an error, not a guess. `STATUS_DESCRIPTION_PREFIX`, `CONSULT_TYPE_DESCRIPTION_SUFFIX`, `PHONE_ONLY_DESCRIPTION_MARKER`.
- **Verify:** reproduces `self_reported_status` 8/8 and `consult_type` 18/18.

### OQ-15 Derived-state precedence
- **Brief:** lists the signals but not which label wins when several are active.
- **Data:** PHY-003 at 18:20 has an outgoing call open and a note open (CON-2111), and the snapshot says "Outgoing Hospital Call". PHY-002 and PHY-006 have video and camera both active, and the snapshot says "Video Consult In Progress".
- **Default:** first match wins: incoming call → outgoing call → video → camera without Synapse (status not In Meeting) → Temporarily Unavailable → documentation → In Meeting → Available. `DERIVED_STATE_PRECEDENCE`.
- **Verify:** reproduces 8/8 `derived_state`. Where Temporarily Unavailable ranks against an active call is not covered by the data.

### OQ-16 When does an offline agent come back?
- **Brief:** "Agent heartbeat: Online / offline (offline means camera state is unknown)". The only event type is `agent_heartbeat_lost`; there is no "restored" event.
- **Default:** offline from `agent_heartbeat_lost` until that physician's next `camera_active` or `camera_inactive`, which proves the agent is reporting again. Camera state is "unknown" while offline (`camera.active = null` in PhysicianState). Before any agent event, the agent counts as online: offline is only ever signalled by `agent_heartbeat_lost`. `AGENT_BACK_ONLINE_ON_CAMERA_EVENT = true`.
- **Verify:** PHY-007 goes offline at 17:38:00 with no later camera event, so "Offline" at 18:20 (8/8 `desktop_agent`). "Offline for the rest of the shift" would also match, so this case doesn't decide between them.

### OQ-17 incoming_call_ringing semantics
- **Data:** the single ringing event is CON-2109 to PHY-007 at 18:19:40. CON-2109 was never triaged or assigned. The snapshot keeps CON-2109 "Received" / "Unassigned", and PHY-007's calls stay at 6.
- **Default:** ringing marks that physician's phone as ringing (routing rule 2 exclusion) until their next call event. It does not assign the consult, change its stage or count as a call. No timeout is assumed. `RINGING_TIMEOUT_MS = null`.
- **Verify:** consistent with the snapshot's `physician_id`, `current_stage` and `calls_this_shift`.

### OQ-18 Event-to-stage mapping and note timer anchor
- **Brief:** lists the lifecycle and says "Not every consult passes through every stage. Phone-only consults skip video." Note standards run "from end of video or call".
- **Data:**
  - The mapping in DATA_PROFILE reproduces `current_stage` and `stage_entered_at` 18/18: consult_received→Received, consult_triaged→Triaged, physician_assigned→Assigned, incoming_call_started (while Assigned)→Provider Contacted, imaging_requested→CT/CTA or Imaging Pending, imaging_returned→Imaging Review, video_started→Video Consult In Progress, video_ended→Note Pending, note_started→Documentation, note_signed→Signed Off.
  - Outgoing calls (always after imaging), call ends, ringing and routing failures do not change stage. CON-2102 stays in imaging pending through its 18:16:20 outgoing call.
  - Open sub-question: 15 consults had a note but no video (phone-only). Only CON-2111's call end says "phone-only", so for the others Note Pending entry is not signalled.
- **Default:** the mapping above. A call end carrying the phone-only marker moves the consult to Note Pending. The note timer anchor is the later of the last video_ended and the last call end. CON-2111 is therefore timed from 17:45:50, giving 34 min at 18:20 and a Stroke warning at 30. `NOTE_TIMER_ANCHOR = 'latest_video_or_call_end'`, `PHONE_ONLY_DESCRIPTION_MARKER`.
- **Verify:** the mapping is verified. The phone-only anchor is not visible in the snapshot.

### OQ-19 Demand spike window, comparison, projection
- **Brief:** "A demand spike (trailing 60-minute consults above the hospital's p90 baseline for that hour) raises the requirement by one."
- **Default:** count `consult_received` in `(t − 60 min, t]` and compare strictly greater (`>`) against `p90_consults` for the ET hour containing `t`. A hospital in spike at `now` keeps +1 for the whole projection horizon. Already-received consults are not aged out with zero future arrivals; doing that would end the SYN-005 surge at 19:15 and understate a live surge. `DEMAND_SPIKE_WINDOW_MS`, `DEMAND_SPIKE_COMPARISON = 'gt'`, `DEMAND_SPIKE_PROJECTION = 'hold_from_now_through_horizon'`.
- **Verify:** SYN-005 (5 vs p90 1) is the only spike at 18:20. With the hold it produces the single projected gap in OQ-02.

### OQ-20 As-of time of hours_worked_last_7d
- **Brief:** "Hours worked in the trailing 7 days plus the offered hours do not exceed 60."
- **Default:** take the roster value as-is (as of load), add the offered hours, and don't recompute the trailing window at the offer start. `HOURS_7D_AS_OF = 'roster_value_at_load'`.
- **Verify:** not in the data. PHY-014 (59 h) fails under any reading for an offer of at least 2 h.

### OQ-21 Offer/shift overlap boundary; shift-end source
- **Brief:** "The offer does not overlap a shift they are already scheduled for." The roster gives `next_shift_start` only. There is no `shift_ended` event type; shift ends come from physicians_on_shift.csv `shift_end_et`.
- **Default:** intervals are half-open, so an offer may end exactly at `next_shift_start`. On-shift physicians leave at `shift_end_et` (ET, scenario date). `OFFER_MAY_END_AT_NEXT_SHIFT_START = true`.
- **Verify:** PHY-011 (next shift 19:00) can't take an offer starting at 19:00 under either reading. That matches the brief's note "A scheduled night shift is not a split-shift offer."

### OQ-22 "Open notes within 60 min of the physician's shift end"
- **Brief:** "Open notes within 60 min of the physician's shift end — All — Warning: Any — Critical: 2 or more."
- **Question:** is an "open note" a consult in Note Pending or Documentation, or any open consult? Is the window inclusive at exactly 60 min?
- **Default:** consults assigned to the physician in Note Pending or Documentation. The window includes 60. `OPEN_NOTE_STAGES`, `OPEN_NOTES_WINDOW_INCLUSIVE = true`.
- **Verify:** at 18:20, PHY-003 (40 min left) has CON-2111 (Documentation) and CON-2115 (Note Pending): 2, critical. PHY-006 (40 min left) has CON-2118 (Note Pending): 1, warning. Counting all open consults would make both critical (3 each). The brief's "Two physicians are 40 minutes from the end of their shift with several open consults, including unfinished notes" fits either reading.

### OQ-23 Assigned-but-not-contacted physician in routing
- **Brief:** routing rule 2 removes "anyone busy ..., anyone whose phone is already ringing for another call".
- **Data:**
  - At 18:09:10 routing failed for CON-2105 (SYN-010). The only on-shift physicians credentialed at SYN-010 are PHY-002 (on video since 18:06) and PHY-008.
  - At 18:09:10 PHY-008 was still self-reported Available (Temporarily Unavailable only from 18:12:40), with no call, video or camera. PHY-008's one open item: CON-2110 assigned at 18:07:15, with no call yet.
  - Under a literal reading, PHY-008 was eligible and the attempt should have succeeded.
- **Default:** a physician with an assigned consult that has had no call yet is treated as having a phone ringing for it, so routing skips them. `PENDING_FIRST_CONTACT_COUNTS_AS_RINGING = true`.
- **Verify:** this explains all 4 `routing_attempt_failed` events:
  - 18:09:10: PHY-002 video, PHY-008 pending contact.
  - 18:14:10 and 18:19:10: PHY-008 Temporarily Unavailable.
  - 18:17:15 at SYN-005: PHY-003 outgoing call, PHY-005 incoming call, PHY-006 video.
  - None of the 100 historical assignments went to a physician with another consult awaiting first contact.

### OQ-24 Two notions of "available": staffed capacity vs routable now
- **Brief:** "available" appears in two different rules:
  - Coverage: "a minimum number of available, credentialed physicians per time block".
  - Routing: "Remove anyone busy (see availability rules), anyone whose phone is already ringing for another call, and anyone who ended a call less than 2 minutes ago".
- **Problem:** one word, two meanings. If coverage used the routing meaning, the gap count would swing every minute as physicians start and end calls. If routing used the coverage meaning, calls would be sent to physicians already on a call.
- **Default (later sessions must keep these separate):**
  - **(a) STAFFED CAPACITY**, used for coverage requirements and projections: on shift + credentialed at the hospital + self-reported status not Temporarily Unavailable. This is OQ-02's default. Physicians busy on a call or video count. Agent-offline physicians count but are flagged as unverified.
  - **(b) ROUTABLE NOW**, used for the routing twin, "who would get the next call": routing rules 1–2 on top of (a):
    - not busy: Synapse call or video, or camera without Synapse (EXTERNAL_VIDEO_SUSPECTED);
    - not with a ringing phone (OQ-17), including an assigned consult awaiting first contact (OQ-23);
    - not within 2 minutes of a call end (OQ-07: calls only).

    Documenting does not block (OQ-06), and In Meeting is interruptible (brief).
- **Status:** implemented in Session 3. (a) is `detect/coverage.ts`; (b) is `detect/routing.ts` `routableNow` / `chooseRoute`. They are reported side by side (`coverage.routableNow`) and never mixed. Originally documented in Session 2, which did not implement routability. The replay state already holds every input both notions need: `selfStatus`, `activeCalls`, `activeVideo`, `camera`, `agent`, `ringing`, `lastCallEndedMs`, `openConsultIds` / `contactedMs`, `consultsThisShift` and `lastAnsweredMs`.
- **Verify:** (a) against the OQ-02 check (exactly one projected gap, exactly one eligible off-shift physician). (b) against the 4 `routing_attempt_failed` events (OQ-23).

### OQ-25 Repeated or backward stage events
- **Brief:** "Not every consult passes through every stage." It says nothing about an event that maps to the consult's current stage again (e.g. a second `imaging_requested`) or to an earlier one.
- **Data:** neither happens in the reference stream; correct-mode replay produces zero stage warnings. A second imaging request (CT then MRI) or a re-triage is plausible in judges' live data.
- **Default:** re-entering the current stage keeps the original entry time, so the stage timer keeps running from first entry. A move to an earlier lifecycle stage is applied and raises an integrity warning. Nothing changes after Signed Off (warning). `STAGE_REENTRY_KEEPS_ENTRY_TIME = true`, `STAGE_REGRESSION = 'apply_with_warning'`.
- **Verify:** not in the snapshot. Covered by `test/reducer.robustness.test.ts`.

### OQ-26 Ordering inside routing rule 3's low-volume tier
- **Brief:** rule 3: "Physicians with low volume this shift (6 or fewer consults on days, 4 or fewer on nights) get priority". Rule 4: "Otherwise, route to the eligible physician with the fewest consults this shift. Ties go to whoever answered least recently." It doesn't say how to choose *among* several low-volume physicians.
- **Default:** use rule 4's ordering inside the priority tier: fewest consults, then least recently answered (latest `incoming_call_started`; never-answered first), then physician id for determinism. `LOW_VOLUME_TIER_ORDER = 'fewest_consults_then_least_recent_answer'`.
- **Note:** with only day physicians, the tier changes nothing, because sorting by consults already puts ≤ 6 ahead of > 6. It matters when day and night physicians mix: a night physician with 5 consults is not low volume, but a day physician with 6 is (`test/routing.failures.test.ts`).
- **Verify:** informational only. chooseRoute picks the actual historical assignee in 54 of 100 assignments (DECISIONS D-18: the generator only loosely follows rule 2).

### OQ-27 Scheduled arrivals from the off-shift roster
- **Brief:** the off-shift roster note says "PHY-011 and PHY-012 are night physicians whose shifts start at 19:00 and 20:00. A scheduled night shift is not a split-shift offer." The roster gives `next_shift_start` but no shift end.
- **Default:**
  - A roster physician is on shift from `next_shift_start` for `SCHEDULED_SHIFT_HOURS = 12`.
  - From then they count in staffed capacity and satisfy routing rule 1.
  - They are routable but unverified until they produce presence signals.
  - `SCHEDULED_ARRIVALS_COUNT_AS_ON_SHIFT = true`.
  - The projection is also reported without arrivals (`gapsExcludingArrivals`).
- **Effect at 18:20:**
  - PHY-011 (credentialed at SYN-005) arrives at 19:00, so the SYN-005 gap from 19:00 that the no-arrivals variant shows closes, and SYN-005 holds 2/2 until 20:00.
  - At 20:00 PHY-005 leaves. With the held spike (OQ-19), SYN-005 needs 2 and has only PHY-011.
  - At 20:00 SYN-008 (tier A, needs 2) also drops to PHY-011 alone.
  - PHY-012 (20:00) keeps SYN-010 at 1/1.
- **Verify:** the brief's hidden situation "Exactly one off-shift physician is fully eligible to cover the projected gap" still holds. For an offer at the 20:00 SYN-005 / SYN-008 gaps, PHY-009 is the only fully eligible physician:
  - PHY-011 and PHY-012 are on scheduled shifts;
  - PHY-013 has opted out;
  - PHY-014 has 59 h worked;
  - PHY-010 is not credentialed at either hospital.

  To be confirmed in the eligibility session.

### OQ-28 Self-reported status during a projection
- **Brief:** silent on how long a self-reported status lasts.
- **Default:** a physician's current status persists through the projection. PHY-008 (Temporarily Unavailable since 18:12:40) is not counted at SYN-006/007/010/011 for the whole horizon. `PROJECTION_HOLDS_CURRENT_STATUS = true`.
- **Verify:** no snapshot evidence. SYN-010 at 19:00 is 1/1 (PHY-002) under either reading. If PHY-008 came back, SYN-010 would be 2/1 until 20:00.

### OQ-29 Arrival confirmation: expected vs confirmed staffing
- **Brief:** "Availability is inferred", and the roster note "A scheduled night shift is not a split-shift offer". The brief never says whether a scheduled arrival should be trusted before the physician actually shows up.
- **Default:** scheduled arrivals (OQ-27) and accepted split-shift offers count in staffed capacity from their start, but are **expected** until a known `shift_started` event dated at or after their scheduled start (minus `ARRIVAL_CONFIRMATION_EARLY_TOLERANCE_MIN = 0`) confirms them. On-shift roster physicians are their own category. Each projection point and gap reports `staffedConfirmed + staffedExpected = staffed`. Coverage status:
  - `HARD_GAP`: staffed < required.
  - `AT_RISK`: confirmed < required ≤ staffed, and margin (staffed − required) ≤ `AT_RISK_MAX_MARGIN = 0`.
  - `OK`: otherwise.
- **Effect at 18:20:** SYN-005 is AT_RISK 19:00–20:00 (1 confirmed PHY-005 + 1 expected PHY-011 vs 2). Five more hospitals go AT_RISK at 20:00 because they depend on PHY-011 or PHY-012 alone or at zero margin.
- **Verify:** the stream has no `shift_started` for PHY-011 or PHY-012, whose shifts are in the future. `test/arrivals.test.ts` appends one for PHY-011 at 19:00 and checks that SYN-004 at 20:00 goes from AT_RISK to OK once the event is known. A `shift_started` dated before the scheduled start does not confirm.

### OQ-30 Which needs make a "hospital with the gap"
- **Brief:** eligibility rule 2: "They are credentialed at one or more of the hospitals with the gap. Being credentialed elsewhere does not help." Hidden situation: "Exactly one off-shift physician is fully eligible to cover the projected gap right now. Several others look eligible but fail one rule each."
- **Default:** only `DEADLOCK_NOW` and `HARD_GAP` needs qualify a hospital for split-shift offers. `AT_RISK` (a gap that disappears if an expected arrival shows up) is advisory: it triggers a presence check, and it counts in an offer's value (OQ-33), but not in eligibility. `ELIGIBILITY_NEED_KINDS = ['DEADLOCK_NOW', 'HARD_GAP']`.
- **Alternative checked:** if AT_RISK qualified, PHY-010 (credentialed at SYN-003, AT_RISK 20:00–21:00) would also be eligible: 2 eligible physicians, which contradicts "exactly one". It would also change PHY-012 from three failed rules to two (opt-in, overlap).
- **Verify:** under the default exactly one physician (PHY-009) is eligible (`test/eligibility.golden.test.ts`).

### OQ-31 Decision horizon for sizing offers
- **Brief:** coverage must be projected "at least 90 minutes" (Demonstrate #4). Offers must be at least 2 hours long (eligibility rule 6). The brief says nothing about how far ahead an offer's end may be justified.
- **Question:** a need traced only to the 120-min detection horizon (20:20) ends no later than 20:20. Every offer would then be under 2 h effective (PHY-009: 18:35–20:20 = 105 min), so nobody would be eligible.
- **Default:** needs must *start* within the detection horizon (`PROJECTION_HORIZON_MIN = 120`). Their *ends* are traced in a longer decision projection of `DECISION_HORIZON_MIN = 300` (to 23:20). A need still open there ends `'beyond_horizon'`, which caps at 23:20 for arithmetic. The what-if compares before and after over the whole 300 min, so a gap that reopens when an offer ends (SYN-005 HARD_GAP from 22:35) is shown, not hidden by the 120-min start filter.
- **Alternative checked:** with `decisionHorizonMin: 120`, no off-shift physician is eligible (PHY-009 fails rule 6 at 105 min).
- **Verify:** the brief's single eligible physician exists under the default.

### OQ-32 How long a routing deadlock lasts
- **Brief:** routing rule 5: "If no physician is eligible, the request waits and retries every 5 minutes". Silent on when it will end.
- **Default:** a `DEADLOCK_NOW` need runs from now to the first known relief: the earliest scheduled arrival or accepted offer starting after now that counts at that hospital (credentialed and, for an offer, in scope), whether confirmed or expected. With no known relief it runs `DEADLOCK_DEFAULT_WINDOW_MIN = 60` minutes.
- **Effect at 18:20:** SYN-005 (CON-2114) runs to 19:00 (PHY-011). SYN-010 (CON-2105) runs to 20:00 (PHY-012).
- **Note:** PHY-012's only qualifying need (SYN-010) therefore ends when PHY-012's own shift starts, so PHY-012 also fails rule 6 (100 min). This is reported as a surprise; the expectations were not edited.

### OQ-33 Offer window length and "value of the offer"
- **Brief:** "Offers are at least 2 hours long. The estimated time to come online counts against the value of the offer." No maximum length; no definition of value.
- **Default window:**
  - start = now + `est_minutes_to_online`;
  - end = min(latest end of the covered qualifying needs, start + `MAX_OFFER_HOURS = 4`, `next_shift_start`, start + (60 − hours_worked_last_7d) h).
  - Each cap and the binding one are reported.
- **Default value:** need-minutes covered inside [start, end] at the scope hospitals, weighted by need kind: `NEED_VALUE_WEIGHTS = {DEADLOCK_NOW: 3, HARD_GAP: 2, AT_RISK: 1}`. The time to online falls outside the window, so it reduces value.
- **Effect at 18:20:** PHY-009, 18:35–22:35, value 1095 = DEADLOCK 330 + HARD_GAP 550 + AT_RISK 215.
- **Verify:** no data. The weights only matter when more than one physician is eligible.

### OQ-34 Ranking several eligible physicians
- **Brief:** silent; the roster's `offers_declined_last_30d` and `est_minutes_to_online` suggest signals.
- **Default:** `ELIGIBLE_RANK_ORDER`, in order:
  1. value descending;
  2. minutes to online ascending;
  3. declines in the last 30 days ascending;
  4. physician id.
- **Verify:** only one physician is eligible at 18:20. The order is covered by synthetic tests (`test/eligibility.rules.test.ts`).

### OQ-35 Split-shift trap mitigation
- **Brief:** "Your solution must address this, for example by seeding a starting consult count, limiting the joining physician to the gap hospitals, or another approach you can justify."
- **Default:** `TRAP_MITIGATION = 'scope_and_seed'`, applied to every split-shift offer:
  - **SCOPE:** routing is limited to the hospitals of the covered qualifying needs for the offer window. The routing engine refuses out-of-scope hospitals with "outside split-shift scope".
  - **SEED:** the joiner starts at the median consult count (floor for an even count) of on-shift peers at the offer start who are credentialed at the scope hospitals. `TRAP_SEED_STATISTIC = 'median_floor'`.
  - Scheduled arrivals are not ours to scope. They get an advisory SEED analysis only (`arrivalTraps`).
  - The comparison is a static priority snapshot under routing rules 3–4 with peer counts as of now. The Monte Carlo routing twin comes later.
- **Effect at 18:20:**
  - Unmitigated, PHY-009 at 0 consults would be first pick at all four credentialed hospitals (SYN-004/005/008/010; night low-volume limit 4, OQ-10).
  - With SCOPE, SYN-004 (Meadowlands, AT_RISK only) is excluded.
  - With SEED 14 (median of 10, 12, 14, 14, 15, 15), PHY-009 is first pick only at SYN-005, where it ties PHY-003 at 14 and has never answered.
- **Verify:** not in the data; it is a design choice the brief explicitly allows.

### OQ-36 Offer expiry boundary
- **Brief:** "Offers expire if not answered within 10 minutes."
- **Default:** an offer delivered at T is expired at exactly T + 10:00 (`now >= T + 10 min`); a reply at T + 9:59.999 is in time. `OFFER_EXPIRY_BOUNDARY = 'inclusive'`. Expiry is derived from the log (no timer). `tick` writes `offer_expired` with `expiredAtMs = T + 10 min` so the audit log shows it, and is idempotent.
- **Verify:** `test/expiry.test.ts`. In the demo, delivered 18:22:00 → expired 18:32:00.

### OQ-37 Sequential vs parallel offers; K
- **Brief:** "Handle the case where two physicians accept the same offer." Silent on whether several physicians may hold offers for one gap at once.
- **Default:** `OFFER_DISPATCH_MODE = 'sequential'`.
  - **Sequential:** one in-flight offer per need. A second proposal for an overlapping need is INVALID_STATE. After a decline, expiry or rejection, `recommendNext` names the next eligible physician.
  - **Parallel:** `proposeSlot` offers one slot to the top `PARALLEL_OFFER_K = 2` eligible physicians. The first accept in log order wins; every other open offer in the slot is `offer_superseded` ("slot filled by another physician"), and a later accept gets NO_LONGER_AVAILABLE.
  - Concurrent writers use `expectedSeq`: of two accepts against the same log version, one succeeds and the other gets CONFLICT.
- **Why sequential by default:** with exactly one eligible physician at 18:20 the modes behave the same, and sequential never sends an offer that might have to be taken back.
- **Verify:** `test/race.test.ts`, on a test-only roster where PHY-014 has 40 h so two physicians are eligible.

### OQ-38 What an escalation is
- **Brief:** "Escalate to clinical leadership"; the clinical lead can "authorize escalations". The brief never says what an authorized escalation does.
- **Default:** a record, not a change in Synapse. The coordinator raises it (`escalation_raised`, with a subject: need, attention item, consults, hospitals); the clinical lead authorizes it (`escalation_authorized`). Authorization is required (`ESCALATION_REQUIRES_AUTHORIZATION = true`) and happens once. What the lead then does (for example a physician-to-physician handoff outside routing) happens outside the system. Reassignments are likewise recorded as "requested in Synapse" and never mutate Sevaro state.
- **Verify:** `test/roles.test.ts`.

### OQ-39 When an accepted offer starts counting
- **Brief:** "update projected coverage when someone accepts"; "The estimated time to come online counts against the value of the offer."
- **Question:** the window is fixed at proposal (start = proposal time + time to online). The physician accepts later and cannot come online before accepting.
- **Default:** an accepted offer counts as staffed from max(offered start, accepted at + `est_minutes_to_online`) until the offered end. `ACCEPTED_OFFER_START = 'max_offered_start_or_accept_plus_online'`. It stays "expected" until a `shift_started` (OQ-29).
- **Effect at 18:20:** proposed 18:21 (window 18:36–22:36), accepted 18:24, so it counts from 18:39. The Session 4 what-if's 18:35 is reproduced exactly only when the whole loop happens at 18:20 (`test/loop.happy.test.ts`).
- **Alternative:** `'offered_start'` would count from 18:36.

### OQ-40 When a need is "filled"
- **Brief:** "stop sending offers once the gap is filled."
- **Default (`NEED_FILLED_RULE`):** a need is filled when two things hold:
  - an accepted offer whose scope includes the need's hospital has started inside the need;
  - no DEADLOCK_NOW or HARD_GAP (OQ-30) remains at that hospital from that start to the need's end.

  The time before the physician comes online cannot be filled by any offer, so it does not keep the need open.
- **What it drives:**
  - On accept, every other open offer whose frozen needs are all filled is `offer_cancelled` with cause `gap_filled`.
  - `proposeOffer` for a filled need is NEED_ALREADY_FILLED. With no `needIds`, the refusal applies only when all of the physician's needs are filled.
- **Effect at 18:24:** the SYN-005 and SYN-010 deadlocks and HARD_GAP SYN-008 are filled. HARD_GAP SYN-005 is not: it reopens at 22:36 when the offer ends.
- **Verify:** `test/cancel-on-fill.test.ts`.

### OQ-41 Which offers count toward the weekly cap
- **Brief:** "no more than 3 offers per physician per week" (week per OQ-09).
- **Default:** count every offer sent this ISO week, plus offers proposed or approved and not yet sent. Offers rejected by the clinical lead, or cancelled or superseded before sending, never reached the physician and do not count. `WEEKLY_CAP_COUNTS = 'sent_or_pending'`. The roster's `offers_declined_last_30d` stays a ranking signal only (OQ-34); declines in this session do not change it.
- **Verify:** `test/caps.test.ts`.

### OQ-42 Who may cancel an offer
- **Brief:** silent.
- **Default:** the coordinator or the clinical lead (`OFFER_CANCEL_ROLES`) may cancel an offer that is proposed, approved, sent or delivered and not yet answered. Cancelling an accepted shift is out of scope (INVALID_STATE).
- **Verify:** design choice.

### OQ-43 Re-offering after a decline, expiry or rejection
- **Brief:** silent.
- **Default:** `REOFFER_AFTER_DECLINE = false`. `recommendNext` skips a physician who declined, let expire, or was rejected for an overlapping need. Advisory only: the coordinator may still propose them explicitly.
- **Effect at 18:24:** after PHY-009 declines, there is no next candidate, so the escalation stays with the clinical lead.


### OQ-44 Who is acting, in the demo
- **Brief:** "Any message to a physician outside their shift requires a human approval in the demo"; the off-shift physician can "Accept or decline from a phone; nothing else". Real scheduling and messaging systems are out of scope; the brief says nothing about authentication.
- **Default (apps/web, D-66):** no login. The client names its role in `x-lookahead-role` (coordinator, clinical_lead, physician) and its id in `x-lookahead-actor-id`; the engine's `COMMAND_ROLES` decides what that role may do, and `respond` succeeds only when the actor id is the offer's physician (NOT_OWN_OFFER otherwise). The phone view `/offer/[id]` acts as the offer's physician. `system` is reserved for the server (clock ticks).
- **Consequence (Session 6):** anyone who can reach the server can act as any role. Acceptable for a synthetic-data demo; a deployment needs real identity (SSO for staff, signed one-time links for physicians).
- **Session 7 update (D-78):** two demo-grade locks for a server on a public URL.
  - **Offer link tokens.** A physician's link is `/offer/<id>?t=<token>`, with token = HMAC-SHA256(server secret, offer id), 22 chars base64url. The QR encodes it. The phone page, `GET /api/offers/:id` and the `respond` command refuse a missing or wrong token (403 BAD_TOKEN). The secret is `OFFER_LINK_SECRET`, else generated once into `data/live/.secret`.
  - **Lead PIN.** Clinical-lead commands (approve, reject, authorize escalation) and dataset activate/revert need a shared PIN: `LEAD_PIN`, default **2026**. It is entered once on `/lead` (or in the console's role switch) and kept for 12 h in an HttpOnly cookie that holds an HMAC, not the PIN. Without it the API answers 401 PIN_REQUIRED.
  - **Still open:** coordinator commands, event injection, clock and reset (demo controls).
- **Verify:** `apps/web/test/routes.test.ts` (role errors, NOT_OWN_OFFER, PIN, tokens); e2e `loop.spec.ts` (role gating with PIN, token refusal).

### OQ-45 Matching a data package laid out differently
- **Brief:** the live test ("What Teams Must Demonstrate" #8) adds events "in the same format" and says "Your system must update without a restart". It does not ask for a whole replacement package, and it does not say how a differently laid-out one should be read. Swapping the dataset on `/admin/dataset` is our extension, so judges can run Lookahead on data we have not seen. The brief prints its tables with display headers ("Event time", "Phys.", "Hosp.", "Consult") and says "Column headers are hospital IDs without the SYN- prefix" for the credentialing matrix.
- **Default (D-74):** a header matches, in order, by:
  1. an explicit `mapping.json` override;
  2. exact name;
  3. normalized equality (case and punctuation ignored);
  4. the brief's own display headers (`HEADER_ALIASES`);
  5. a unique prefix of at least `HEADER_PREFIX_MIN_LENGTH` (3) characters.

  A file whose name is not recognised is assigned to the kind its headers fit best if at least `FILE_KIND_MIN_HEADER_SCORE` (60 %) of that kind's columns resolve. Edit-distance matches are only ever *suggestions* shown next to a missing column; nothing is guessed silently. Every match is reported with its method, and row errors carry line numbers.
- **Verify:** `packages/engine/test/ingest.test.ts`, `apps/web/test/dataset.test.ts`, e2e `dataset.spec.ts`.

### OQ-46 When the feed counts as quiet
- **Brief:** silent. It covers late events ("Events can arrive late. Every event carries both event_time and ingested_at"), not a feed that goes quiet. Gaps of tens of seconds between events are normal in the package.
- **Default:** the console's "No new Sevaro events since HH:MM:SS" banner appears only when the sim clock is more than `QUIET_FEED_BANNER_MS` (120 000 ms, 2 min) past the last ingested event. This supersedes the Session 6 rule (any gap). At 18:20:00 the last event is 17 s old: no banner. After **Jump 19:00**: banner.
- **Verify:** `apps/web/test/routes.test.ts` ("OQ-46: the quiet-feed banner …").

### OQ-47 Forecasting the brief's spike condition at a future instant
- **Brief:** Detect must cover "what will need attention in the next 60-90 minutes"; a spike is "trailing 60-minute consults above the hospital's p90 baseline for that hour". The brief defines the spike only at the present instant.
- **Default:** P(spike at T) = P(known arrivals in (T-60, t] + future arrivals in (max(t, T-60), T] > p90(hour(T))), with the future arrivals from the Surge Forecast's predictive count (D-85). At T = t this is the detector's flag exactly (tested at every 5-min asOf across the day). Constants: `FORECAST_*`, `HAWKES_*`, `STROKE_SHARE_PRIOR_WEIGHT` in `policy.ts`, all LOOKAHEAD-DEFINED (illustrative).
- **Verify:** `packages/engine/test/forecast.test.ts`; the backtest in docs/FORECAST_BACKTEST.md reports calibration honestly on the one synthetic day.

### OQ-48 Do standby pre-alerts count toward "3 offers per physician per week"?
- **Brief:** "No more than one open offer per physician, and no more than 3 offers per physician per week." A pre-alert is not an offer, but it is a message to an off-shift physician.
- **Default:** conservative: an open standby is the physician's one open offer, and a sent pre-alert counts toward the weekly three (`STANDBY_COUNTS_AS_OFFER = true`). A pre-alert rejected or cancelled before sending does not count.
- **Verify:** `packages/engine/test/standby.test.ts` (OPEN_OFFER_EXISTS while a standby is open; `offerLogEntries` includes the pre-alert).

### OQ-49 May the clinical lead pre-approve an activation?
- **Brief:** "Every offer is approved by the clinical lead on duty before it is sent"; "Any message to a physician outside their shift requires a human approval."
- **Default:** no conditional pre-approval: the pre-alert and the activation are two separate messages, each approved by the lead before it is sent. The activation is proposed only when the trigger holds (or the coordinator forces it with a recorded reason).
- **Verify:** `standby.test.ts` lifecycle tests.

### OQ-50 Standby hours and the 60-hour cap
- **Brief:** "Hours worked in the trailing 7 days plus the offered hours do not exceed 60."
- **Default:** a standby that is never activated adds no hours; eligibility is still checked for the full standby window (the hours the physician might work), and the window end is capped by the remaining headroom. An activated standby's hours count like an accepted offer's.
- **Verify:** ledger rule 4 via `buildLedger` on the risk needs; `windowOf` in `standby/plan.ts`.

### OQ-51 Activation and release thresholds, hysteresis
- **Brief:** silent (the standby network is our extension).
- **Default:** activate when a covered cell has P(gap) >= 0.6 (`STANDBY_ACTIVATE_PGAP`) within time-to-online + 15 min, or a covered hospital is deadlocked now; recommend stand-down when no covered remaining cell has P(gap) >= 0.2 (`STANDBY_RELEASE_PGAP`) at two consecutive 5-min evaluations (`STANDBY_RECOMPUTE_MIN`). The engine is pure, so "two consecutive recomputes" is evaluated as "quiet now and quiet one step earlier" from knowledge-time state.
- **Verify:** `standby.test.ts` (activation recommended by the deadlock; stand-down not recommended while risk is high).
