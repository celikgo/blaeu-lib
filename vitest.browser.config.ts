import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * The browser suite. **Additive, and deliberately not part of `npm run verify`.**
 *
 * The 789 node tests run against `FakeRenderer`, which proves the renderer seam is real and
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
 * runs it in its own `browser` job, unconditionally — on every pull request, on every push to
 * main, and on the nightly schedule. There is no `paths:` filter narrowing it to
 * `renderers/**`, because what breaks the translation is rarely a change inside the renderer.
 *
 * ## Known: hit testing needs a GPU
 *
 * Four of these tests depend on a completed render pass, because `queryRenderedFeatures`
 * returns only what has been **rendered**. Headless software WebGL does not reliably deliver
 * one. Measured across two environments and two maplibre majors:
 *
 *     macOS + SwiftShader, maplibre 5   renders
 *     macOS + SwiftShader, maplibre 6   never reaches loaded()
 *     ubuntu-latest CI,     maplibre 5   never reaches loaded()
 *     ubuntu-latest CI,     maplibre 6   never reaches loaded()
 *
 * So the axis is the GPU, not the maplibre version — two earlier attempts at this assumed the
 * version and were wrong, the second one disproved by CI. v6 is merely stricter: it dropped
 * WebGL1 and requires WebGL2, which is why it also fails on the one machine where v5 works.
 * Neither the headless shell nor the full Chromium build changes the answer; that was measured
 * too, and the full build costs a 178 MB download for nothing.
 *
 * The suite therefore probes once for a render pass and gates those four tests on it, reporting
 * the outcome on every run so a shrunk suite can never read as a full one. Everything that does
 * not need a rasteriser — style translation, pointer normalisation, touch, basemap swap — runs
 * everywhere, on both majors. To cover hit testing, including the leading-zero id, run this
 * suite on a GPU runner.
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
