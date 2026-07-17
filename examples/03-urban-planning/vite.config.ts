import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url))

/**
 * The example runs against **source**, not against `dist`.
 *
 * Same alias block as the root `vitest.config.ts`, and for the same reason: an
 * example that needs `npm run build` before it will start is an example that is
 * broken for half the people who clone the repo. With these aliases, editing
 * `packages/preset-urban/src/zoning.ts` hot-reloads this page.
 *
 * Every workspace package is aliased, not just the four this example imports by
 * name: `@blaeu/preset-urban` pulls in the draw, edit, snap, select, measure,
 * history and topology plugins itself, and a missing alias there would resolve to a
 * `dist` that may not exist yet.
 *
 * A consumer installing BlaeuMap from npm needs none of this — `@blaeu/core`
 * resolves through the package's `exports` map. The alias exists only because we are
 * *inside* the monorepo.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@blaeu/core': pkg('core/src/index.ts'),
      '@blaeu/plugin-draw': pkg('plugin-draw/src/index.ts'),
      '@blaeu/plugin-edit': pkg('plugin-edit/src/index.ts'),
      '@blaeu/plugin-snap': pkg('plugin-snap/src/index.ts'),
      '@blaeu/plugin-select': pkg('plugin-select/src/index.ts'),
      '@blaeu/plugin-measure': pkg('plugin-measure/src/index.ts'),
      '@blaeu/plugin-history': pkg('plugin-history/src/index.ts'),
      '@blaeu/plugin-topology': pkg('plugin-topology/src/index.ts'),
      '@blaeu/plugin-ui': pkg('plugin-ui/src/index.ts'),
      '@blaeu/preset-urban': pkg('preset-urban/src/index.ts'),
    },
  },
  /*
   * `createBlaeuMap()` is async — the renderer must mount and every plugin's `setup`
   * must finish before the map is usable — and `src/main.ts` awaits it at the top
   * level rather than burying the whole example inside an `async function main()`.
   * Vite's default build target is ES2020, which predates top-level await, so say so.
   * Every browser MapLibre supports has had it since 2021.
   */
  build: { target: 'es2022' },

  server: { open: true },
})
