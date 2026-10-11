import type { Testimonial as T } from '@/server/testimonial';

/** Env-gated quote (B2). Callers pass testimonial() from the server; null renders nothing. */
export function Testimonial({ value }: { readonly value: T | null }) {
  if (value === null) return null;
  return (
    <figure data-testid="testimonial" className="mt-8 border-l-2 border-accent pl-4">
      <blockquote className="text-[18px] leading-snug text-text">{value.quote}</blockquote>
      <figcaption className="mt-2 text-[13px] text-muted">{value.attribution}</figcaption>
    </figure>
  );
}
