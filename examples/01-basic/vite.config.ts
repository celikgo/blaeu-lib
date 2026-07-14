import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url))

/**
 * The example runs against **source**, not against `dist`.
 *
 * Same alias block as the root `vitest.config.ts`, and for the same reason: an
 * example that needs `npm run build` before it will start is an example that is
 * broken for half of the people who clone the repo. With these aliases, editing
 * `packages/core/src/FlexiMap.ts` hot-reloads the page.
 *
 * A consumer installing FlexiMap from npm needs none of this — `@fleximap/core`
 * resolves through the package's `exports` map. The alias exists only because we
 * are *inside* the monorepo.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@fleximap/core': pkg('core/src/index.ts'),
      '@fleximap/plugin-snap': pkg('plugin-snap/src/index.ts'),
      '@fleximap/plugin-draw': pkg('plugin-draw/src/index.ts'),
      '@fleximap/plugin-select': pkg('plugin-select/src/index.ts'),
      '@fleximap/plugin-history': pkg('plugin-history/src/index.ts'),
      '@fleximap/plugin-ui': pkg('plugin-ui/src/index.ts'),
    },
  },
  server: { open: true },

  /**
   * `src/main.ts` awaits `createFlexiMap()` at the top level rather than burying the
   * whole example inside an `async function main()` — the map is not usable until it
   * resolves, and hiding that in a wrapper teaches the reader the wrong shape.
   *
   * Vite's default build target is ES2020, which predates top-level await, so say so.
   * `dev` never noticed (esbuild's dev target is esnext); only `vite build` failed.
   */
  build: { target: 'es2022' },
})
