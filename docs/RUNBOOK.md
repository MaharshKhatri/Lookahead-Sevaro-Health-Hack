# Runbook (judging day)

Four ways to run the demo, from most to least self-contained. In every mode the app behaves the same. AWS adds a shared action log (DynamoDB), AI-written briefings (Bedrock) and an audit archive (S3), and each of those degrades on its own. `GET /api/health` always tells you what is live:

```sh
curl -s http://<host>/api/health
# {"ok":true,"store":"file","bedrock":"unavailable",...,"datasetVersion":1,"clock":{"nowMs":1773786000000,"mode":"paused","speed":1}}
```

| Field | Meaning |
| --- | --- |
| `store` | `file` · `dynamo (<table>)` · `file (dynamo unavailable: <reason>)` once degraded |
| `bedrock` | `available` (model in `bedrockModel`) or `unavailable` (`bedrockReason`); Explain then shows **TEMPLATE** text |
| `dataset` / `datasetVersion` | which data package is active; the version bumps on every activate/revert |
| `clock` | sim clock (paused at 18:20 ET after a reset: `nowMs` 1773786000000) |

Phones need two secrets, both shown on screen or typed by you:
- **Clinical lead PIN.** `LEAD_PIN`, default **2026**. Asked once on `/lead`, and when the console switches to the Clinical lead role or activates a dataset. It is kept 12 h in an HttpOnly cookie.
- **Physician offer link.** `/offer/<id>?t=<token>`. The QR under a delivered offer encodes it. Without the token the page says "This offer link is not valid." and the API answers 403 BAD_TOKEN.

## (a) Laptop mode (no AWS, no internet needed)

```sh
pnpm install
pnpm --filter web build
LOOKAHEAD_PUBLIC_ORIGIN=http://<laptop-LAN-IP>:3000 pnpm --filter web start
```

- Find the LAN IP with `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).
- Projector: `http://localhost:3000/`. Lead phone: `http://<laptop-LAN-IP>:3000/lead`, PIN 2026. Physician phone: scan the QR after approval.
- Storage is `data/live/<dataset-key>/` (JSONL, replayed on restart). Narration is TEMPLATE unless the laptop has AWS credentials with Bedrock access (`NARRATION=off` forces template).
- Check: `curl -s localhost:3000/api/health` → `"store":"file"`.

## (b) EC2 mode (AWS Workshop Studio, us-east-1)

Follow `scripts/aws/deploy-ec2.md`, which is copy-paste CloudShell commands with expected output. In short:
1. Upload a `git archive` tarball to CloudShell.
2. `aws bedrock list-inference-profiles` → pick Claude Haiku.
3. Create the DynamoDB table (on-demand), the S3 bucket and the IAM role + instance profile (`scripts/aws/iam-policy.json`).
4. Create the security group: 80 open, 22 from your IP.
5. `run-instances` with `scripts/aws/user-data.sh`. It installs Node 20 + pnpm, builds, and runs `next start -p 80` under systemd.

Open `http://<public-dns>/`. QR links already point there (`LOOKAHEAD_PUBLIC_ORIGIN` is set from instance metadata).
- If DynamoDB/IAM is blocked, use `STORE=file`. If Bedrock is not enabled, use `NARRATION=off` or leave it on: template text is served automatically.
- Verify from the laptop with `PLAYWRIGHT_BASE_URL=http://<public-dns> pnpm --filter web e2e:remote` (3 `@demo` tests; resets the server's demo state).

## (c) Wi-Fi fallback (venue Wi-Fi blocks phone ↔ laptop)

Venue networks often isolate clients, so the phones cannot reach the laptop.
1. Turn on your **phone's hotspot** and join the laptop and the second phone to it.
2. Find the laptop's address on the hotspot (`ipconfig getifaddr en0` / `hostname -I`). iPhone hotspots use `172.20.10.x`; Android hotspots often `192.168.43.x`.
3. Restart with that origin so the QR codes point to it:
   ```sh
   LOOKAHEAD_PUBLIC_ORIGIN=http://172.20.10.2:3000 pnpm --filter web start
   ```
4. On EC2 instead, any network with internet works. The phones use the public URL and nothing local is needed.

If the QR still does not open, type the URL printed under the QR, including its `?t=` token.

## (d) Reset between judge groups

- Click **Reset 18:20** in the top bar, or `curl -X POST http://<host>/api/demo/reset`.
- A reset clears the action log and injected rows, and puts the clock back at 18:20 ET, paused.
- With `AUDIT_BUCKET` set, the previous group's audit CSV and action log are first copied to `s3://<bucket>/lookahead/<dataset>/<time>/`.
- If a judge activated their own dataset on `/admin/dataset`, click **Revert to …** there (lead PIN) to go back to `data/raw`. A reset keeps the active dataset.
- Phones: the lead stays unlocked (cookie). Old offer links show the offer's final status or "not valid" after the reset; nothing on a phone needs clearing.
- Sanity check: `/api/health` → `"logSeq":0`, `clock.mode` `paused`. On `/`, the #1 card is the Oak Valley routing deadlock.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| Phone shows "This offer link is not valid." | The link lost its `?t=` token, or `OFFER_LINK_SECRET` changed since it was issued (a restart without the secret in `data/live/.secret`). Approve a new offer or rescan the QR. |
| Lead phone keeps asking for the PIN | `LEAD_PIN` differs from what is being typed; check `/etc/lookahead.env` on EC2. |
| Explain shows TEMPLATE on EC2 | `curl /api/health` → `bedrockReason`. Expected when Bedrock is not enabled; the text is still correct. |
| `store` reads `file (dynamo unavailable: …)` | The instance profile lacks DynamoDB rights or the table name is wrong. The demo continues on disk; fix `/etc/lookahead.env` and `sudo systemctl restart lookahead` between groups. |
| Red banner "Replay differs from your snapshot: N cells" | The active dataset's replay does not match its own snapshot files. Details on `/integrity`; Revert on `/admin/dataset`. |
| "No new Sevaro events since …" banner | The sim clock is more than 2 min past the last ingested event (OQ-46). Expected after **Jump 19:00**; inject rows or reset. |
| Anything else | **Reset 18:20**. On EC2: `sudo systemctl restart lookahead` (the log replays from DynamoDB or disk). |
