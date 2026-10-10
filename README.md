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
- Demo state lives in `data/live/*.jsonl` (replayed on restart). **Reset 18:20** in the top bar clears it.
- Set `LOOKAHEAD_PUBLIC_ORIGIN=http://<LAN-IP>:3000` so the offer QR code opens on a phone.

The 4-minute walkthrough is in `docs/DEMO_SCRIPT.md`; screenshots in `docs/screens/`.
