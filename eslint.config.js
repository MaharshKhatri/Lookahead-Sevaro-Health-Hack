import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const IO_MODULES = ['fs', 'fs/promises', 'path', 'http', 'https', 'net', 'child_process'].flatMap((m) => [m, `node:${m}`]);

export default defineConfig(
  { ignores: ['site/**', '**/node_modules/**', '**/dist/**', '**/coverage/**', 'data/**', 'docs/**', 'apps/web/.next/**', 'apps/web/next-env.d.ts', 'apps/web/test-results/**', 'apps/web/playwright-report/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    // CLAUDE.md rule 3: the engine is pure and deterministic.
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Engine is pure: take `now` (epoch ms) as an argument.' },
        { selector: "NewExpression[callee.name='Date']", message: 'Use luxon with an explicit offset or zone (CLAUDE.md rule 4).' },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: 'Use the seeded RNG.' },
      ],
      'no-restricted-imports': [
        'error',
        { paths: IO_MODULES.map((name) => ({ name, message: 'No I/O in the engine except src/data/loaders.ts.' })) },
      ],
    },
  },
  { files: ['packages/engine/src/data/loaders.ts'], rules: { 'no-restricted-imports': 'off' } },
  {
    // Web app (Session 6): hooks correctness; browser globals for client components.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
);
