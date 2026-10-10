# Lookahead

Sevaro Challenge 2 (Tele-Neurology Operations Command Center), Rutgers Health Hack 2026.

Lookahead rebuilds operational state from Sevaro's raw event stream, detects what needs attention now and in the next 60–90 minutes, recommends interventions with rule-by-rule explanations, and runs a human-approved closed loop. See `CLAUDE.md` for the engineering rules and `docs/` for the brief, data profile, open questions and decisions.

```sh
pnpm install
pnpm typecheck && pnpm test   # gate
pnpm recon                    # regenerates docs/DATA_PROFILE.md from data/raw
pnpm lint
```
