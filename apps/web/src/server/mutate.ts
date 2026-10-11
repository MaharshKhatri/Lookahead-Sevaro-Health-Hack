import 'server-only';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATASET_FILES, EVENT_COLUMNS, decide, mulberry32, parseDataset, type Dataset, type DecisionReport, type Need } from '@lookahead/engine';
import { csvRow } from './store';

/**
 * Generalization proof for the stress harness (CLAUDE.md rule 5: "No
 * hard-coding of answers"; brief "What Teams Must Demonstrate" #1 and #5).
 * The server-side copy of packages/engine/test/mutate.helpers.ts, made generic:
 * it builds a SEPARATE in-memory package from the live dataset (reference
 * files from the active package directory, plus every event the store holds,
 * injected rows included), remaps every PREFIX-number id, renames every
 * hospital and physician, shifts every ISO date by whole days that keep the
 * ET offset and the weekday, and permutes every file's data rows with a
 * seeded mulberry32 shuffle. The live dataset is never swapped or modified.
 * LOOKAHEAD-DEFINED: the id scheme `<PREFIX>X-9<digits>` keeps each id class
 * in the same order (lexicographic and numeric), so engine tie-breaks by id
 * resolve identically on both packages.
 */

export const DAY_MS = 24 * 3_600_000;
/** Matches reference-style ids (PREFIX-digits); the mutated form appends X to the prefix and prepends 9 to the digits. */
const ID_RE = /\b([A-Z]{2,5})-(\d+)\b/g;
const MUTATED_ID_RE = /\b([A-Z]{2,5})X-9(\d+)\b/g;

export const mutateId = (text: string): string => text.replace(ID_RE, (_m, p: string, d: string) => `${p}X-9${d}`);
export const unmutateId = (text: string): string => text.replace(MUTATED_ID_RE, (_m, p: string, d: string) => `${p}-${d}`);

/** Calendar-date shift for "YYYY-MM-DDThh:mm:ss±hh:mm" values: the date moves by `days`, the clock and offset stay. */
export function shiftIsoDates(text: string, days: number): string {
  return text.replace(/(\d{4})-(\d{2})-(\d{2})(?=T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z))/g, (_m, y: string, mo: string, d: string) => {
    const t = Date.UTC(Number(y), Number(mo) - 1, Number(d) + days);
    return new Date(t).toISOString().slice(0, 10);
  });
}

/** UTC offset label of an instant in America/New_York (brief: shift times are ET), e.g. "GMT-04:00". */
export function etOffsetLabel(ms: number): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'GMT';
}

/** Whole-day shift that keeps the weekday (7, 14) or at least the ET offset (1), so ET wall-clock shift times mean the same instants. */
export function chooseDayShift(nowMs: number): number {
  const here = etOffsetLabel(nowMs);
  return [7, 14, 1, 2].find((k) => etOffsetLabel(nowMs + k * DAY_MS) === here) ?? 7;
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function permuteRows(text: string, seed: number): string {
  const lines = text.split(/\r?\n/);
  const trailingBlank = lines.at(-1) === '';
  const body = trailingBlank ? lines.slice(0, -1) : lines;
  const [header, ...rows] = body;
  return [header ?? '', ...seededShuffle(rows, seed)].join('\n') + (trailingBlank ? '\n' : '');
}

/** Invented names keyed by the original name, from the parsed dataset (never typed by hand). */
function nameMap(d: Dataset): [string, string][] {
  const pairs = new Map<string, string>();
  d.hospitals.forEach((h, i) => pairs.set(h.hospitalName, `Mutant Site ${i + 1}`));
  let i = 0;
  for (const p of [...d.physiciansOnShift, ...d.offShiftRoster, ...d.credentials]) {
    if (!pairs.has(p.name)) pairs.set(p.name, `Dr. Variant ${String(++i).padStart(2, '0')}`);
  }
  // Longest names first so a name that is a prefix of another is never replaced inside it.
  return [...pairs].sort((a, b) => b[0].length - a[0].length);
}

const renameAll = (text: string, pairs: readonly [string, string][]): string => pairs.reduce((t, [from, to]) => t.split(from).join(to), text);

export interface MutatedPackage {
  readonly texts: Record<string, string>;
  readonly dayShift: number;
  readonly files: number;
}

/** Texts of the live package: the active directory's CSVs with event_stream.csv rebuilt from every event the store holds. Canonical file names only. */
export function liveTexts(dir: string, dataset: Dataset): Record<string, string> {
  if (!existsSync(dir)) throw new Error(`dataset directory ${dir} is not readable`);
  const names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv'));
  const missing = Object.values(DATASET_FILES).filter((f) => !names.includes(f));
  if (missing.length > 0) throw new Error(`generalization needs the canonical file names; missing ${missing.join(', ')}`);
  const texts: Record<string, string> = {};
  for (const n of names) texts[n] = readFileSync(join(dir, n), 'utf8');
  texts[DATASET_FILES.events] = `${[EVENT_COLUMNS.join(','), ...dataset.events.map(csvRow)].join('\n')}\n`;
  return texts;
}

export function mutatePackage(texts: Record<string, string>, reference: Dataset, seed: number, dayShift: number): MutatedPackage {
  const pairs = nameMap(reference);
  const out: Record<string, string> = {};
  let i = 0;
  for (const name of Object.keys(texts).sort()) out[name] = permuteRows(renameAll(shiftIsoDates(mutateId(texts[name] ?? ''), dayShift), pairs), seed * 1000 + i++);
  return { texts: out, dayShift, files: Object.keys(out).length };
}

export interface VerdictCheck {
  readonly name: string;
  readonly same: boolean;
  readonly original: string;
  readonly mutated: string;
}

export interface GeneralizationResult {
  readonly dayShift: number;
  readonly files: number;
  readonly events: number;
  readonly originalIdsLeft: number;
  readonly checks: readonly VerdictCheck[];
  readonly allSame: boolean;
}

const needKey = (n: Need, nowMs: number, f: (id: string) => string) => `${n.kind}@${f(n.hospitalId)}+${Math.round((n.startMs - nowMs) / 60_000)}..${n.endMs === 'beyond_horizon' ? 'beyond' : Math.round((n.endMs - nowMs) / 60_000)}`;

function verdicts(d: DecisionReport, f: (id: string) => string) {
  const o = d.recommendedOffer;
  return {
    gaps: d.needs.map((n) => needKey(n, d.nowMs, f)).sort(),
    eligible: d.ledger.filter((e) => e.eligible).map((e) => `${f(e.physicianId)}#${e.rank ?? '-'}`).sort(),
    offer: o === null ? 'none' : `${f(o.physicianId)} scope[${o.routingScope.map(f).join(' ')}] seed ${o.seededConsultCount} +${Math.round((o.window.startMs - d.nowMs) / 60_000)}..${Math.round((o.window.endMs - d.nowMs) / 60_000)} min`,
    routingFailures: d.detection.deadlocks.map((x) => `${f(x.consultId)}:${x.routingFailures.length}`).sort(),
  };
}

/**
 * Decide on the live dataset and on the mutated copy, map the mutated ids
 * back and compare the verdicts: gaps (needs), eligible physicians (ledger),
 * recommended offer, routing failures (deadlocked consults).
 */
export function runGeneralization(dir: string, dataset: Dataset, nowMs: number, seed: number): GeneralizationResult {
  const dayShift = chooseDayShift(nowMs);
  const pkg = mutatePackage(liveTexts(dir, dataset), dataset, seed, dayShift);
  const originalIdsLeft = Object.values(pkg.texts).reduce((n, t) => n + (t.match(/\b(PHY|CON|SYN|EVT)-\d+/g)?.length ?? 0), 0);
  const mutated = parseDataset(pkg.texts);
  const a = verdicts(decide(dataset, nowMs), (x) => x);
  const b = verdicts(decide(mutated, nowMs + dayShift * DAY_MS), unmutateId);
  const check = (name: string, x: string | readonly string[], y: string | readonly string[]): VerdictCheck => {
    const sx = typeof x === 'string' ? x : x.join(', ') || 'none';
    const sy = typeof y === 'string' ? y : y.join(', ') || 'none';
    return { name, same: sx === sy, original: sx, mutated: sy };
  };
  const checks = [check('gaps', a.gaps, b.gaps), check('eligible physicians', a.eligible, b.eligible), check('recommended offer', a.offer, b.offer), check('routing failures', a.routingFailures, b.routingFailures)];
  return { dayShift, files: pkg.files, events: mutated.events.length, originalIdsLeft, checks, allSame: checks.every((c) => c.same) && originalIdsLeft === 0 };
}
