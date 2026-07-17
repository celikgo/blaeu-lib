import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * A single Vitest config for the whole workspace.
 *
 * Note the `alias` block: tests resolve `@blaeu/*` to **source**, not to
 * `dist`. That means `npm test` needs no build step, and a type error in the core
 * surfaces in a plugin's test run immediately instead of after a rebuild.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@blaeu/core/testing': r('./packages/core/src/testing/index.ts'),
      '@blaeu/core': r('./packages/core/src/index.ts'),
      '@blaeu/plugin-draw': r('./packages/plugin-draw/src/index.ts'),
      '@blaeu/plugin-edit': r('./packages/plugin-edit/src/index.ts'),
      '@blaeu/plugin-snap': r('./packages/plugin-snap/src/index.ts'),
      '@blaeu/plugin-select': r('./packages/plugin-select/src/index.ts'),
      '@blaeu/plugin-measure': r('./packages/plugin-measure/src/index.ts'),
      '@blaeu/plugin-history': r('./packages/plugin-history/src/index.ts'),
      '@blaeu/plugin-topology': r('./packages/plugin-topology/src/index.ts'),
      '@blaeu/plugin-ui': r('./packages/plugin-ui/src/index.ts'),
      '@blaeu/preset-cadastre': r('./packages/preset-cadastre/src/index.ts'),
      '@blaeu/preset-urban': r('./packages/preset-urban/src/index.ts'),
      '@blaeu/preset-game': r('./packages/preset-game/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.{test,spec}.ts', 'packages/*/test/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/testing/**', '**/index.ts', '**/*.d.ts'],
    },
  },
})
