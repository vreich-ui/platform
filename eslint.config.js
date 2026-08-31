import astroEslintParser from 'astro-eslint-parser';
import reactHooks from 'eslint-plugin-react-hooks';
import eslintPluginAstro from 'eslint-plugin-astro';
import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import typescriptParser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  ...eslintPluginAstro.configs['flat/recommended'],
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.astro'],
    languageOptions: {
      parser: astroEslintParser,
      parserOptions: {
        parser: '@typescript-eslint/parser',
        extraFileExtensions: ['.astro'],
      },
    },
  },
  {
    files: ['**/*.{js,jsx,astro}'],
    rules: {
      'no-mixed-spaces-and-tabs': ['error', 'smart-tabs'],
    },
  },
  {
    // Define the configuration for `<script>` tag.
    // Script in `<script>` is assigned a virtual file name with the `.js` extension.
    files: ['**/*.{ts,tsx}', '**/*.astro/*.js'],
    languageOptions: {
      parser: typescriptParser,
    },
    rules: {
      // Note: you must disable the base rule as it can report incorrect errors
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The admin UI is React. `rules-of-hooks` is an ERROR because a hook placed
    // after an early return is not a style question — it throws "Rendered more
    // hooks than during the previous render" and unmounts the surface, and
    // nothing else in this repo can see it: `tsconfig.test.json` excludes
    // `packages/core/admin/**/*.tsx`, so the Node test suite never loads these
    // files, and `astro check` type-checks them without knowing what a hook is.
    // Added after exactly that bug reached a review in the admin-ux-8020 wave.
    //
    // `exhaustive-deps` is deliberately NOT enabled: it reports 25 pre-existing
    // warnings across the admin, several of them intentional. Turning it on is
    // a separate cleanup, not a gate.
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // .tmp holds local build-diff worktrees and compiled test output (both
    // full repo copies) — linting them triples every finding.
    ignores: ['dist', 'sites/*/dist', 'node_modules', '.github', 'types.generated.d.ts', '.astro', '.tmp'],
  },
];
