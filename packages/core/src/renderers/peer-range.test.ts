/**
 * The declared maplibre-gl peer range is written in four places. Keep them one number.
 *
 * This is a consistency test, not a behaviour test, and it exists because the range has already
 * drifted once with consequences. The manifest said `>=4.7.0 <6` while the renderer cleaned up
 * listeners through maplibre 5's `Subscription.unsubscribe()` — API that does not exist on 4,
 * where `map.on()` returns the map. `destroy()` threw, the throw escaped `whenLoaded`'s `load`
 * handler before it could resolve, and `mount()` hung forever on every v4 host. The suite stayed
 * green because the fake maplibre map returned a v5-shaped subscription.
 *
 * The CI `peer-range` matrix is what proves the code actually compiles against the floor and the
 * ceiling. This test is the cheaper half: it proves the four *declarations* agree, so a future
 * bump cannot update the manifest and leave the scaffold minting new packages against the old
 * bound, or leave the runtime error message telling a user to install a version we no longer
 * accept.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8')

/** The one source of truth: what `@blaeu/core` actually declares to npm. */
const declared = (
  JSON.parse(repoFile('packages/core/package.json')) as {
    peerDependencies: Record<string, string>
  }
).peerDependencies['maplibre-gl']!

describe('the maplibre-gl peer range is declared consistently', () => {
  it('is a bounded range, not an open one', () => {
    // An unbounded peer range is a promise about majors that do not exist yet, and the v4/v5
    // teardown incident is what that promise costs when it is wrong.
    expect(declared).toMatch(/^>=\d+\.\d+\.\d+ <\d+$/)
  })

  it('the scaffold mints new packages against the same range', () => {
    // `npm run scaffold` is the documented way to add a package (CONTRIBUTING.md). If it carries
    // a stale bound, every package created after a bump silently disagrees with the core.
    const scaffold = repoFile('scripts/scaffold-packages.mjs')
    const found = /peers: \{ 'maplibre-gl': '([^']+)' \}/.exec(scaffold)
    expect(found?.[1]).toBe(declared)
  })

  it('the loader’s error message names the same range', () => {
    // This string is what a user sees when the peer is missing or aliased. Telling them to
    // install a version the manifest rejects sends them in a circle.
    const renderer = repoFile('packages/core/src/renderers/MapLibreRenderer.ts')
    const [, floor, ceiling] = /^>=(\d+\.\d+)\.\d+ <(\d+)$/.exec(declared)!
    expect(renderer).toContain(`a compatible version (>=${floor} <${ceiling}) is installed`)
  })

  it('the teardown note documents the same range it reasons about', () => {
    const renderer = repoFile('packages/core/src/renderers/MapLibreRenderer.ts')
    const [, floor, ceiling] = /^>=(\d+\.\d+)\.\d+ <(\d+)$/.exec(declared)!
    expect(renderer).toContain(`supports (peer \`>=${floor} <${ceiling}\`)`)
  })

  it('the dev dependency sits inside the declared range', () => {
    // The default CI leg installs this one. If it drifts outside the peer range, the suite is
    // testing a version the library does not claim to support.
    const core = JSON.parse(repoFile('packages/core/package.json')) as {
      devDependencies: Record<string, string>
    }
    const dev = core.devDependencies['maplibre-gl']!
    const [, floorMajor, ceilingMajor] = /^>=(\d+)\.\d+\.\d+ <(\d+)$/.exec(declared)!
    const devMajor = /(\d+)/.exec(dev)![1]!
    expect(Number(devMajor)).toBeGreaterThanOrEqual(Number(floorMajor))
    expect(Number(devMajor)).toBeLessThan(Number(ceilingMajor))
  })
})
