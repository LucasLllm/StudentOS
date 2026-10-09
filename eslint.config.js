import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import explainedCatch from './eslint-rules/explained-catch.js';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/migrations/**', '**/.pgdata/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // Underscore prefix marks a parameter as intentionally unused -- common
      // in the tool stubs, where the signature is fixed but the body is a TODO.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // .cjs here is never a style choice. Electron preloads under sandbox: true
    // must be CommonJS -- ESM preloads are not supported -- and
    // electron-builder loads its config the same way. Dropping the sandbox to
    // satisfy a lint rule would trade a real security boundary for a
    // stylistic one.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  {
    // The desktop app drives browsers nobody can watch, so a caught error has
    // to be recorded, rethrown or explained. See eslint-rules/explained-catch.js.
    files: ['apps/desktop/src/**/*.mjs'],
    ignores: ['apps/desktop/src/**/*.test.mjs'],
    plugins: { contexto: { rules: { 'explained-catch': explainedCatch } } },
    // A warning until the existing catches are all explained; then an error.
    rules: { 'contexto/explained-catch': 'warn' },
  },

  // Must stay last: turns off stylistic rules that would fight Prettier.
  prettier,
);
