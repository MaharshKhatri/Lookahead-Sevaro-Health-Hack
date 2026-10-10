<!-- Verbatim extraction of docs/brief_c2.pdf via `pdftotext -layout`. Do not edit; re-extract if the PDF changes. -->
# Sevaro Rutgers Health Hack: Challenge 2 brief (extracted text)

```text
                            Rutgers Health Hack Challenge 2
          Tele-Neurology Operations Command Center: From Visibility to Intervention
                                   Sevaro | Detect coverage risk, recommend an intervention, and act on it


 The Challenge
 Sevaro provides tele-neurology services to more than 200 hospitals. During a shift, each physician juggles incoming and
 outgoing hospital calls, video consultations, imaging review and documentation, often for several consults at once. Demand
 is uneven: a single hospital can generate several stroke consults in half an hour, and that surge can coincide with
 physicians reaching the end of their shift.
 Seeing that this is happening is not enough. Operations and clinical leadership need to act while it still matters: reassign a
 stranded consult, escalate a delay, or bring an off-shift physician online for a few hours to cover a gap. Today that decision
 depends on someone noticing, working out who is credentialed and eligible, and reaching them manually.

  A baseline live view already exists. Do not rebuild it. Sevaro already operates a live workload view showing physician
  status, per-physician call and consult counts, and stage timers for stroke consults. A solution that only displays current
  state will score poorly. The value of this challenge is what happens after a problem is detected.




 Figure 1. Recreated sketch of the existing baseline view, populated with this challenge's data at 18:20. Build beyond this, not a copy of it.



 Problem to Solve
 Build an operational system with three connected layers. All three are required.

 Layer              Question it answers                              Examples
 1. Detect          What needs attention now, and what will          Consults breaching time standards; demand above a hospital's baseline;
                    need attention in the next 60-90 minutes?        credentialed capacity below the required level now or after upcoming shift ends;
                                                                     physician signals that contradict each other.
 2. Decide          What is the right intervention, and who has      Reassign a consult; escalate to clinical leadership; offer a split shift. Rank eligible
                    to approve it?                                   off-shift physicians and explain why each one is or is not eligible.
 3. Act             Execute the intervention and close the loop.     Send the offer through an approval step; track accept/decline/timeout; update
                                                                     projected coverage when someone accepts; stop sending offers once the gap is
                                                                     filled.




Sevaro | Rutgers Health Hack | Challenge 2                                                                                                           Page 1
 Figure 2. The closed loop. Detect, Decide and Act are required; the approval step is a person.



 Users and Decision Rights
 User                          Needs to see                                                       Can do
 Operations coordinator        Network-wide queue, breaches, physician activity, projected        Reassign consults, contact physicians, propose
                               coverage gaps                                                      split-shift offers
 Clinical lead on duty         Gaps that put stroke care at risk; proposed interventions with     Approve or reject split-shift offers; authorize
                               rationale                                                          escalations
 Off-shift physician           A clear offer: hospitals, hours, start time, why they were         Accept or decline from a phone; nothing else
                               asked
 Automated actions are permitted only for low-risk steps (for example, an internal alert to the coordinator). Any message to a physician outside their
 shift requires a human approval in the demo.


 Important Data Model Concepts
 Physician state and consult state are separate
 A physician can have several open consults at once: on a call for Consult A while Consult B waits for CT/CTA and Consult C
 has a note pending. Represent physician activity and consult lifecycle independently.




 Figure 3. Built from the event stream. PHY-002 moves between calls and video while three consults progress independently. At 18:20 PHY-002 is
 on video for CON-2101 while CON-2106 waits in imaging review and CON-2117's note has not been started.


 Availability is inferred, not reported
 Physicians do not manually report that they are on a call or on video. Activity is derived from system signals, and those
 signals can disagree. Your solution must reconcile them.

 Signal                            Source                                                    Values
 Self-reported status              Physician sets it in Synapse                              Available, In Meeting, Temporarily Unavailable




Sevaro | Rutgers Health Hack | Challenge 2                                                                                                          Page 2
 Signal                            Source                                               Values
 Hospital call                     Synapse telephony events                             Incoming or outgoing call active / ended
 Synapse video session             Synapse video events                                 Video started / ended
 Camera activity                   Desktop presence agent on the physician's computer   Camera active / inactive
 Agent heartbeat                   Desktop presence agent                               Online / offline (offline means camera state is unknown)

  • On a Synapse call or video session: busy.
  • Camera active with no Synapse video session and status not In Meeting: probably on an external video platform. Treat
     as busy and flag it.
  • Camera active with status In Meeting: available (internal meetings are interruptible).
  • Agent offline: routing assumes the physician is available, but this is unverified. Surface the risk.
  • Events can arrive late. Every event carries both event_time and ingested_at. State built only from arrival order will
     be wrong.

 Consult lifecycle
 Received → Triaged → Assigned → Provider Contacted → CT/CTA or Imaging Pending → Imaging Review → Video
 Consult In Progress → Note Pending → Documentation → Signed Off. Not every consult passes through every stage.
 Phone-only consults skip video. Note Pending means the clinical interaction is over but documentation has not started;
 Documentation means the note is being written.

 How Calls Reach Physicians (Synthetic Routing Rules)
 You need these rules to predict whether an intervention actually relieves a bottleneck. Thresholds are synthetic.
  1. Eligible physicians are on shift and credentialed at the calling hospital.
  2. Remove anyone busy (see availability rules), anyone whose phone is already ringing for another call, and anyone who
     ended a call less than 2 minutes ago.
  3. Physicians with low volume this shift (6 or fewer consults on days, 4 or fewer on nights) get priority at the hospitals they
     are credentialed for.
  4. Otherwise, route to the eligible physician with the fewest consults this shift. Ties go to whoever answered least
     recently.
  5. If nobody is eligible, the routing attempt fails and retries every 5 minutes. In the event stream this appears as
     routing_attempt_failed.

  The split-shift trap. A physician who joins mid-shift starts with zero consults. Under rule 4, routing will send them nearly
  every call at every hospital they are credentialed for, not just the hospitals that needed help. The new physician gets
  overwhelmed and the original imbalance moves rather than resolves. Your solution must address this, for example by
  seeding a starting consult count, limiting the joining physician to the gap hospitals, or another approach you can justify.



 Operational Standards (Synthetic)
 Stage                                                             Applies to               Warning                     Critical
 Triaged, not yet assigned                                         All                      5 min                       10 min
 Assigned, physician not yet contacted                             Stroke                   3 min                       8 min
 CT/CTA or Imaging Pending                                         Stroke                   12 min                      20 min
 Imaging Review (imaging back, video not started)                  Stroke                   6 min                       12 min
 Note Pending + Documentation, from end of video or call           Stroke                   30 min                      45 min
 Note Pending + Documentation, from end of video or call           General Neuro            45 min                      90 min
 Open notes within 60 min of the physician's shift end             All                      Any                         2 or more




Sevaro | Rutgers Health Hack | Challenge 2                                                                                                  Page 3
 Coverage and Split-Shift Eligibility
 Coverage gap. Each hospital has a minimum number of available, credentialed physicians per time block
 (coverage_requirements.csv). A gap exists when that number is not met, either now or at a projected time (for
 example, when shifts end at 19:00). A demand spike (trailing 60-minute consults above the hospital's p90 baseline for that
 hour) raises the requirement by one.
 An off-shift physician may receive a split-shift offer only if all of the following hold:
  • They have opted in to split-shift offers.
  • They are credentialed at one or more of the hospitals with the gap. Being credentialed elsewhere does not help.
  • At least 10 hours have passed since their last shift ended, measured at the offered start time.
  • Hours worked in the trailing 7 days plus the offered hours do not exceed 60.
  • The offer does not overlap a shift they are already scheduled for.
  • Offers are at least 2 hours long. The estimated time to come online counts against the value of the offer.

 Notification and Safety Constraints
  • No patient information in any notification. Hospital names, hours and start time only.
  • Every offer is approved by the clinical lead on duty before it is sent.
  • No more than one open offer per physician, and no more than 3 offers per physician per week.
  • Handle the case where two physicians accept the same offer.
  • Offers expire if not answered within 10 minutes.
  • Log every offer: who was considered, who was excluded and why, who approved, and the outcome.




Sevaro | Rutgers Health Hack | Challenge 2                                                                              Page 4
 Synthetic Dataset
 All files are in the accompanying data package. The scenario covers Tuesday 17 March 2026, 07:00-18:20 Eastern. The
 reference point for "now" is 18:20:00 ET. All timestamps include an explicit UTC offset; hospitals are in four US time
 zones.

 File                                           Contents
 event_stream.csv                               About 1,160 events from 07:00 to 18:20. The source of truth. Sorted by ingested_at.
 hospitals.csv                                  12 hospitals with local time zone and coverage tier
 physicians_on_shift.csv                        8 physicians currently on shift, with shift times
 physicians_off_shift_roster.csv                6 off-shift physicians: opt-in, last and next shift, hours worked, time to come online
 credentialing_matrix.csv                       Which of the 14 physicians may take consults from which of the 12 hospitals
 baseline_hourly_volume.csv                     12-week weekday mean and p90 consults per hospital per hour
 coverage_requirements.csv                      Minimum available credentialed physicians per hospital per time block
 snapshot_*_1820.csv                            Reference state at 18:20. Your replay of the event stream should reproduce it.

 Event types
 consult_received, consult_triaged, physician_assigned, incoming_call_ringing,
 incoming_call_started/ended, outgoing_call_started/ended, imaging_requested,
 imaging_returned, video_started/ended, note_started, note_signed, routing_attempt_failed,
 physician_status_changed, camera_active/inactive, agent_heartbeat_lost, shift_started

 Reference snapshot: physicians at 18:20 ET
 ID         Physician              Shift (ET)       Self-reported         Agent      Derived state                 Cons.      Calls      Open   Min to end
 PHY-001    Dr. Maya Patel         08:00-20:00      Available             Online     Camera Active - No            12         13         1      100
                                                                                     Synapse Session
 PHY-002    Dr. Daniel Kim         08:00-20:00      Available             Online     Video Consult In Progress     14         16         3      100
 PHY-003    Dr. Sofia Ramirez      07:00-19:00      Available             Online     Outgoing Hospital Call        14         17         3      40
 PHY-004    Dr. Ethan Brooks       09:00-21:00      Available             Online     Documentation / Note          14         18         2      160
 PHY-005    Dr. Priya Shah         08:00-20:00      Available             Online     Incoming Hospital Call        15         18         2      100
 PHY-006    Dr. Marcus Lee         07:00-19:00      Available             Online     Video Consult In Progress     15         19         3      40
 PHY-007    Dr. Elena Torres       10:00-22:00      Available             Offline    Available                     6          6          0      220
 PHY-008    Dr. Noah Williams      08:00-20:00      Temporarily           Online     Temporarily Unavailable       10         11         1      100
                                                    Unavailable
 The self-reported status reads Available for most physicians who are busy. That is expected: activity is derived, not reported.




Sevaro | Rutgers Health Hack | Challenge 2                                                                                                            Page 5
 Reference snapshot: open consults at 18:20 ET
 Consult      Hospital                               Physician         Type            Current stage                 Entered        Min in         Min since
                                                                                                                                    stage          received
 CON-2101     Northfield Medical (SYN-008)           PHY-002           Stroke          Video Consult In Progress     18:06:00       14             39
 CON-2102     Lakeview Hospital (SYN-009)            PHY-003           Stroke          CT/CTA or Imaging             17:54:00       26             36
                                                                                       Pending
 CON-2103     Cedar Ridge Medical Center             PHY-004           General Neuro   Note Pending                  17:46:00       34             75
              (SYN-001)
 CON-2104     Meadowlands Community Hospital         PHY-005           Stroke          Provider Contacted            18:14:00       6              9
              (SYN-004)
 CON-2105     Oak Valley Medical (SYN-010)           Unassigned        Stroke          Triaged                       18:09:05       10             12
 CON-2106     Silver Oak Health Center (SYN-007)     PHY-002           General Neuro   Imaging Review                18:02:00       18             60
 CON-2107     Suncrest Medical Pavilion (SYN-005)    PHY-006           Stroke          Video Consult In Progress     18:11:20       8              15
 CON-2108     Redwood University Medical Center      PHY-004           Stroke          Documentation                 18:04:00       16             33
              (SYN-003)
 CON-2109     Westbridge Hospital (SYN-012)          Unassigned        General Neuro   Received                      18:16:00       4              4
 CON-2110     Harbor Regional (SYN-011)              PHY-008           Stroke          Assigned                      18:07:15       12             16
 CON-2111     Suncrest Medical Pavilion (SYN-005)    PHY-003           Stroke          Documentation                 18:00:10       19             39
 CON-2112     Suncrest Medical Pavilion (SYN-005)    PHY-006           Stroke          Imaging Review                18:04:50       15             29
 CON-2113     Suncrest Medical Pavilion (SYN-005)    PHY-005           Stroke          Note Pending                  18:11:50       8              25
 CON-2114     Suncrest Medical Pavilion (SYN-005)    Unassigned        Stroke          Triaged                       18:17:10       2              4
 CON-2115     Lakeview Hospital (SYN-009)            PHY-003           General Neuro   Note Pending                  17:30:00       50             90
 CON-2116     Highland Valley Hospital (SYN-006)     PHY-001           General Neuro   Note Pending                  17:58:00       22             70
 CON-2117     Oak Valley Medical (SYN-010)           PHY-002           General Neuro   Note Pending                  17:40:30       39             99
 CON-2118     Westbridge Hospital (SYN-012)          PHY-006           General Neuro   Note Pending                  17:35:00       45             78

 Event stream excerpt (ingested 18:09-18:20 ET)
 Event        Event      Ingested    Consult        Type                           Phys.         Hosp.      Description
              time
 EVT-01143    18:09:05   18:09:07    CON-2105       consult_triaged                              SYN-010    Consult triaged
 EVT-01144    18:09:10   18:09:13    CON-2105       routing_attempt_failed                       SYN-010    No available credentialed provider; retry scheduled
 EVT-01145    18:10:40   18:10:41    CON-2107       incoming_call_ended            PHY-006       SYN-005    Call ends
 EVT-01146    18:10:45   18:10:46                   physician_status_changed       PHY-006                  Self-reported status: Available
 EVT-01147    18:11:00   18:11:03    CON-2104       consult_received                             SYN-004    Stroke consult request received
 EVT-01148    18:11:22   18:11:23                   camera_active                  PHY-006                  Desktop agent: camera active
 EVT-01149    18:11:50   18:11:53    CON-2113       video_ended                    PHY-005       SYN-005    Video consult completed; note not started
 EVT-01150    18:11:53   18:11:54                   camera_inactive                PHY-005                  Desktop agent: camera inactive
 EVT-01151    18:12:30   18:12:33    CON-2104       consult_triaged                              SYN-004    Consult triaged
 EVT-01152    18:12:40   18:12:41                   physician_status_changed       PHY-008                  Self-reported status: Temporarily Unavailable
 EVT-01153    18:13:40   18:13:41    CON-2104       physician_assigned             PHY-005       SYN-004    Consult assigned
 EVT-01154    18:14:00   18:14:03    CON-2104       incoming_call_started          PHY-005       SYN-004    Hospital calls assigned physician
 EVT-01155    18:14:10   18:14:12    CON-2105       routing_attempt_failed                       SYN-010    No available credentialed provider; retry scheduled
 EVT-01156    18:15:30   18:15:33    CON-2114       consult_received                             SYN-005    Stroke consult request received
 EVT-01157    18:16:00   18:16:03    CON-2109       consult_received                             SYN-012    General Neuro consult request received
 EVT-01158    18:16:20   18:16:21    CON-2102       outgoing_call_started          PHY-003       SYN-009    Provider calls hospital to check CT/CTA status
 EVT-01159    18:17:10   18:17:14    CON-2114       consult_triaged                              SYN-005    Consult triaged
 EVT-01160    18:17:15   18:17:18    CON-2114       routing_attempt_failed                       SYN-005    No available credentialed provider; retry scheduled
 EVT-01161    18:11:20   18:18:05    CON-2107       video_started                  PHY-006       SYN-005    Video consult begins
 EVT-01162    18:19:10   18:19:14    CON-2105       routing_attempt_failed                       SYN-010    No available credentialed provider; retry scheduled
 EVT-01163    18:19:40   18:19:43    CON-2109       incoming_call_ringing          PHY-007       SYN-012    Hospital call ringing to intended physician; not yet
                                                                                                            answered




Sevaro | Rutgers Health Hack | Challenge 2                                                                                                                 Page 6
 Credentialing matrix (Y = credentialed)
 Physician                                   001         002      003        004   005       006       007          008          009     010      011       012
 PHY-001 Dr. Maya Patel                      Y                               Y               Y                      Y            Y                Y         Y
 PHY-002 Dr. Daniel Kim                                  Y                                             Y            Y                    Y        Y
 PHY-003 Dr. Sofia Ramirez                   Y                               Y     Y                                             Y                          Y
 PHY-004 Dr. Ethan Brooks                    Y                    Y                          Y         Y                         Y
 PHY-005 Dr. Priya Shah                                           Y          Y     Y                                Y                             Y
 PHY-006 Dr. Marcus Lee                      Y                               Y     Y         Y                      Y            Y                Y         Y
 PHY-007 Dr. Elena Torres                                Y                                                                                                  Y
 PHY-008 Dr. Noah Williams                                                                   Y         Y                                 Y        Y
 PHY-009 Dr. Grace Okafor                                                    Y     Y                                Y                    Y
 PHY-010 Dr. Ben Alvarez                                 Y        Y                          Y         Y
 PHY-011 Dr. Hannah Cho                      Y                               Y     Y                                Y            Y                Y
 PHY-012 Dr. Omar Haddad                                 Y        Y                          Y         Y                                 Y                  Y
 PHY-013 Dr. Lucy Brennan                                                          Y                                             Y       Y        Y
 PHY-014 Dr. Ravi Menon                      Y                                     Y                                                     Y
 Column headers are hospital IDs without the SYN- prefix. PHY-001 to PHY-008 are on shift; PHY-009 to PHY-014 are off shift.

 Off-shift roster
    ID          Physician              Role        Opt-in      Last shift ended    Next shift starts       Hrs 7d       Min to         Channel        Declined
                                                                                                                        online                        30d
    PHY-009     Dr. Grace Okafor       Day         Yes         03-17 07:00         03-18 19:00             36           15             app_push       1
    PHY-010     Dr. Ben Alvarez        Float       Yes         03-16 20:00         03-19 08:00             24           10             sms            0
    PHY-011     Dr. Hannah Cho         Night       Yes         03-17 07:00         03-17 19:00             48           0              app_push       2
    PHY-012     Dr. Omar Haddad        Night       No          03-16 08:00         03-17 20:00             36           0              app_push       0
    PHY-013     Dr. Lucy Brennan       Day         No          03-16 20:00         03-18 08:00             48           20             sms            5
    PHY-014     Dr. Ravi Menon         Float       Yes         03-16 20:00         03-19 07:00             59           40             sms            0
 PHY-011 and PHY-012 are night physicians whose shifts start at 19:00 and 20:00. A scheduled night shift is not a split-shift offer.


 Operational Situations Hidden in the Dataset
 The dataset contains every situation below. Some are visible in the snapshot; others only appear when you replay the event
 stream correctly or project forward in time.
  • A stroke consult is triaged but unassigned because every credentialed physician is busy or unavailable.
  • A hospital generates several consults in under an hour, well above its baseline.
  • Two physicians are 40 minutes from the end of their shift with several open consults, including unfinished notes, during
     that surge.
  • A physician becomes temporarily unavailable while a stroke consult is still assigned to them.
  • A physician's camera is active with no Synapse session.
  • A physician looks available, but their presence agent is offline.
  • A video-start event arrives several minutes after it happened.
  • One event appears twice in the stream.
  • Workload is uneven, and the cause is credentialing rather than effort.
  • An incoming call rings while most on-shift physicians are occupied.
  • Exactly one off-shift physician is fully eligible to cover the projected gap right now. Several others look eligible but fail one
     rule each.

 What Teams Must Demonstrate
  1. Rebuild current state from the event stream, handling late and duplicate events, and match the reference snapshot.
  2. Show physician activity and the consult lifecycle independently, with time in stage measured against the standards.
  3. Detect and rank what needs attention, and explain why each item was flagged.


Sevaro | Rutgers Health Hack | Challenge 2                                                                                                                   Page 7
  4. Project coverage forward at least 90 minutes, accounting for shift ends and the demand baseline.
  5. Recommend an intervention for the top issue. For a split shift, show every off-shift physician considered and the rule
     each one passed or failed.
  6. Run the full loop: propose, approve, send (simulated), accept or decline, update projected coverage.
  7. Show how you handle the split-shift trap.
  8. Live test. During your demo, judges will add new events in the same format (for example, another stroke consult at the
     surging hospital). Your system must update without a restart.

 Out of Scope
 Clinical decisions about individual patients; real scheduling, credentialing or messaging systems; compensation for split
 shifts; building the production routing engine (model its effect, do not replace it).

 Data and Safety Boundary
 All physicians, hospitals, consults, timestamps, activity states, credentials, schedules and events in this challenge are
 synthetic. Thresholds and routing rules are illustrative and do not reflect Sevaro's production configuration. No patient
 identifiers, PHI, real physician activity, hospital production data, credentials or production-system access will be provided or
 required.




Sevaro | Rutgers Health Hack | Challenge 2                                                                                   Page 8
```
