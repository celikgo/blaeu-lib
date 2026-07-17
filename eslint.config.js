// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.tsbuild/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'examples/*/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Empty interfaces are load-bearing here: `BlaeuPluginRegistry` and
      // `BlaeuEventMap` ship empty and are filled in by plugins via declaration
      // merging. That is the whole typed-plugin mechanism, not an oversight.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
    },
  },
  {
    // Build scripts run in Node, not the browser. Without this they trip `no-undef`
    // on `console` and `process`, which are perfectly legitimate there.
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    // The core may not reach into plugins. `npm run lint:boundaries` enforces
    // this across package.json files too; this catches it in the editor.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@blaeu/plugin-*', '@blaeu/preset-*'],
              message:
                'Core must not import plugins (invariant 1). If core needs this, add an extension point instead.',
            },
          ],
        },
      ],
    },
  },
)
