import 'server-only';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { auditCsv, type ActionLog } from '@lookahead/engine';

/**
 * Optional (AUDIT_BUCKET set): before "Reset" or a dataset swap wipes the
 * action log, copy the audit CSV and the raw action log to S3 so every judge
 * group's run stays on record (brief "Log every offer: who was considered,
 * who was excluded and why, who approved, and the outcome"). Best effort:
 * failures are logged and never block the reset.
 */
export async function archiveLog(datasetKey: string, log: ActionLog, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const bucket = env.AUDIT_BUCKET ?? '';
  if (bucket === '' || log.length === 0) return null;
  const prefix = `lookahead/${datasetKey}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    const s3 = new S3Client({ region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1', maxAttempts: 2 });
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/audit.csv`, Body: auditCsv(log), ContentType: 'text/csv' }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/actions.jsonl`, Body: log.map((e) => JSON.stringify(e)).join('\n') + '\n', ContentType: 'application/x-ndjson' }));
    return `s3://${bucket}/${prefix}/`;
  } catch (e) {
    console.warn('[lookahead] audit archive to S3 failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
