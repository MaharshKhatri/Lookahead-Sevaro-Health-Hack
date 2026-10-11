import { guard, json } from '@/server/http';
import { SIMULATOR_SINK_PATH, lastSimulatorSentAtMs, simulatorEnabled } from '@/server/simulator';
import { webhookConfig, simulatorSinkDefault } from '@/server/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/simulator/status (sprint B1): {enabled, lastSentAtMs, webhookTarget}.
 * Always 200 so the top bar can ask; when disabled it says so honestly.
 * webhookTarget names where outbound webhooks go without exposing the URL.
 */
export function GET(): Promise<Response> {
  return guard(() => {
    const enabled = simulatorEnabled();
    const url = webhookConfig(process.env, { simulatorSink: simulatorSinkDefault() }).url;
    const webhookTarget = url === null ? 'none' : url.endsWith(SIMULATOR_SINK_PATH) ? 'dev_sink' : 'external';
    return json({ enabled, lastSentAtMs: enabled ? lastSimulatorSentAtMs() : null, webhookTarget, nowMs: Date.now() });
  });
}
