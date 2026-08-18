import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * The browser suite. **Additive, and deliberately not part of `npm run verify`.**
 *
 * The 700-odd node tests run against `FakeRenderer`, which proves the renderer seam is real and
 * lets the whole library be tested with no GPU. It leaves exactly one surface unverified: our
 * translation of `LayerStyle` into MapLibre paint/layout, and our normalisation of MapLibre's
 * pointer events. A mocked `maplibre-gl` cannot check either, because the thing being checked
 * is whether *MapLibre* accepts what we hand it.
 *
 * Two rules keep this suite worth its runtime:
 *
 * 1. **Only what the fake cannot honestly reach.** Tile-source ref-counting,
 *    rollback-on-failed-add and the v4 teardown path are all better tested against the fake,
 *    where the failure modes can be induced. Duplicating them here buys nothing and costs a
 *    browser launch.
 * 2. **It is a fence, not a net.** It exists to stop a *fixed* defect from coming back, not to
 *    discover new ones. The defects it fences were found by reading the code.
 *
 * Not in `verify` because a WebGL browser is a different order of cost and flakiness from
 * `tsc` and a node runner, and a gate that is slow or flaky is a gate people learn to skip. CI
 * runs it on pull requests that touch `renderers/**`, and nightly.
 *
 * ## Known: maplibre 6 does not render under headless SwiftShader
 *
 * Measured on this exact config: **21/21 against maplibre 5.24, 18/21 against 6.4.0**. The three
 * that fail are the hit-testing ones, and the cause is upstream of them — on v6 the map never
 * reaches `loaded()`, so no render pass completes, and `queryRenderedFeatures` returns only what
 * has actually been *rendered*.
 *
 * It is a genuine non-render, not a timing margin: `whenQueryable` polls for fifteen seconds and
 * the map is still `loaded=false`. Neither the headless shell nor the full Chromium build makes
 * any difference, so it is not the cut-down GL stack in the shell either.
 *
 * The likely reason is one of v6's own breaking changes: it **removed WebGL1 and requires
 * WebGL2**, and SwiftShader's software WebGL2 appears not to give it everything it needs. That
 * makes this an environment limitation rather than a defect in this library — the style,
 * pointer, touch and basemap-swap tests all pass on v6, so our translation and normalisation
 * are fine.
 *
 * It is written down rather than papered over, because the honest consequence is real: the peer
 * range claims `<7`, `tsc` passes against 6.4.0, and **v6 rendering is unverified at runtime**.
 * CI therefore runs this suite twice — v5 as a required leg, v6 as an informational one that is
 * allowed to fail — so the gap stays visible and turns green by itself the day it closes. Before
 * publishing a version that claims v6, run this suite once on a GPU runner.
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
    },
  },
  test: {
    name: 'browser',
    include: ['packages/*/src/**/*.browser.test.ts'],
    // One file at a time. Each test mounts a real `Map`, and a browser caps live WebGL
    // contexts at roughly 16 — past that the oldest is silently killed and the failure looks
    // like an unrelated test flaking. Serialising is cheaper than debugging that.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      screenshotFailures: false,
      instances: [
        {
          browser: 'chromium',
          launch: {
            args: [
              // Headless Chromium has no GPU, so MapLibre's WebGL2 context has to come from
              // SwiftShader's software rasteriser. Without these the context request returns
              // null and every test fails with "Failed to initialize WebGL", which reads like
              // a MapLibre bug rather than a missing flag.
              '--use-gl=angle',
              '--use-angle=swiftshader',
              '--enable-unsafe-swiftshader',
              '--disable-gpu-sandbox',
            ],
          },
        },
      ],
    },
  },
})
