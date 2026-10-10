/**
 * Outbound-text guard for brief "Notification and Safety Constraints": "No
 * patient information in any notification. Hospital names, hours and start
 * time only." Two layers: a denylist of identifiers and clinical terms (word
 * boundaries, so "triaged" never trips "age"), and an optional whitelist that
 * rejects any word outside an allowed vocabulary. Reusable for any outbound or
 * LLM-narrated text.
 */

export interface PhiViolation {
  readonly token: string;
  readonly index: number;
  readonly reason: 'denylist' | 'not_whitelisted';
  readonly label: string;
}

export const PHI_DENYLIST: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'consult id', pattern: /\bCON-\d+\b/gi },
  { label: 'event id', pattern: /\bEVT-\d+\b/gi },
  { label: 'record number', pattern: /\b(MRN|DOB)\b|\bdate of birth\b|\bmedical record\b/gi },
  { label: 'patient', pattern: /\bpatients?\b/gi },
  { label: 'age or sex', pattern: /\bage[sd]?\b|\b\d{1,3}[\s-]*(y\/?o|yo|years?[- ]old)\b|\b(male|female)\b/gi },
  { label: 'clinical term', pattern: /\b(stroke|lvo|nihss|tpa|tnk|aphasia|hemiparesis|weakness|seizures?|aneurysms?|deficits?|symptoms?)\b/gi },
  { label: 'clinical term', pattern: /\b(thromb\w*|hemorrhag\w*|haemorrhag\w*|ischemi\w*|ischaemi\w*|diagnos\w*|neuro\w*)\b/gi },
  { label: 'clinical term', pattern: /\b(ct|cta|mri|imaging)\b/gi },
];

const WORD = /[A-Za-z][A-Za-z'-]*/g;

export interface PhiCheckOptions {
  /** Lower-case words allowed in addition to `allowedPhrases`; omit for denylist-only checking. */
  readonly allowedWords?: ReadonlySet<string>;
  /** Phrases (e.g. hospital names) whose words are allowed. */
  readonly allowedPhrases?: readonly string[];
}

export function findPhiViolations(text: string, opts: PhiCheckOptions = {}): PhiViolation[] {
  const out: PhiViolation[] = [];
  for (const { label, pattern } of PHI_DENYLIST) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) out.push({ token: m[0], index: m.index ?? 0, reason: 'denylist', label });
  }
  if (opts.allowedWords !== undefined) {
    const allowed = new Set([...opts.allowedWords].map((w) => w.toLowerCase()));
    for (const phrase of opts.allowedPhrases ?? []) for (const w of phrase.match(WORD) ?? []) allowed.add(w.toLowerCase());
    for (const m of text.matchAll(WORD)) {
      const w = m[0].toLowerCase();
      if (!allowed.has(w) && !out.some((v) => v.index === m.index)) out.push({ token: m[0], index: m.index ?? 0, reason: 'not_whitelisted', label: 'word outside the allowed vocabulary' });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Throws if the text contains anything that could be patient information. */
export function assertNoPHI(text: string, opts: PhiCheckOptions = {}): void {
  const v = findPhiViolations(text, opts);
  if (v.length > 0) throw new Error(`PHI guard: ${v.map((x) => `"${x.token}" (${x.reason}: ${x.label})`).join(', ')}`);
}
