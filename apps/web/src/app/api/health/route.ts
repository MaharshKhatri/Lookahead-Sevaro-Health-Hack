import { HEALTH_CHECK_TIMEOUT_MS, currentHealthChecks, isLive, withTimeout } from '@/server/health';
import { guard, json } from '@/server/http';
import { getNarrator, type NarratorStatus } from '@/server/narrate/bedrock';
import { getReadyStore } from '@/server/store';
import { readTestReport } from '@/server/testReport';
import { lastWebhookDelivery } from '@/server/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/health: what a deploy check, the runbook and the status pill look at.
 * Original fields {ok, store, bedrock, datasetVersion, clock, ...} are kept;
 * sprint A6 adds uptimeMs, events, live AWS checks (each bounded by
 * HEALTH_CHECK_TIMEOUT_MS so health never hangs), region, deployedUrl, live
 * (true only when BOTH the DynamoDB and Bedrock checks are ok), the last
 * webhook delivery and the last real test-run summary.
 */
export function GET(): Promise<Response> {
  return guard(async () => {
    const store = await getReadyStore();
    const s = store.snapshot();
    const [b, checks] = await Promise.all([
      withTimeout(getNarrator().status(), HEALTH_CHECK_TIMEOUT_MS, (): NarratorStatus => ({ available: false, modelId: null, reason: `narrator status timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms` })),
      currentHealthChecks(() => store.snapshot().storeKind),
    ]);
    const hook = lastWebhookDelivery();
    const report = readTestReport();
    return json({
      ok: true,
      store: s.storeKind,
      bedrock: b.available ? 'available' : 'unavailable',
      bedrockModel: b.modelId,
      bedrockReason: b.reason,
      dataset: { key: s.datasetMeta.key, label: s.datasetMeta.label, source: s.datasetMeta.source, events: s.dataset.events.length },
      datasetVersion: s.datasetVersion,
      version: s.version,
      clock: s.clock,
      logSeq: s.log.at(-1)?.seq ?? 0,
      conflictsResolved: store.conflictsResolved,
      bootWarnings: store.bootWarnings,
      publicOrigin: process.env.LOOKAHEAD_PUBLIC_ORIGIN ?? null,
      // Sprint A6.
      uptimeMs: Math.round(process.uptime() * 1000),
      events: s.dataset.events.length,
      checks,
      region: process.env.AWS_REGION ?? null,
      deployedUrl: process.env.DEPLOYED_URL ?? null,
      live: isLive(checks),
      // The URL is left out on purpose: a webhook URL can carry a token and /api/health is public.
      lastWebhook: hook === null ? null : { atMs: hook.atMs, ok: hook.ok, status: hook.status, latencyMs: hook.latencyMs, error: hook.error },
      testReport: report === null ? null : { generatedAtMs: report.generatedAtMs, ok: report.ok, command: report.command, total: report.total },
    });
  });
}
