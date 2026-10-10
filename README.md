# Lookahead

Sevaro Challenge 2 (Tele-Neurology Operations Command Center), Rutgers Health Hack 2026.

Lookahead rebuilds operational state from Sevaro's raw event stream, detects what needs attention now and in the next 60–90 minutes, recommends interventions with rule-by-rule explanations, and runs a human-approved closed loop. See `CLAUDE.md` for the engineering rules and `docs/` for the brief, data profile, open questions and decisions.

```sh
pnpm install
pnpm typecheck && pnpm test   # gate (engine + web route tests)
pnpm lint
pnpm recon                    # regenerates docs/DATA_PROFILE.md from data/raw
```

## Command Center (apps/web)

```sh
pnpm --filter web dev                              # http://localhost:3000
pnpm --filter web build && pnpm --filter web start # production build
pnpm --filter web e2e                              # build + Playwright (chromium)
pnpm --filter web screens                          # build + screenshots into docs/screens/
```

- `/` Command Center (projector): NOW (ranked attention), NEXT 2 HOURS (coverage grid), ACT (recommendation, ledger, trap, what-if, offers).
- `/state` physicians and consults as separate models; `/integrity` replay vs reference snapshot and the late-event story; `/inject` live test rows; `/audit/[offerId]`.
- Phones: `/lead` (clinical lead approvals) and `/offer/[id]` (off-shift physician).
- `/admin/dataset`: upload a different data package (CSVs or a .zip). It shows the ingest report (how each header was matched, missing columns with suggestions, row errors with line numbers) and the snapshot check (x/8, y/18). You can apply header-mapping overrides, then **Activate** (lead PIN) and **Revert**.
- Demo state lives in `data/live/<dataset-key>/*.jsonl` (replayed on restart). **Reset 18:20** in the top bar clears it.
- Set `LOOKAHEAD_PUBLIC_ORIGIN=http://<LAN-IP>:3000` so the offer QR code opens on a phone.
- The lead PIN is `LEAD_PIN` (default `2026`). Physician links carry a signed token (`/offer/<id>?t=…`, `OFFER_LINK_SECRET`).
- **Explain** buttons give a 2–3 sentence briefing of engine facts. When AWS credentials allow Bedrock, Claude writes it and a fidelity guard checks every number, time and name against the facts ("AI-WRITTEN · VERIFIED"). Otherwise the deterministic template is shown ("TEMPLATE"). LLMs never decide.

The 4-minute walkthrough is in `docs/DEMO_SCRIPT.md`; screenshots in `docs/screens/`; judging-day operations (laptop, EC2, Wi-Fi fallback, reset between groups) in `docs/RUNBOOK.md`.

## AWS (optional; everything degrades to local)

| Env | Effect | Without it |
| --- | --- | --- |
| `STORE=dynamo`, `TABLE_NAME`, `AWS_REGION` | Action log + injected events in DynamoDB; conditional writes make a double accept impossible across servers (D-76) | file store in `data/live/` |
| `BEDROCK_MODEL_ID` (optional), `NARRATION=off` to disable | Claude via Bedrock Converse writes Explain text, verified by the guard | template text |
| `AUDIT_BUCKET` | audit CSV + action log archived to S3 before each reset or dataset swap | nothing archived |

```sh
curl -s localhost:3000/api/health                           # {ok, store, bedrock, datasetVersion, clock, ...}
pnpm aws:create-table --table lookahead-log --region us-east-1
PLAYWRIGHT_BASE_URL=http://<host> pnpm --filter web e2e:remote   # @demo e2e against a deployed server
```

EC2 deployment (instance profile, user data, security group, fallbacks): `scripts/aws/deploy-ec2.md`.
