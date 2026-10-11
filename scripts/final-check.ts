/**
 * `pnpm final-check` (sprint B4, D-97): every automated pre-judging check in
 * one run; prints one line per check and exits 1 on any red. Checks:
 *  1. all tests (pnpm test:report, writes docs/test-report.json)
 *  2. golden freeze (subset compare)          3. hard-coded-ID scan (engine src)
 *  4. production build                         5. secret scan (git grep)
 *  6. .env.example names every env var the code reads
 *  then against a fresh `next start` on FINAL_CHECK_PORT (default 3290, its own live dir):
 *  7. /opener renders computed numbers         8. /api/patient-clock answers
 *  9. every Stress Test action succeeds       10. the simulator round-trips a webhook
 * 11. the scale test passes (x2, isolated)    12. optional: DEPLOYED_URL /api/health < 500 ms and live
 * Flags: --skip-tests, --skip-build (reuse the last build).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.FINAL_CHECK_PORT ?? 3290);
const BASE = `http://127.0.0.1:${PORT}`;

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}
const results: Check[] = [];

async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t });
    console.log(`  PASS  ${name}  (${Date.now() - t} ms)  ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail, ms: Date.now() - t });
    console.log(`  FAIL  ${name}  (${Date.now() - t} ms)  ${detail}`);
  }
}

function sh(cmd: string, argv: readonly string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env): { code: number; out: string } {
  const r = spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const tail = (s: string, n = 3) => s.trim().split('\n').slice(-n).join(' | ');

function walk(dir: string, exts: readonly string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.next') || name === 'dist') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, exts) : exts.some((e) => name.endsWith(e)) ? [p] : [];
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; ms: number }> {
  const t = Date.now();
  const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: r.status, body, ms: Date.now() - t };
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`server did not answer ${url} within ${timeoutMs} ms`);
}

async function main(): Promise<void> {
  console.log(`final-check ${new Date().toISOString()}`);

  if (!args.has('--skip-tests')) {
    await check('all tests (engine + web)', () => {
      const r = sh('pnpm', ['test:report']);
      const report = JSON.parse(readFileSync(join(ROOT, 'docs', 'test-report.json'), 'utf8')) as { total: { tests: number; passed: number; failed: number }; ok: boolean };
      if (r.code !== 0 || !report.ok) throw new Error(`failed ${report.total.failed} of ${report.total.tests}: ${tail(r.out)}`);
      return `${report.total.passed}/${report.total.tests} passed`;
    });
  }

  await check('golden freeze', () => {
    const r = sh('pnpm', ['--filter', '@lookahead/engine', 'exec', 'vitest', 'run', 'test/golden.freeze.test.ts']);
    if (r.code !== 0) throw new Error(tail(r.out));
    return tail(r.out, 1);
  });

  await check('hard-coded-ID scan (packages/engine/src)', () => {
    const re = /\b(PHY|CON|SYN|EVT)-\d+/;
    const files = walk(join(ROOT, 'packages', 'engine', 'src'), ['.ts']);
    const hits = files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    if (hits.length > 0) throw new Error(`literal IDs in ${hits.join(', ')}`);
    return `${files.length} files clean`;
  });

  await check('secret scan', () => {
    const r = sh('git', ['grep', '-nE', 'AKIA[0-9A-Z]{16}|aws_secret_access_key\\s*=\\s*\\S+|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|sk-[A-Za-z0-9]{20,}', '--', '.', ':!scripts/final-check.ts']);
    if (r.code === 0) throw new Error(tail(r.out, 5));
    return 'no matches';
  });

  await check('.env.example covers every env var read by the code', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const ignore = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE', 'CI', 'HOME', 'PATH', 'TZ', 'GOLDEN_FREEZE_WRITE', 'FINAL_CHECK_PORT', 'E2E_PORT', 'E2E_LIVE_DIR', 'E2E_LEAD_PIN', 'PLAYWRIGHT_BASE_URL', 'LOOKAHEAD_TEST_REPORT_FILE', 'VITEST']);
    const files = [...walk(join(ROOT, 'apps', 'web', 'src'), ['.ts', '.tsx']), ...walk(join(ROOT, 'scripts'), ['.ts'])];
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]|env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1] ?? m[2] ?? m[3] ?? '');
    const missing = [...used].filter((v) => v !== '' && !ignore.has(v) && !documented.has(v)).sort();
    if (missing.length > 0) throw new Error(`missing from .env.example: ${missing.join(', ')}`);
    return `${used.size} names read, all documented`;
  });

  if (!args.has('--skip-build')) {
    await check('production build', () => {
      const r = sh('pnpm', ['--filter', 'web', 'build']);
      if (r.code !== 0) throw new Error(tail(r.out, 8));
      return 'next build ok';
    });
  }

  const live = mkdtempSync(join(tmpdir(), 'lookahead-final-check-'));
  const server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
    cwd: join(ROOT, 'apps', 'web'),
    env: { ...process.env, LOOKAHEAD_LIVE_DIR: live, NARRATION: 'off', NEXT_TELEMETRY_DISABLED: '1', LOOKAHEAD_PUBLIC_ORIGIN: BASE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await waitFor(`${BASE}/api/health`, 90_000);
    await json('/api/demo/reset', { method: 'POST' });

    await check('/opener renders computed numbers', async () => {
      const r = await fetch(`${BASE}/opener`);
      const html = await r.text();
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
      for (const bad of ['undefined', 'NaN', 'TODO']) if (text.includes(bad)) throw new Error(`rendered text contains "${bad}"`);
      if (!/data-testid="opener-sentence"/.test(html)) throw new Error('no opener sentences rendered');
      if (!/\d+(\.\d+)? min/.test(text)) throw new Error('no computed minutes in the opener');
      return 'three sentences with computed minutes';
    });

    await check('patient clock answers', async () => {
      const r = await json<{ clock: unknown; nowMs: number }>('/api/patient-clock');
      if (r.status !== 200 || typeof r.body.nowMs !== 'number') throw new Error(`status ${r.status}`);
      return r.body.clock === null ? 'no unassigned stroke at the reference instant' : 'top unassigned stroke computed';
    });

    await check('every Stress Test action succeeds', async () => {
      const cat = await json<{ actions: { id: string }[] }>('/api/stress');
      if (cat.status !== 200) throw new Error(`catalog status ${cat.status}`);
      const failed: string[] = [];
      let maxMs = 0;
      for (const a of cat.body.actions) {
        const r = await json<{ result?: { ok: boolean; latencyMs: number; error: string | null } }>('/api/stress', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: a.id, seed: 7 }) });
        if (r.status !== 200 || r.body.result?.ok !== true) failed.push(`${a.id}: ${r.body.result?.error ?? r.status}`);
        maxMs = Math.max(maxMs, r.body.result?.latencyMs ?? 0);
      }
      if (failed.length > 0) throw new Error(failed.join('; '));
      return `${cat.body.actions.length} actions ok, slowest ${maxMs} ms`;
    });

    await check('simulator round-trips a webhook', async () => {
      const before = await json<{ deliveries?: unknown[]; entries?: unknown[] } | unknown[]>('/api/simulator/webhook-sink');
      const count = (b: unknown) => (Array.isArray(b) ? b.length : Array.isArray((b as { entries?: unknown[] }).entries) ? ((b as { entries: unknown[] }).entries.length) : Array.isArray((b as { deliveries?: unknown[] }).deliveries) ? (b as { deliveries: unknown[] }).deliveries.length : 0);
      const n0 = count(before.body);
      const sent = await json<{ status: number; report?: { accepted: number } }>('/api/simulator/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'stroke_consult' }) });
      if (sent.status !== 200) throw new Error(`send status ${sent.status}`);
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        const after = await json<unknown>('/api/simulator/webhook-sink');
        if (count(after.body) > n0) return `accepted ${sent.body.report?.accepted ?? '?'}, webhook received`;
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error('no webhook reached the dev sink within 5 s');
    });

    await check('scale test (x2, isolated child process)', async () => {
      const r = await json<{ ok?: boolean; message?: string }>('/api/scale-test?scale=2', { method: 'POST' });
      if (r.status !== 200 || r.body.ok === false) throw new Error(`status ${r.status}: ${r.body.message ?? ''}`);
      return `answered in ${r.ms} ms`;
    });
  } finally {
    server.kill('SIGTERM');
  }

  const deployed = process.env.DEPLOYED_URL;
  if (deployed !== undefined && deployed !== '') {
    await check(`DEPLOYED_URL health (${deployed})`, async () => {
      const t = Date.now();
      const r = await fetch(`${deployed.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(5_000) });
      const ms = Date.now() - t;
      const b = (await r.json()) as { ok?: boolean; live?: boolean };
      if (!r.ok || b.ok !== true) throw new Error(`status ${r.status}`);
      if (ms >= 500) throw new Error(`answered in ${ms} ms (limit 500)`);
      if (b.live !== true) throw new Error('health is not live (DynamoDB or Bedrock check failed)');
      return `${ms} ms, live`;
    });
  }

  const red = results.filter((r) => !r.ok);
  console.log(`\nfinal-check: ${results.length - red.length}/${results.length} green${red.length > 0 ? `; RED: ${red.map((r) => r.name).join(', ')}` : ''}`);
  process.exit(red.length === 0 ? 0 : 1);
}

void main();
