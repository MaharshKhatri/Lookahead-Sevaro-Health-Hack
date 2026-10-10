/**
 * Next.js server start hook: discover the Bedrock model (ListInferenceProfiles)
 * once at startup so the first "Explain" is fast. Failure only logs; narration
 * falls back to the template.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NARRATION === 'off') return;
  try {
    const { warmNarrator } = await import('./server/narrate/bedrock');
    void warmNarrator();
  } catch (e) {
    console.warn('[lookahead] narration warm-up skipped:', e instanceof Error ? e.message : e);
  }
}
