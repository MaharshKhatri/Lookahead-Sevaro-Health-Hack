import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * docs/openapi.yaml must describe every HTTP route the app serves and
 * nothing it does not (D-96). The spec is hand-written YAML; this test reads
 * its `paths:` block structurally (two-space path keys, four-space method
 * keys) rather than through a YAML library (no new runtime deps).
 */

const API_DIR = fileURLToPath(new URL('../src/app/api/', import.meta.url));
const SPEC = fileURLToPath(new URL('../../../docs/openapi.yaml', import.meta.url));
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === 'route.ts' ? [p] : [];
  });
}

/** `src/app/api/offers/[id]/route.ts` -> `/api/offers/{id}` with its exported methods. */
function codeRoutes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of routeFiles(API_DIR)) {
    const rel = file.slice(API_DIR.length).replace(/\/route\.ts$/, '').replace(/\[([^\]]+)\]/g, '{$1}');
    const src = readFileSync(file, 'utf8');
    const methods = new Set<string>();
    for (const m of METHODS) if (new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src)) methods.add(m.toLowerCase());
    out.set(`/api/${rel}`, methods);
  }
  return out;
}

function specRoutes(): Map<string, Set<string>> {
  const text = readFileSync(SPEC, 'utf8');
  const start = text.indexOf('\npaths:\n');
  expect(start).toBeGreaterThan(0);
  const after = text.slice(start + 8);
  const end = after.search(/\n[a-zA-Z]/);
  const block = end < 0 ? after : after.slice(0, end);
  const out = new Map<string, Set<string>>();
  let current: string | null = null;
  for (const line of block.split('\n')) {
    const path = /^ {2}(\/\S+):\s*$/.exec(line);
    if (path?.[1] !== undefined) {
      current = path[1];
      out.set(current, out.get(current) ?? new Set());
      continue;
    }
    const method = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (method?.[1] !== undefined && current !== null) out.get(current)?.add(method[1]);
  }
  return out;
}

describe('docs/openapi.yaml <-> src/app/api', () => {
  const code = codeRoutes();
  const spec = specRoutes();

  it('is an OpenAPI 3.1 document with an info block and the v1 security schemes', () => {
    const text = readFileSync(SPEC, 'utf8');
    expect(text.startsWith('openapi: 3.1.0')).toBe(true);
    expect(text).toContain('title: Lookahead');
    expect(text).toContain('ingestSignature:');
    expect(text).toContain('apiKey:');
    expect(text).toContain('x-lookahead-signature');
  });

  it('every route file is in the spec with the same methods', () => {
    for (const [path, methods] of code) {
      expect(spec.has(path), `spec is missing ${path}`).toBe(true);
      expect([...(spec.get(path) ?? [])].sort(), `methods of ${path}`).toEqual([...methods].sort());
    }
  });

  it('every spec path has a route file', () => {
    for (const path of spec.keys()) expect(code.has(path), `no route file for ${path}`).toBe(true);
  });

  it('covers the six v1 endpoints', () => {
    for (const p of ['/api/v1/events', '/api/v1/forecast', '/api/v1/standby', '/api/v1/coverage', '/api/v1/alerts', '/api/v1/incidents']) expect(spec.has(p), p).toBe(true);
    expect(spec.get('/api/v1/events')?.has('post')).toBe(true);
  });
});
