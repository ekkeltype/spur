import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The simulation and the run content must stay pure: no DOM, no timers, no Math.random(), no networking (spec §0).
    files: ['src/sim/**/*.ts', 'src/content/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'performance', 'localStorage', 'fetch'],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded PRNG in src/sim/rng.ts.' },
        { object: 'Date', property: 'now', message: 'The sim is tick-based; time comes from GameState.tick.' },
      ],
      'no-restricted-imports': ['error', { patterns: ['**/net/**', '**/render/**', '**/ui/**', '**/audio/**', '**/save/**', 'peerjs'] }],
    },
  },
  {
    files: ['tests/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
]);
