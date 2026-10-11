import { requireDemoControl } from '@/server/auth';
import { guard, json, readJson } from '@/server/http';
import { isSimKind, simulatorSend, requireSimulator, SIM_KINDS } from '@/server/simulator';
import { StoreError } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const optString = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new StoreError('BAD_REQUEST', `${name} must be a string`);
  return v;
};

/**
 * POST /api/simulator/send {kind, hospitalId?, physicianId?, status?} (sprint
 * B1, demo only): builds one event row from the current snapshot, signs it
 * server-side when LOOKAHEAD_INGEST_SECRET is set and posts it through the
 * real POST /api/v1/events handler. Answers {sentAtMs, payload,
 * signatureHeader, status, report, latencyMs, version}. 404 when disabled;
 * outside DEMO_MODE a coordinator/admin session is required.
 */
export function POST(req: Request): Promise<Response> {
  return guard(async () => {
    requireSimulator();
    // Same gate as /api/events (inject): open in DEMO_MODE, else a coordinator/admin session (D-91). The server signs, so this gate is what stands in front of the secret.
    requireDemoControl(req);
    const b = await readJson(req);
    if (!isSimKind(b.kind)) throw new StoreError('BAD_REQUEST', `kind must be one of: ${SIM_KINDS.join(', ')}`);
    const hospitalId = optString(b.hospitalId, 'hospitalId');
    const physicianId = optString(b.physicianId, 'physicianId');
    const status = optString(b.status, 'status');
    const r = await simulatorSend({ kind: b.kind, ...(hospitalId === undefined ? {} : { hospitalId }), ...(physicianId === undefined ? {} : { physicianId }), ...(status === undefined ? {} : { status }) });
    return json(r);
  });
}
