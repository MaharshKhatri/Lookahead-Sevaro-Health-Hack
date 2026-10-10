import 'server-only';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { ActionEvent } from '@lookahead/engine';
import { dynamoRepos } from './dynamo';
import { fileRepos } from './file';
import type { ActionRepo, AppendResult, EventRepo, InjectedRow, RepoFactory } from './types';

export type { ActionRepo, EventRepo, InjectedRow, RepoFactory, Repos, AppendResult } from './types';

/**
 * Picks the storage from the environment (STORE=file | dynamo, TABLE_NAME,
 * AWS_REGION). DynamoDB is wrapped so any infrastructure failure (no
 * credentials, no table, throttling, network) degrades to the file store for
 * the rest of the process, seeded with everything already in memory: the demo
 * keeps working identically. Conflicts are not failures and pass through.
 */

export interface StoreBackend {
  readonly factory: RepoFactory;
  /** 'file', 'dynamo', or 'file (dynamo unavailable: <reason>)' once degraded. */
  describe(): string;
}

export function backendFromEnv(liveDir: string, env: NodeJS.ProcessEnv = process.env): StoreBackend {
  const files = fileRepos(liveDir);
  if ((env.STORE ?? 'file') !== 'dynamo') return { factory: files, describe: () => 'file' };
  const table = env.TABLE_NAME ?? '';
  if (table === '') return { factory: files, describe: () => 'file (STORE=dynamo but TABLE_NAME is not set)' };
  const client = new DynamoDBClient({ region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1', maxAttempts: 2 });
  return withFallback(dynamoRepos(client, table), files, `dynamo (${table})`);
}

/** Wraps a primary factory so the first infrastructure error switches every repo to the fallback. */
export function withFallback(primary: RepoFactory, fallback: RepoFactory, label: string): StoreBackend {
  const state: { degraded: string | null } = { degraded: null };
  const degrade = (err: unknown) => {
    state.degraded ??= err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.warn(`[lookahead] storage degraded to file: ${state.degraded}`);
  };
  const factory: RepoFactory = (key) => {
    const p = primary(key);
    const f = fallback(key);
    return { actions: new FallbackActions(p.actions, f.actions, state, degrade), events: new FallbackEvents(p.events, f.events, state, degrade) };
  };
  return { factory, describe: () => (state.degraded === null ? label : `file (dynamo unavailable: ${state.degraded})`) };
}

interface DegradeState {
  degraded: string | null;
}

class FallbackActions implements ActionRepo {
  private mirror: ActionEvent[] = [];
  constructor(
    private readonly p: ActionRepo,
    private readonly f: ActionRepo,
    private readonly s: DegradeState,
    private readonly degrade: (e: unknown) => void,
  ) {}
  get kind() {
    return this.s.degraded === null ? this.p.kind : this.f.kind;
  }
  async load(): Promise<ActionEvent[]> {
    if (this.s.degraded === null) {
      try {
        this.mirror = await this.p.load();
        return this.mirror;
      } catch (e) {
        this.degrade(e);
      }
    }
    return this.f.load();
  }
  async append(expectedSeq: number, events: readonly ActionEvent[]): Promise<AppendResult> {
    if (this.s.degraded === null) {
      try {
        const r = await this.p.append(expectedSeq, events);
        if (r.ok) this.mirror = [...this.mirror, ...events];
        return r;
      } catch (e) {
        this.degrade(e);
        await this.f.clear();
        await this.f.append(0, this.mirror);
      }
    }
    return this.f.append(expectedSeq, events);
  }
  async clear(): Promise<void> {
    this.mirror = [];
    if (this.s.degraded === null) {
      try {
        await this.p.clear();
      } catch (e) {
        this.degrade(e);
      }
    }
    await this.f.clear();
  }
}

class FallbackEvents implements EventRepo {
  private mirror: InjectedRow[] = [];
  constructor(
    private readonly p: EventRepo,
    private readonly f: EventRepo,
    private readonly s: DegradeState,
    private readonly degrade: (e: unknown) => void,
  ) {}
  get kind() {
    return this.s.degraded === null ? this.p.kind : this.f.kind;
  }
  async load(): Promise<InjectedRow[]> {
    if (this.s.degraded === null) {
      try {
        this.mirror = await this.p.load();
        return this.mirror;
      } catch (e) {
        this.degrade(e);
      }
    }
    return this.f.load();
  }
  async append(rows: readonly InjectedRow[]): Promise<AppendResult> {
    if (this.s.degraded === null) {
      try {
        const r = await this.p.append(rows);
        if (r.ok) this.mirror = [...this.mirror, ...rows];
        return r;
      } catch (e) {
        this.degrade(e);
        await this.f.clear();
        await this.f.append(this.mirror);
      }
    }
    return this.f.append(rows);
  }
  async clear(): Promise<void> {
    this.mirror = [];
    if (this.s.degraded === null) {
      try {
        await this.p.clear();
      } catch (e) {
        this.degrade(e);
      }
    }
    await this.f.clear();
  }
}
