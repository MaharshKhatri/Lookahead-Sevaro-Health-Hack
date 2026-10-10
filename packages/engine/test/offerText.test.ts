import { describe, expect, it } from 'vitest';
import { assertNoPHI, draftOfferMessage, findPhiViolations, OFFER_MESSAGE_VOCABULARY } from '../src';
import { decision1820 } from './decide.helpers';
import { et } from './helpers';

const message = decision1820().recommendedOffer?.message ?? '';

describe('brief "Notification and Safety Constraints": "No patient information in any notification. Hospital names, hours and start time only."', () => {
  it('the recommended offer message: hospital names, start, hours, generic reason; nothing else', () => {
    expect(message).toBe(
      [
        'Split-shift offer from the operations team.',
        'Hospitals: Suncrest Medical Pavilion, Northfield Medical, Oak Valley Medical.',
        'Start: 18:35 ET on Tue 2026-03-17. Hours: 4 (until 22:35 ET).',
        'Reason: projected coverage gap.',
        'Reply ACCEPT or DECLINE. This offer expires in 10 minutes.',
      ].join('\n'),
    );
    expect(findPhiViolations(message)).toEqual([]);
    expect(findPhiViolations(message, { allowedWords: OFFER_MESSAGE_VOCABULARY, allowedPhrases: ['Suncrest Medical Pavilion', 'Northfield Medical', 'Oak Valley Medical'] })).toEqual([]);
  });

  it('a consult id fails ("CON-2105")', () => {
    expect(findPhiViolations('Please take CON-2105 now.').map((v) => [v.token, v.label])).toEqual([['CON-2105', 'consult id']]);
    expect(() => assertNoPHI('Re: CON-2105')).toThrow(/consult id/);
  });

  it('a clinical term fails ("stroke"), case-insensitively', () => {
    expect(findPhiViolations('Stroke alert at Northfield').map((v) => v.label)).toEqual(['clinical term']);
    expect(() => assertNoPHI('Possible LVO, CTA pending')).toThrow(/clinical term/);
    expect(findPhiViolations('Patient is a 67-year-old male').map((v) => v.label).sort()).toEqual(['age or sex', 'age or sex', 'patient']);
    for (const age of ['67 yo', '67y/o', '67 years old', '67-year-old']) expect(findPhiViolations(age).map((v) => v.label), age).toEqual(['age or sex']);
  });

  it('word boundaries: "triaged", "stage", "manage", "ages-old" ... "triaged" does not false-positive', () => {
    expect(findPhiViolations('Consult triaged; manage the stage handoff.')).toEqual([]);
    expect(findPhiViolations('neurologist on call')).toHaveLength(1); // neuro* is a clinical stem by design
  });

  it('whitelist mode rejects any word outside the vocabulary and the hospital names', () => {
    const v = findPhiViolations('Split-shift offer: chest pain at Northfield Medical', { allowedWords: OFFER_MESSAGE_VOCABULARY, allowedPhrases: ['Northfield Medical'] });
    expect(v.map((x) => [x.token, x.reason])).toEqual([
      ['chest', 'not_whitelisted'],
      ['pain', 'not_whitelisted'],
      ['at', 'not_whitelisted'],
    ]);
  });

  it('draftOfferMessage refuses to produce text that fails the guard (a hospital name is the only free text)', () => {
    expect(() => draftOfferMessage({ hospitalNames: ['Stroke Center'], startMs: et('18:35:00'), endMs: et('22:35:00') })).toThrow(/clinical term/);
  });
});
