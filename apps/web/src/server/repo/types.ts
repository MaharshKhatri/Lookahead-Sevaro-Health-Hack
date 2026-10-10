import type { ActionEvent } from '@lookahead/engine';

/**
 * Storage behind the store (Session 7). The engine's action log is the source
 * of truth for the Act layer; these repos only persist it. Every
 * implementation must make `append` atomic per seq: two writers racing for
 * the same seq get exactly one success and one `conflict`.
 */

export type AppendResult = { readonly ok: true } | { readonly ok: false; readonly conflict: true; readonly detail: string };

export interface ActionRepo {
  readonly kind: 'file' | 'dynamo';
  /** The full log for this dataset, ordered by seq. */
  load(): Promise<ActionEvent[]>;
  /** Appends events numbered expectedSeq+1.. ; conflict if any of those seqs already exists. */
  append(expectedSeq: number, events: readonly ActionEvent[]): Promise<AppendResult>;
  clear(): Promise<void>;
}

/** One injected Sevaro row: its order, the sim time it was injected at, and its event_stream.csv line. */
export interface InjectedRow {
  readonly seq: number;
  readonly atMs: number;
  readonly row: string;
}

export interface EventRepo {
  readonly kind: 'file' | 'dynamo';
  load(): Promise<InjectedRow[]>;
  append(rows: readonly InjectedRow[]): Promise<AppendResult>;
  clear(): Promise<void>;
}

export interface Repos {
  readonly actions: ActionRepo;
  readonly events: EventRepo;
}

/** Repos are scoped to one dataset (content-addressed key), so swapping datasets never mixes logs. */
export type RepoFactory = (datasetKey: string) => Repos;
