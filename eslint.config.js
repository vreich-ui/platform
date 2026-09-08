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
    // W22 (site-binding threading): core server code must THREAD the SiteBinding
    // into every store handle it opens, instead of letting the getter fall back
    // to the platform default env-var names. A discarded binding is invisible at
    // runtime today (all four sites bind PLATFORM_ENV_NAMES, so the fallback
    // resolves identically) and would only surface as cross-tenant reads the day
    // a site rebinds — so the shape is guarded here, in the editor and in
    // `check:eslint`, rather than left to review.
    //
    // Not `scripts/audit-site-admin-parity.mjs`: that audit is per-site
    // PROVISIONING (netlify.toml, shims, env presence — read-only, no store
    // access). This is a core-code shape rule, which is what check:eslint is for.
    // Not a rule on the `_binding` parameter: that would miss unbound calls made
    // inside lib code or inside a handler that already has a binding in scope,
    // and would wrongly flag a future handler that genuinely needs nothing.
    files: ['packages/core/server/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name=/^get[A-Za-z]*(BlobStore|MembershipStore)$/]:not([callee.name='getNetlifyBlobStore']):not([callee.name='getBlobStoreSourceDiagnostics'])[arguments.length<2]",
          message: 'Store getters must receive the SiteBinding: get…Store(event, binding). See lib/site-binding.ts.',
        },
        {
          selector: "CallExpression[callee.name='getNetlifyBlobStore'][arguments.length<3]",
          message: 'getNetlifyBlobStore(name, event, binding) — thread the binding.',
        },
        {
          selector: "CallExpression[callee.name='getBlobStoreSourceDiagnostics'][arguments.length<3]",
          message: 'getBlobStoreSourceDiagnostics(name, event, binding) — thread the binding.',
        },
        {
          selector: "CallExpression[callee.name='getManagedBlobStore'][arguments.length<3]",
          message: 'getManagedBlobStore(name, event, binding) — thread the binding.',
        },
        {
          selector:
            'CallExpression[callee.name=/^(listManagedBlobStores|getCoreBlobStoreSourceDiagnostics)$/][arguments.length<2]',
          message:
            'Pass the SiteBinding: listManagedBlobStores(event, binding) / getCoreBlobStoreSourceDiagnostics(event, binding).',
        },
        {
          selector:
            'CallExpression[callee.name=/^(resolveRolesFromEvent|resolveAdminAccessFromEvent)$/][arguments.length<3]',
          message: 'Role resolution reads the users store — pass the SiteBinding.',
        },
      ],
    },
  },
  {
    // .tmp holds local build-diff worktrees and compiled test output (both
    // full repo copies) — linting them triples every finding.
    ignores: ['dist', 'sites/*/dist', 'node_modules', '.github', 'types.generated.d.ts', '.astro', '.tmp'],
  },
];
