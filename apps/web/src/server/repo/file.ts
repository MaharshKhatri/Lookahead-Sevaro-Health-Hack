import 'server-only';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionEvent } from '@lookahead/engine';
import type { ActionRepo, AppendResult, EventRepo, InjectedRow, RepoFactory } from './types';

/**
 * Default storage: append-only JSONL under data/live/<datasetKey>/ (one
 * process). The seq check mirrors DynamoDB's conditional put so both repos
 * have the same contract.
 */

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as T)
    : [];

const writeLines = (dir: string, path: string, records: readonly unknown[]) => {
  if (records.length === 0) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
};

export class FileActionRepo implements ActionRepo {
  readonly kind = 'file';
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, 'actions.jsonl');
  }
  async load(): Promise<ActionEvent[]> {
    return readJsonl<ActionEvent>(this.path).sort((a, b) => a.seq - b.seq);
  }
  async append(expectedSeq: number, events: readonly ActionEvent[]): Promise<AppendResult> {
    const head = readJsonl<ActionEvent>(this.path).reduce((m, e) => Math.max(m, e.seq), 0);
    if (head !== expectedSeq) return { ok: false, conflict: true, detail: `actions.jsonl is at seq ${head}, append expected ${expectedSeq}` };
    writeLines(this.dir, this.path, events);
    return { ok: true };
  }
  async clear(): Promise<void> {
    rmSync(this.path, { force: true });
  }
}

export class FileEventRepo implements EventRepo {
  readonly kind = 'file';
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, 'events.jsonl');
  }
  async load(): Promise<InjectedRow[]> {
    return readJsonl<InjectedRow>(this.path).sort((a, b) => a.seq - b.seq);
  }
  async append(rows: readonly InjectedRow[]): Promise<AppendResult> {
    writeLines(this.dir, this.path, rows);
    return { ok: true };
  }
  async clear(): Promise<void> {
    rmSync(this.path, { force: true });
  }
}

export const fileRepos =
  (liveDir: string): RepoFactory =>
  (datasetKey) => {
    const dir = join(liveDir, datasetKey);
    return { actions: new FileActionRepo(dir), events: new FileEventRepo(dir) };
  };
