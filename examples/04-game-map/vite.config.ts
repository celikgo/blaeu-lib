import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * The example runs against **source**, not against `dist`.
 *
 * Same alias block as the root `vitest.config.ts`, and for the same reason: an
 * example that needs `npm run build` first is an example that is one stale build
 * away from lying about the library. Edit `packages/core/src/...`, and the browser
 * reloads with the change.
 *
 * Note which packages are absent. There is no `@fleximap/plugin-topology` alias
 * here because nothing in this example imports it — and so JSTS, which is the bulk
 * of that plugin's weight, is not in this bundle at all. That is not a build trick;
 * it is what "topology is a plugin, not a core feature" actually buys you.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@fleximap/core/testing': r('../../packages/core/src/testing/index.ts'),
      '@fleximap/core': r('../../packages/core/src/index.ts'),
      '@fleximap/plugin-draw': r('../../packages/plugin-draw/src/index.ts'),
      '@fleximap/plugin-edit': r('../../packages/plugin-edit/src/index.ts'),
      '@fleximap/plugin-snap': r('../../packages/plugin-snap/src/index.ts'),
      '@fleximap/plugin-select': r('../../packages/plugin-select/src/index.ts'),
      '@fleximap/plugin-measure': r('../../packages/plugin-measure/src/index.ts'),
      '@fleximap/plugin-history': r('../../packages/plugin-history/src/index.ts'),
      '@fleximap/plugin-topology': r('../../packages/plugin-topology/src/index.ts'),
      '@fleximap/plugin-ui': r('../../packages/plugin-ui/src/index.ts'),
      '@fleximap/preset-cadastre': r('../../packages/preset-cadastre/src/index.ts'),
      '@fleximap/preset-urban': r('../../packages/preset-urban/src/index.ts'),
      '@fleximap/preset-game': r('../../packages/preset-game/src/index.ts'),
    },
  },

  /**
   * `src/main.ts` awaits `createFlexiMap()` at the top level. Vite's default build
   * target is ES2020, which predates top-level await, so say so — `dev` never noticed
   * (esbuild's dev target is esnext); only `vite build` failed.
   */
  build: { target: 'es2022' },
})
