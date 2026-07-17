import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/**
 * The example runs against **source**, not against `dist`.
 *
 * The alias block is the same one the root `vitest.config.ts` uses, and for the same
 * reason: `npm run dev` in here needs no build step, and a type error introduced in the
 * kernel surfaces in this example immediately rather than after somebody remembers to
 * rebuild. An example that can only be run against a published artefact is an example
 * that silently rots.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@blaeu/core/testing': r('../../packages/core/src/testing/index.ts'),
      '@blaeu/core': r('../../packages/core/src/index.ts'),
      '@blaeu/plugin-draw': r('../../packages/plugin-draw/src/index.ts'),
      '@blaeu/plugin-edit': r('../../packages/plugin-edit/src/index.ts'),
      '@blaeu/plugin-snap': r('../../packages/plugin-snap/src/index.ts'),
      '@blaeu/plugin-select': r('../../packages/plugin-select/src/index.ts'),
      '@blaeu/plugin-measure': r('../../packages/plugin-measure/src/index.ts'),
      '@blaeu/plugin-history': r('../../packages/plugin-history/src/index.ts'),
      '@blaeu/plugin-topology': r('../../packages/plugin-topology/src/index.ts'),
      '@blaeu/plugin-ui': r('../../packages/plugin-ui/src/index.ts'),
      '@blaeu/preset-cadastre': r('../../packages/preset-cadastre/src/index.ts'),
      '@blaeu/preset-urban': r('../../packages/preset-urban/src/index.ts'),
      '@blaeu/preset-game': r('../../packages/preset-game/src/index.ts'),
    },
  },
  // `createBlaeuMap()` is async — the renderer must mount and every plugin's `setup()`
  // must finish before the map is usable — and `main.ts` awaits it at the top level
  // rather than hiding the whole example inside a `main()` wrapper. Top-level await
  // needs a modern target; a map that needs WebGL2 was never going to run on the old
  // one anyway.
  build: { target: 'esnext' },
  server: { port: 5202 },
})
