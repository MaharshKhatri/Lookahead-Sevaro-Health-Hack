import { guard, json } from '@/server/http';
import { computePatientClock } from '@/server/patientClock';
import { getReadyStore } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/patient-clock: { clock: PatientClockDTO | null, nowMs, clockMode, clockSpeed, version } (sprint A2). */
export function GET(): Promise<Response> {
  return guard(async () => {
    const store = await getReadyStore();
    return json(computePatientClock(store.snapshot()));
  });
}
