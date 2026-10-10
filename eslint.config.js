import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const IO_MODULES = ['fs', 'fs/promises', 'path', 'http', 'https', 'net', 'child_process'].flatMap((m) => [m, `node:${m}`]);

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'data/**', 'docs/**'] },
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
);
