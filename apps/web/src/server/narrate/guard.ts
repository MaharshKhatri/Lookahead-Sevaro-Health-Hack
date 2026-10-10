import { findPhiViolations } from '@lookahead/engine';
import type { NarrationFacts } from './facts';

/**
 * Fidelity guard (Session 7), deterministic and run on every generated text:
 *  (a) the engine's PHI denylist (assertNoPHI's check);
 *  (b) every number and clock time in the text appears in the facts
 *      ("18:35", "6:35 PM" and "18:35:00" are the same time);
 *  (c) every id-like token and every proper noun appears in the facts;
 *  (d) at most MAX_WORDS words.
 * Any failure means the caller serves the template narration instead.
 */

export const MAX_WORDS = 60;

export interface GuardCheck {
  readonly name: 'phi' | 'numbers' | 'names' | 'length';
  readonly ok: boolean;
  readonly detail: string;
}

const SPELLED: Readonly<Record<string, string>> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
};

const TIME = /\b(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([AaPp])\.?\s*[Mm]\.?)?/g;

/** Clock times as "HH:MM" (24 h) and the remaining numbers, as strings. */
export function numericTokens(text: string): { times: Set<string>; numbers: Set<string> } {
  const times = new Set<string>();
  const rest = text.replace(TIME, (_m, h: string, m: string, ap: string | undefined) => {
    let hh = Number(h) % 24;
    if (ap !== undefined && /p/i.test(ap) && hh < 12) hh += 12;
    if (ap !== undefined && /a/i.test(ap) && hh === 12) hh = 0;
    times.add(`${String(hh).padStart(2, '0')}:${m}`);
    return ' ';
  });
  const numbers = new Set<string>();
  for (const m of rest.matchAll(/\d+(?:\.\d+)?/g)) numbers.add(String(Number(m[0])));
  for (const w of rest.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const d = SPELLED[w[0]];
    if (d !== undefined) numbers.add(d);
  }
  return { times, numbers };
}

const factText = (f: NarrationFacts) => [f.title, ...f.points, ...f.names].join(' ');

/** Words a sentence may start with although they are not in the facts. */
const STARTERS = new Set(
  'a an the this that these those it its if no not only one two three four five six seven eight nine ten there here routing reassignment reassign escalate escalation approve approving approval offer offering coverage scope starting start right now once until after before while when with without both all each another split recommended recommendation next top action'.split(
    ' ',
  ),
);
const ALWAYS_OK = new Set(['ET', 'AM', 'PM', 'I', 'OK']);

export function checkNarration(text: string, facts: NarrationFacts): GuardCheck[] {
  const checks: GuardCheck[] = [];
  const phi = findPhiViolations(text);
  checks.push({ name: 'phi', ok: phi.length === 0, detail: phi.length === 0 ? 'no patient information or clinical terms' : phi.map((v) => `"${v.token}" (${v.label})`).join(', ') });

  const have = numericTokens(factText(facts));
  const got = numericTokens(text);
  const badTimes = [...got.times].filter((t) => !have.times.has(t));
  const badNumbers = [...got.numbers].filter((n) => !have.numbers.has(n));
  checks.push({
    name: 'numbers',
    ok: badTimes.length + badNumbers.length === 0,
    detail: badTimes.length + badNumbers.length === 0 ? 'every number and time is in the facts' : `not in the facts: ${[...badTimes, ...badNumbers].join(', ')}`,
  });

  const facts_ = factText(facts);
  const factWords = new Set(facts_.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []);
  const factWordsLower = new Set([...factWords].map((w) => w.toLowerCase()));
  const factIds = new Set(facts_.match(/\b[A-Z]{2,}-\d+\b/g) ?? []);
  const badIds = (text.match(/\b[A-Z]{2,}-\d+\b/g) ?? []).filter((id) => !factIds.has(id));
  const badNames: string[] = [];
  for (const sentenceText of text.split(/(?<=[.!?])\s+/)) {
    const words = [...sentenceText.matchAll(/[A-Za-z][A-Za-z'’-]*/g)].map((m) => m[0]);
    words.forEach((w, i) => {
      if (!/^[A-Z]/.test(w) || ALWAYS_OK.has(w)) return;
      const bare = w.replace(/['’]s$/, '');
      if (i === 0) {
        if (!factWordsLower.has(bare.toLowerCase()) && !STARTERS.has(bare.toLowerCase())) badNames.push(w);
      } else if (!factWords.has(bare)) badNames.push(w);
    });
  }
  checks.push({
    name: 'names',
    ok: badIds.length + badNames.length === 0,
    detail: badIds.length + badNames.length === 0 ? 'every name and id is in the facts' : `not in the facts: ${[...badIds, ...badNames].join(', ')}`,
  });

  const words = text.trim().split(/\s+/).filter((w) => w !== '').length;
  checks.push({ name: 'length', ok: words <= MAX_WORDS, detail: `${words} words (max ${MAX_WORDS})` });
  return checks;
}

/** Deterministic narration from the same facts: the title, then whole fact sentences while they fit in MAX_WORDS. */
export function templateNarration(facts: NarrationFacts): string {
  const out: string[] = [];
  let words = 0;
  for (const s of [facts.title, ...facts.points]) {
    const n = s.split(/\s+/).length;
    if (words + n > MAX_WORDS) {
      if (out.length === 0) out.push(s.split(/\s+/).slice(0, MAX_WORDS).join(' '));
      break;
    }
    out.push(s);
    words += n;
  }
  return out.join(' ');
}
