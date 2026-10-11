# Lookahead website

The product website for Lookahead (Rutgers Health Hack 2026, Sevaro Challenge 2). A standalone Next.js 15 app, statically rendered. It is not part of the product's pnpm workspace and has its own `package-lock.json`.

```sh
cd site
npm install
npm run dev      # http://localhost:3400
npm run build    # static build; type-checks and lints
```

## Deploying on Vercel

- Root Directory: `site`
- Framework preset: Next.js (also set in `vercel.json`, with `npm install` and `npm run build`)
- Environment variables, all optional. A button whose variable is unset is not rendered:
  - `NEXT_PUBLIC_DEMO_URL`: the live product ("Open the live product")
  - `NEXT_PUBLIC_VIDEO_URL`: the demo video ("Watch the 5-minute demo")
  - `NEXT_PUBLIC_REPO_URL`: the repository ("Read the code", "Source code")

## Content rules

Every fact on the site comes from `content/facts.ts`, which cites the repository report each value was copied from. A fact set to `null` is hidden, never replaced by a placeholder. Screenshots in `public/screens/` are copied from the product's own Playwright captures (`docs/screens/ui/`).
