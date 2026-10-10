# 4-minute demo script

Everything on screen is engine output on the reference data package. Times are sim-clock ET.

## Setup (before judges arrive)

```sh
pnpm install
pnpm --filter web build
LOOKAHEAD_PUBLIC_ORIGIN=http://<laptop-LAN-IP>:3000 pnpm --filter web start   # QR links reachable from phones
```

- Projector: `http://localhost:3000/` at 1920×1080, role **Coordinator**.
- Phone A (clinical lead): `http://<laptop-LAN-IP>:3000/lead`.
- Phone B (off-shift physician): scans the QR that appears after approval.
- Click **Reset 18:20** in the top bar. The clock is **paused, 1×** for the whole demo; nothing moves unless you move it.

## Click path

| time | sim clock | what you click | what you say |
| --- | --- | --- | --- |
| 0:00 | 18:20:00 paused | nothing | "Sevaro already shows state. Lookahead decides and acts." Point at **#1 CRITICAL STROKE: CON-2105 at Oak Valley, no routable physician**: the why bullets, the score bar (60 + 30 + 25 + 20 = 135), the evidence chips (hover EVT-01144: routing_attempt_failed 18:09:10). |
| 0:30 | 18:20 | nothing | Center grid: Suncrest and Oak Valley are **DEADLOCK** now (staffed 3/2 and 1/1, routable 0); 19:00 and 20:00 shift-change markers; **HARD GAP** at Suncrest and Northfield from 20:00; **SPIKE Suncrest 5/hr vs p90 1**. |
| 0:50 | 18:20 | top bar **Integrity** | "8/8 · 18/18 · 0 diffs" vs "Naive arrival order: 40 diffs". Drag the slider to 18:15: PHY-006 looked like an external video call until EVT-01161 arrived 6.8 min late. Back to **Command**. |
| 1:20 | 18:20 | ACT panel, read the chain | Reassign → no routable candidate (PHY-002 on video, PHY-008 unavailable) → Escalate → **Split-shift offer to Dr. Grace Okafor 18:35–22:35, scope Suncrest/Northfield/Oak, seed 14**. |
| 1:35 | 18:20 | **LEDGER** tab | 6 off-shift physicians, 1 eligible. Point at the red chips: "No gap hospital", "Next shift +40 min", "Opt-in No", **"59+2=61 > 60"**. |
| 1:50 | 18:20 | **TRAP** tab | Before: 0 consults, first pick at 4 hospitals incl. Meadowlands. After SCOPE + SEED: Meadowlands crossed out, seed = median(10, 12, 14, 14, 15, 15) = 14, first pick only at Suncrest. |
| 2:05 | 18:20 | **WHAT-IF** tab | Oak Valley deadlock 100 → 15 min; Northfield HARD GAP downgraded; Suncrest 19:00 AT RISK closed. |
| 2:15 | 18:20 | **Propose offer** | Toast; OFFERS tab shows **PROPOSED**. |
| 2:25 | 18:20 | Phone A: **Approve** | The lead sees the rationale in plain words and the exact message. Projector: **DELIVERED**, expiry countdown 10:00, QR. |
| 2:45 | 18:20 | Phone B: scan QR, **Accept** | The phone shows only hospitals, hours, start time, generic reason. Projector (no reload): **ACCEPTED**; Suncrest/Oak deadlock cells now end at 18:35; WHAT-IF shows the effect recorded at acceptance. |
| 3:10 | 18:20 | OFFERS → **Audit trail** | 6 considered, each exclusion with numbers, who approved, outcome, CSV. |
| 3:25 | 18:20 → 18:21:47 | **Inject** → **Insert sample** → **Submit rows** (advance on) | Live test: a new stroke consult at Suncrest. Back on **Command**: CON-2119 appears as a routing deadlock near the top (measured ~0.5 s via SSE), spike now 6/hr. Judges can paste their own rows here instead. |
| 3:45 | 19:00 | **Jump 19:00** (optional) | PHY-003 and PHY-006 drop off; the grid and attention list re-project. Close. |

## If something goes wrong

- Anything odd: **Reset 18:20** clears injected rows and the action log.
- Phones cannot open the QR link: the server was started without `LOOKAHEAD_PUBLIC_ORIGIN`, or the phones are on another network. Type the URL shown under the QR.
- A command is refused: the toast shows the engine's reason in plain English (for example, the clock was moved back before the last action; move it forward).
