# Integrating Lookahead

Lookahead consumes an event stream and a few reference tables, and it speaks out through approved messages, webhooks and a read API. It never writes to an upstream system: reassignments are recorded as "requested in Synapse" (D-88), and every off-shift physician message needs the clinical lead's approval first.

We have not seen the APIs of Sevaro's products. The brief names Synapse as the source of status, telephony and video events; everything else below describes the *kind* of system Lookahead would need, and the seam in our code where an adapter would go. The pure interfaces are in `packages/engine/src/integrate/index.ts`.

## Inbound: events

| What | Lookahead seam | Today |
|---|---|---|
| Status, telephony, video, camera, agent heartbeat, consult lifecycle (brief signal table: "Physician sets it in Synapse", "Synapse telephony events", "Synapse video events") | `EventSource`; `POST /api/v1/events` | event_stream.csv rows, or JSON rows keyed by the same column names |
| Shift schedule, off-shift roster | `ScheduleSource` | physicians_on_shift.csv, physicians_off_shift_roster.csv |
| Credentialing | `CredentialSource` | credentialing_matrix.csv |

`POST /api/v1/events` contract (full schema in `docs/openapi.yaml`):

- Body: event_stream.csv text (header optional) or a JSON array of objects whose keys are the CSV column names (`event_id, event_time, ingested_at, consult_id, event_type, physician_id, hospital_id, description`). An unknown key is a 400: a silent drop would hide a mapping error.
- Signature: `x-lookahead-signature: sha256=<hex of HMAC-SHA256(LOOKAHEAD_INGEST_SECRET, raw body)>`. Without a secret the endpoint is open only in DEMO_MODE.
- Idempotent on `event_id` (OQ-04): a replayed row is reported as a duplicate and never applied twice. Late rows are ordered by `event_time` (OQ-12) and counted in `late`.
- Answer: an IngestReport with `accepted`, `duplicates`, `late`, `rejected[{row, reason}]`; 200 when nothing was rejected, 207 otherwise.

Example:

```sh
BODY='[{"event_id":"E-1","event_time":"2026-03-17T18:19:30-04:00","consult_id":"C-1","event_type":"consult_received","hospital_id":"H-1","description":"Stroke consult request received"}]'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$LOOKAHEAD_INGEST_SECRET" -hex | sed 's/^.* //')"
curl -sS -X POST "$ORIGIN/api/v1/events" -H 'content-type: application/json' -H "x-lookahead-signature: $SIG" --data "$BODY"
```

## Outbound

| What | Lookahead seam | Today |
|---|---|---|
| Split-shift offers, standby pre-alerts, activations, releases to an off-shift physician | `NotificationChannel` (only after `ApprovalChannel`) | simulated phone view behind an HMAC link (`/offer/[id]?t=`, `/standby/[id]?t=`); the roster's channel is shown |
| Clinical-lead approvals | `ApprovalChannel` | the `/lead` phone inbox, PIN-gated |
| State changes for other systems | outbound webhook | signed `store.changed` envelope to `LOOKAHEAD_WEBHOOK_URL` (no clinical content; the subscriber reads `/api/v1/*`) |
| Read models for dashboards and BI | `GET /api/v1/{forecast,standby,coverage,alerts,incidents}` | `schemaVersion: "1.0"`; `LOOKAHEAD_API_KEY` when DEMO_MODE is off |
| An embeddable surge view | `/embed/surge?limit=N` | framing allowed only from `LOOKAHEAD_EMBED_ORIGINS` |

## What an adapter must keep

1. Every message to an off-shift physician is approved by the clinical lead before it is sent, and passes the PHI guard (`assertNoPHI`): hospitals, hours and start time only.
2. Event ids are stable: the dedupe and the audit trail depend on them.
3. Instants carry an explicit offset; Lookahead stores epoch milliseconds UTC.
4. Lookahead never changes consult or physician state upstream. A reassignment is a request a human carries out in the system of record.
