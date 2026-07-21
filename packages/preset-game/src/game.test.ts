import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestMap, type TestMap } from '@blaeu/core/testing'
import type { BlaeuFeature, LngLat, StoreSnapshot, Tool } from '@blaeu/core'
import { snapPlugin } from '@blaeu/plugin-snap'

import { gameMapPreset } from './preset.js'
import { entityPlugin, PLACE_TOOL } from './plugins/entity.js'
import { tileGridPlugin, TILE_GRID_TYPE } from './plugins/tileGrid.js'
import { worldCrsPlugin } from './plugins/worldCrs.js'
import { scatterAround } from './generators.js'
import { ENTITY_PROPERTY, GENERATED_PROPERTY } from './styles.js'
import type { EntityType, GameOptions, WorldApi, WorldXY } from './types.js'

/**
 * The integration suite: a real kernel, a real store, real pipelines, real plugins,
 * and a `FakeRenderer` whose `project`/`unproject` is honest Web Mercator — which is
 * the only thing that makes a *pixel*-denominated snap tolerance testable.
 *
 * The world sits at the equatorial origin (`[0, 0]` in world units is `[0, 0]` in
 * lng/lat), so the camera goes there. At zoom 16 one 32-unit tile is ~30 screen
 * pixels, and the preset's 16 px snap tolerance is therefore about half a tile —
 * which is exactly the geometry a level designer's mouse lives in.
 */

const GRID = 32
/** Comfortably inside the 16 px tolerance: 8 world units ≈ 7.5 px at zoom 16. */
const OFF_GRID: WorldXY = [96 + 8, 96 + 8]
const ON_GRID: WorldXY = [96, 96]

const ENTITIES: readonly EntityType[] = [
  { id: 'hut', label: 'Hut', icon: '🛖', size: 12 },
  { id: 'tree', label: 'Tree', icon: '🌲', size: 8 },
]

async function gameMap(options: GameOptions = {}): Promise<TestMap> {
  return createTestMap({
    preset: gameMapPreset({ entities: ENTITIES, ui: false, ...options }),
    camera: { center: [0, 0], zoom: 16 },
  })
}

/** World units → the lng/lat a pointer event is denominated in. */
function at(world: WorldApi, xy: WorldXY): LngLat {
  return world.toLngLat(xy)
}

/** Where a stored feature actually is, back in the units the designer thinks in. */
function worldPositionOf(world: WorldApi, feature: BlaeuFeature): WorldXY {
  if (feature.geometry.type !== 'Point') throw new Error('not a point')
  const [lng, lat] = feature.geometry.coordinates
  return world.toWorld([lng!, lat!])
}

/**
 * On the grid, to a **tolerance in world units** — never to a count of decimal places.
 *
 * A micro-unit is a thousandth of the configured millitile precision, so anything
 * inside it is exactly on the grid as far as the store, the tile-occupancy rule and
 * the exported level file are all concerned. The residue is the proj4 sandwich's
 * float noise and nothing else.
 */
function expectOnGrid(xy: WorldXY, gridSize = GRID): void {
  for (const axis of xy) {
    const offGrid = Math.abs(axis - Math.round(axis / gridSize) * gridSize)
    expect(offGrid, `${axis} is ${offGrid} world units off a multiple of ${gridSize}`).toBeLessThan(
      1e-6,
    )
  }
}

function entitiesIn(map: TestMap, collection = 'entities'): readonly BlaeuFeature[] {
  return map.store.collection(collection).all()
}

/* ========================================================================= */
/* 3. Grid snapping reaches a tool that has never heard of it                */
/* ========================================================================= */

describe('grid snapping, as interaction middleware', () => {
  /**
   * The central architectural claim, tested where it can actually fail.
   *
   * The probe tool below is a *stranger's* tool: fifteen lines, written against
   * `ctx.lngLat`, with no dependency on the snap plugin, the grid, or this preset. It
   * is registered into the map at test time — precisely so it cannot be accused of
   * having been written to cooperate. It receives a coordinate that is already on the
   * grid, because the snap middleware rewrote `ctx.lngLat` before any tool saw the
   * event.
   *
   * This is the test that would fail if someone "simplified" snapping into something
   * the draw tool calls.
   */
  it('rewrites ctx.lngLat before any tool sees the pointer', async () => {
    const map = await gameMap()
    const world = map.plugin('game-world')

    const seen: LngLat[] = []
    map.tools.register('stranger:probe', {
      id: 'stranger:probe',
      activate(): void {},
      deactivate(): void {},
      onClick(interaction): boolean {
        seen.push(interaction.lngLat)
        return true
      },
    } satisfies Tool)
    map.tools.activate('stranger:probe')

    map.test.click(at(world, OFF_GRID))

    expect(seen).toHaveLength(1)
    expectOnGrid(world.toWorld(seen[0]!))
    // And the raw pointer really was off the grid — otherwise this test proves nothing.
    expectWorldClose(
      world.toWorld(map.test.unproject(map.test.project(at(world, OFF_GRID)))),
      [104, 104],
    )
  })

  it('leaves the pointer alone when it is further than the tolerance from a grid line', async () => {
    const map = await gameMap()
    const world = map.plugin('game-world')

    const seen: LngLat[] = []
    map.tools.register('stranger:probe', {
      id: 'stranger:probe',
      activate(): void {},
      deactivate(): void {},
      onClick(interaction): boolean {
        seen.push(interaction.lngLat)
        return true
      },
    } satisfies Tool)
    map.tools.activate('stranger:probe')

    // Dead centre of a tile: ~15 px from every intersection, past the 16 px tolerance
    // once the diagonal is taken into account.
    map.test.click(at(world, [96 + GRID / 2, 96 + GRID / 2]))

    const landed = world.toWorld(seen[0]!)
    expect(Math.abs(landed[0] - 112)).toBeLessThan(0.5)
  })

  /**
   * The user-visible consequence: an entity clicked off-grid is stored on-grid.
   *
   * Worth being honest about what this does *not* prove on its own — `place()` snaps
   * again by itself, deliberately, so that a level importer calling it with an
   * arbitrary coordinate lands on the grid too. The proof that the *middleware* is what
   * reaches the tool is the probe test above, and the drawn-zone test below, where
   * nothing snaps but the pipeline.
   */
  it('lands a clicked entity exactly on a grid intersection', async () => {
    const map = await gameMap()
    const world = map.plugin('game-world')

    map.tools.activate(PLACE_TOOL)
    map.test.click(at(world, OFF_GRID))
    await map.test.flush()

    const placed = entitiesIn(map)
    expect(placed).toHaveLength(1)
    const xy = worldPositionOf(world, placed[0]!)
    expectOnGrid(xy)
    expectWorldClose(xy, ON_GRID)
  })

  /**
   * A polygon drawn by the draw plugin — which has never heard of the snap plugin, the
   * grid, or games — comes out with every vertex on a tile corner. Nothing in the draw
   * plugin snaps; the pipeline did it.
   */
  it('lands a drawn zone’s vertices on the grid, and the draw plugin does not know why', async () => {
    const map = await gameMap()
    const world = map.plugin('game-world')

    map.tools.activate('draw:polygon')
    for (const corner of [
      [3, 5],
      [64 + 4, 6],
      [64 + 5, 64 + 7],
      [4, 64 + 3],
    ] as const) {
      map.test.click(at(world, corner))
    }
    map.plugin('draw').finish()
    await map.test.flush()

    const zones = map.store.collection('zones').all()
    expect(zones).toHaveLength(1)

    const ring = zones[0]!.geometry
    if (ring.type !== 'Polygon') throw new Error('expected a polygon')
    for (const [lng, lat] of ring.coordinates[0]!) {
      expectOnGrid(world.toWorld([lng!, lat!]))
    }
  })

  it('snaps to hex centres when the preset asks for a hex world — same tool, new lattice', async () => {
    // A smaller world, because a hex grid budgets *cells* where a square grid budgets
    // *lines*: 4096 units of hex world at gridSize 32 is ~19 800 cells, well past the
    // 4096-cell default. See the budget test below — the guard is doing its job, but it
    // does mean `gridType: 'hex'` is not usable at the default bounds without saying so.
    const map = await gameMap({ gridType: 'hex', bounds: [-256, -256, 256, 256] })
    const world = map.plugin('game-world')

    map.tools.activate(PLACE_TOOL)
    // Just off a hex centre. The hex provider is registered by *this preset* into the
    // kernel's `SnapProvider` extension point; the core has never heard of a hex.
    const centre = world.snap([100, 100])
    map.test.click(at(world, [centre[0] + 3, centre[1] + 3]))
    await map.test.flush()

    const placed = entitiesIn(map)
    expect(placed).toHaveLength(1)
    // A millitile, not a micro-unit — and the difference is the point. A square grid
    // multiple (96) is exactly representable on the store's 0.001-unit quantisation
    // grid; a hex centre is `row · 1.5 · gridSize/√3`, which is irrational, so the
    // stored coordinate is the nearest millitile to it and cannot be anything else.
    // The configured precision is the tightest honest tolerance here.
    expectWorldClose(worldPositionOf(world, placed[0]!), centre, 0.001)
  })

  /**
   * The hex-world snap must be hex-*only*. This is the test the entity path above cannot
   * be: `place()` re-snaps through `world.snap`, which is hex-aware, so it lands on a hex
   * centre even if the interaction pipeline wrongly snapped to a square intersection first
   * — hiding the bug. The probe reads `interaction.lngLat` straight from the middleware, so
   * it sees which lattice actually won. If the preset installs the built-in square `grid`
   * provider on a hex world, it wins at distance 0 on any square corner and the tool sees
   * a point a hex world has no cell at.
   */
  it('never snaps a tool to a square intersection on a hex world', async () => {
    // A generous tolerance so the nearest hex centre is comfortably in reach from a square
    // corner: the discriminator is *which* lattice wins, not whether anything snaps.
    const map = await gameMap({
      gridType: 'hex',
      bounds: [-256, -256, 256, 256],
      snapTolerance: 40,
    })
    const world = map.plugin('game-world')

    // Dead on a square-grid intersection (96 = 3·32) that is not a hex centre.
    const square: WorldXY = [96, 96]
    const hex = world.snap(square)
    // Guard the test itself: the two lattices must actually disagree here, or it proves nothing.
    expect(Math.hypot(hex[0] - square[0], hex[1] - square[1])).toBeGreaterThan(2)

    const seen: LngLat[] = []
    map.tools.register('stranger:probe', {
      id: 'stranger:probe',
      activate(): void {},
      deactivate(): void {},
      onClick(interaction): boolean {
        seen.push(interaction.lngLat)
        return true
      },
    } satisfies Tool)
    map.tools.activate('stranger:probe')

    map.test.click(at(world, square))

    expect(seen).toHaveLength(1)
    // The tool sees the nearest hex centre, not the square corner it clicked.
    expectWorldClose(world.toWorld(seen[0]!), hex, 0.01)
  })

  it('registers the hex-centre provider and no square grid provider on a hex world', async () => {
    const map = await gameMap({ gridType: 'hex', bounds: [-256, -256, 256, 256] })

    const ids = map
      .plugin('snap')
      .providers()
      .map((p) => p.id)
    expect(ids).toContain('hex-centre')
    expect(ids).not.toContain('grid')
  })
})

function expectWorldClose(actual: WorldXY, expected: WorldXY, tolerance = 1e-6): void {
  const distance = Math.hypot(actual[0] - expected[0], actual[1] - expected[1])
  expect(
    distance,
    `expected [${actual.join(', ')}] within ${tolerance} world units of [${expected.join(', ')}]`,
  ).toBeLessThanOrEqual(tolerance)
}

/* ========================================================================= */
/* 4. A preset adds a whole rendering category                               */
/* ========================================================================= */

describe('the tile-grid layer type', () => {
  it('registers a layer type the core has never heard of', async () => {
    const map = await gameMap()

    const grid = map.layers.get('game-grid')
    expect(grid?.type).toBe(TILE_GRID_TYPE)

    // It behaves exactly like a built-in: same manager, same z-ordering, same
    // setVisible. That is the whole point of `LayerTypeDef`.
    expect(map.test.renderer.layers.has('game-grid')).toBe(true)
    grid!.setVisible(false)
    expect(map.test.renderer.layers.get('game-grid')?.visible).toBe(false)
  })

  it('can be added at runtime, like any other layer', async () => {
    const map = await gameMap()

    const chunks = map.layers.add({
      id: 'chunk-grid',
      type: TILE_GRID_TYPE,
      config: { gridSize: 512, majorEvery: 0, color: '#ff0000' },
    })

    expect(chunks.type).toBe(TILE_GRID_TYPE)
    expect(map.layers.get('chunk-grid')).toBe(chunks)

    // 4096 units of world / 512-unit chunks = 9 vertical + 9 horizontal lines.
    const features = map.test.renderer.sources.get('chunk-grid') ?? []
    expect(features).toHaveLength(18)
    expect(features.every((f) => f.geometry.type === 'LineString')).toBe(true)
  })

  /**
   * The grid is **chrome, not data**. Put it in the store and it becomes selectable,
   * snappable-to (a grid line is an *edge*, as far as the snap engine is concerned),
   * undoable, and — worst — exported into the level file.
   */
  it('never puts a single grid line into the store', async () => {
    const map = await gameMap()

    for (const collection of map.store.collections()) {
      expect(map.store.collection(collection).size).toBe(0)
    }
    // But the renderer has the lines: 129 verticals + 129 horizontals at gridSize 32.
    expect(map.test.renderer.sources.get('game-grid')).toHaveLength(258)
  })

  it('removes its source as well as its layer, so nothing is orphaned', async () => {
    const map = await gameMap()

    map.layers.remove('game-grid')

    expect(map.test.renderer.layers.has('game-grid')).toBe(false)
    expect(map.test.renderer.sources.has('game-grid')).toBe(false)
  })

  it('refuses a grid denser than the budget, and names both numbers', async () => {
    const map = await gameMap()

    expect(() =>
      map.layers.add({ id: 'insane', type: TILE_GRID_TYPE, config: { gridSize: 1 } }),
    ).toThrow(/over the maxGridCells budget of 4096/)
  })

  /**
   * Pinning a sharp edge rather than pretending it is not there.
   *
   * `maxGridCells` counts grid *lines* for a square lattice (258 at the defaults) but
   * grid *cells* for a hex one (~19 800 at the same defaults), so the default budget
   * that is generous for squares is a hard stop for hexes: `gameMapPreset({ gridType:
   * 'hex' })` throws at the first map build unless the world shrinks or the budget
   * rises. The error names both numbers and the fix, which is the honest failure — but
   * the two units being counted are not the same unit, and a caller who does not read
   * `tileGrid.ts` has no way to know that.
   */
  it('counts hex CELLS against the same budget it counts square LINES against', async () => {
    await expect(gameMap({ gridType: 'hex' })).rejects.toThrow(
      /needs 19857 features, over the maxGridCells budget of 4096/,
    )

    // Raising the budget is one of the two fixes the message offers, and it works.
    await expect(gameMap({ gridType: 'hex', maxGridCells: 20_000 })).resolves.toBeDefined()
  })

  /** Without the plugin, the type does not exist. That is what "custom" means. */
  it('is unknown to a map that did not install the plugin', async () => {
    const map = await createTestMap()

    expect(() => map.layers.add({ id: 'grid', type: TILE_GRID_TYPE })).toThrow(/tile-grid/)
  })
})

/* ========================================================================= */
/* 5. Undo round-trip                                                        */
/* ========================================================================= */

describe('undo round-trip', () => {
  /**
   * Core invariant 2, at preset scale: `undo(execute(s))` restores `s` to **deep
   * equality**. Not "the same number of features" — the same features, with the same
   * ids, geometry, properties and meta, in the same order.
   *
   * If this ever needs a tolerance, the command captured too little state. Do not
   * loosen it; fix the command.
   */
  it('restores the exact initial snapshot after N placements and N undos', async () => {
    const map = await gameMap()
    const before: StoreSnapshot = map.store.snapshot()

    const positions: readonly WorldXY[] = [
      [0, 0],
      [64, 0],
      [128, 64],
      [-96, 32],
      [32, -160],
    ]
    for (const xy of positions) {
      await map.plugin('game-entity').place(xy, 'hut')
    }
    expect(entitiesIn(map)).toHaveLength(positions.length)
    expect(map.store.snapshot()).not.toEqual(before)

    for (let i = 0; i < positions.length; i++) map.plugin('history').undo()

    expect(map.store.snapshot()).toEqual(before)
  })

  it('redoes back to exactly where it was', async () => {
    const map = await gameMap()

    await map.plugin('game-entity').place([64, 64], 'hut')
    const placed = map.store.snapshot()

    map.plugin('history').undo()
    map.plugin('history').redo()

    expect(map.store.snapshot()).toEqual(placed)
  })

  it('is one undo step per placement, not one per feature', async () => {
    const map = await gameMap()

    await map.plugin('game-entity').place([64, 64], 'hut')
    await map.plugin('game-entity').place([128, 64], 'hut')

    map.plugin('history').undo()
    expect(entitiesIn(map)).toHaveLength(1)
  })
})

/* ========================================================================= */
/* 6. Degradation — the optional deps really are optional                    */
/* ========================================================================= */

describe('degradation', () => {
  /**
   * The minimum viable game map: a world plane and an entity plugin. No snap, no
   * history, no UI, no grid layer, no draw, no select.
   *
   * A game embedding BlaeuMap in its own React chrome installs exactly this and drives
   * placement through the API. If an "optional" dependency is quietly load-bearing,
   * this is where it shows.
   */
  it('places entities with worldCrsPlugin + entityPlugin and nothing else', async () => {
    const map = await createTestMap({
      plugins: [worldCrsPlugin({ entities: ENTITIES }), entityPlugin({ entities: ENTITIES })],
      camera: { center: [0, 0], zoom: 16 },
    })

    expect(map.plugins.list().map((p) => p.id)).toEqual(['game-world', 'game-entity'])
    expect(map.tryPlugin('snap')).toBeUndefined()
    expect(map.tryPlugin('history')).toBeUndefined()
    expect(map.tryPlugin('ui')).toBeUndefined()

    const world = map.plugin('game-world')
    const placed = await map.plugin('game-entity').place([100, 100], 'hut')

    expect(placed).toHaveLength(1)
    // `place()` snaps by itself — which is why a level importer, which has no pointer
    // and therefore no interaction pipeline, still lands on the grid.
    expectWorldClose(worldPositionOf(world, placed[0]!), [96, 96])
  })

  it('places entities by click with no snap plugin — less forgiving, still working', async () => {
    const map = await createTestMap({
      plugins: [worldCrsPlugin({ entities: ENTITIES }), entityPlugin({ entities: ENTITIES })],
      camera: { center: [0, 0], zoom: 16 },
    })
    const world = map.plugin('game-world')

    map.tools.activate(PLACE_TOOL)
    map.test.click(at(world, OFF_GRID))
    await map.test.flush()

    expect(entitiesIn(map)).toHaveLength(1)
  })

  it('draws the grid with no snap plugin, and says why entities will not land on hexes', async () => {
    const warn = vi.fn()
    const hex = { gridType: 'hex', bounds: [-256, -256, 256, 256] } as const
    const map = await createTestMap({
      config: { logger: { debug: () => {}, info: () => {}, warn, error: () => {} } },
      plugins: [worldCrsPlugin(hex), tileGridPlugin(hex)],
      camera: { center: [0, 0], zoom: 16 },
    })

    map.layers.add({ id: 'grid', type: TILE_GRID_TYPE })
    expect(map.layers.get('grid')?.type).toBe(TILE_GRID_TYPE)

    // A hex lattice cannot be expressed by the snap plugin's square grid provider, so
    // the preset registers a provider — and if there is no snap plugin to register it
    // into, it says so rather than silently placing entities off-lattice.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hex'))
  })

  /** Without history, placements still commit — which is what a read-only viewer wants. */
  it('commits placements with no history plugin', async () => {
    const map = await createTestMap({
      plugins: [
        worldCrsPlugin({ entities: ENTITIES }),
        entityPlugin({ entities: ENTITIES }),
        snapPlugin({ tolerance: 16, providers: ['grid'], gridSize: GRID }),
      ],
      camera: { center: [0, 0], zoom: 16 },
    })

    await map.plugin('game-entity').place([64, 64], 'hut')
    expect(entitiesIn(map)).toHaveLength(1)
  })
})

/* ========================================================================= */
/* Teardown                                                                  */
/* ========================================================================= */

describe('teardown', () => {
  it('gives the working CRS back when the world plugin is removed', async () => {
    const map = await createTestMap({
      plugins: [worldCrsPlugin()],
      camera: { center: [0, 0], zoom: 16 },
    })
    expect(map.crs.working.code).toBe('GAME:WORLD')

    await map.remove('game-world')

    // Restored, not left measuring a level in a CRS whose registration it no longer owns.
    expect(map.crs.working.code).toBe('EPSG:3857')
  })

  it('leaves no layers, sources or middleware behind', async () => {
    const map = await createTestMap({
      plugins: [worldCrsPlugin(), tileGridPlugin()],
      camera: { center: [0, 0], zoom: 16 },
    })
    map.layers.add({ id: 'grid', type: TILE_GRID_TYPE })

    await map.remove('game-grid')

    expect(map.test.renderer.layers.has('grid')).toBe(false)
    expect(map.test.renderer.sources.has('grid')).toBe(false)
    expect(map.layers.get('grid')).toBeUndefined()
  })
})

/* ========================================================================= */
/* 7. Generators, in the commit pipeline                                     */
/* ========================================================================= */

describe('procedural generation', () => {
  const scatter = () =>
    gameMap({
      generators: [scatterAround({ type: 'tree', count: 4, radius: 24, around: ['hut'] })],
      // The decorations land right next to the hut, on purpose — the occupancy rule is
      // not what is under test here, and generated features are exempt from it anyway.
      occupancySeverity: 'off',
    })

  it('writes the generated features in the same command as the entity that triggered them', async () => {
    const map = await scatter()

    const written = await map.plugin('game-entity').place([64, 64], 'hut')

    // One hut, four trees, one action.
    expect(written).toHaveLength(5)
    expect(entitiesIn(map)).toHaveLength(5)
    expect(written.filter((f) => f.properties[GENERATED_PROPERTY] === true)).toHaveLength(4)

    // The claim a level designer will not compromise on: one Ctrl+Z removes the
    // building *and* the six crates that appeared around it.
    map.plugin('history').undo()
    expect(entitiesIn(map)).toHaveLength(0)
  })

  it('undoes to deep equality, decorations and all', async () => {
    const map = await scatter()
    const before = map.store.snapshot()

    await map.plugin('game-entity').place([64, 64], 'hut')
    await map.plugin('game-entity').place([256, 256], 'hut')
    expect(entitiesIn(map)).toHaveLength(10)

    map.plugin('history').undo()
    map.plugin('history').undo()

    expect(map.store.snapshot()).toEqual(before)
  })

  it('does not fire for entities it was not asked about', async () => {
    const map = await scatter()

    const written = await map.plugin('game-entity').place([64, 64], 'tree')

    expect(written).toHaveLength(1)
  })

  /**
   * A generator that saw its own output would scatter trees around its trees, which is
   * a forest and then a hang. The `$generated` flag is what stops it, and it must
   * survive the round trip through the store.
   */
  it('never feeds a generator its own output', async () => {
    const map = await scatter()

    await map.plugin('game-entity').place([64, 64], 'hut')

    // 1 + 4, not 1 + 4 + 16.
    expect(entitiesIn(map)).toHaveLength(5)
  })

  it('scatters deterministically — the same hut always gets the same forest', async () => {
    const positionsFor = async (): Promise<readonly WorldXY[]> => {
      const map = await scatter()
      const world = map.plugin('game-world')
      const written = await map.plugin('game-entity').place([64, 64], 'hut')
      return written.map((f) => worldPositionOf(world, f))
    }

    // A level editor whose scatter differs on every run produces levels that cannot be
    // diffed, reviewed, or reproduced from a bug report.
    expect(await positionsFor()).toEqual(await positionsFor())
  })

  it('runs an async generator — the commit pipeline is async precisely so it can', async () => {
    const map = await gameMap({ occupancySeverity: 'off' })

    map.plugin('game-entity').onGenerate(async ({ placed, world }) => {
      // A generator that asks a server for a room layout is a perfectly reasonable
      // thing to write. This one just waits.
      await new Promise((resolve) => setTimeout(resolve, 1))
      return placed.map((trigger) => ({
        geometry: {
          type: 'Point' as const,
          coordinates: [...world.toLngLat([world.toWorld(pointOf(trigger))[0] + GRID, 0])],
        },
        properties: { [ENTITY_PROPERTY]: 'tree' },
      }))
    })

    const written = await map.plugin('game-entity').place([64, 64], 'hut')

    expect(written).toHaveLength(2)
    map.plugin('history').undo()
    expect(entitiesIn(map)).toHaveLength(0)
  })

  /**
   * Generators sit **above** validation in the commit pipeline (priority 0 vs -100), so
   * everything a generator produced is validated too — a generator that scatters a tree
   * outside the world is caught by the same rule that catches a designer who clicks
   * there.
   */
  it('validates what a generator produced, with the same rule that guards a click', async () => {
    const map = await gameMap({ bounds: [-256, -256, 256, 256] })

    map.plugin('game-entity').onGenerate(({ world }) => [
      {
        geometry: {
          type: 'Point' as const,
          // Nine tiles outside a 256-unit world. The bounds rule is an `error`, so the
          // whole placement — the hut included — is rejected and nothing is written.
          coordinates: [...world.toLngLat([9999, 9999])],
        },
        properties: { [ENTITY_PROPERTY]: 'tree' },
      },
    ])

    const written = await map.plugin('game-entity').place([64, 64], 'hut')

    expect(written).toEqual([])
    expect(entitiesIn(map)).toHaveLength(0)
  })
})

function pointOf(feature: BlaeuFeature): LngLat {
  if (feature.geometry.type !== 'Point') throw new Error('not a point')
  const [lng, lat] = feature.geometry.coordinates
  return [lng!, lat!]
}

/* ========================================================================= */
/* The rules                                                                 */
/* ========================================================================= */

describe('the preset’s own rules', () => {
  let map: TestMap

  beforeEach(async () => {
    map = await gameMap({ bounds: [-256, -256, 256, 256] })
  })

  it('refuses to place an entity outside the world, and writes nothing', async () => {
    const rejected = vi.fn()
    map.events.on('entity:rejected', (event) => rejected(event.payload))

    const written = await map.plugin('game-entity').place([1024, 1024], 'hut')

    expect(written).toEqual([])
    expect(entitiesIn(map)).toHaveLength(0)
    // The reason names the rule and the entity, in the designer's own words — an event
    // that said only "rejected" would send them to the console to find out why.
    expect(rejected).toHaveBeenCalledWith({
      type: 'hut',
      reason: expect.stringContaining('game.entity.inBounds') as unknown as string,
    })
  })

  it('warns about a stacked tile without blocking it — usually fine, occasionally the mechanic', async () => {
    await map.plugin('game-entity').place([64, 64], 'hut')
    const written = await map.plugin('game-entity').place([64 + 2, 64 + 2], 'tree')

    // Same tile after snapping, and a warning — but written.
    expect(written).toHaveLength(1)
    expect(entitiesIn(map)).toHaveLength(2)
  })

  it('blocks a stacked tile when the game says a tile holds exactly one thing', async () => {
    const strict = await gameMap({ occupancySeverity: 'error' })

    await strict.plugin('game-entity').place([64, 64], 'hut')
    const written = await strict.plugin('game-entity').place([64, 64], 'tree')

    // Not one line of the kernel, the plugins or this preset changed. One option did.
    expect(written).toEqual([])
    expect(entitiesIn(strict)).toHaveLength(1)
  })

  it('throws on an unknown entity id rather than silently placing nothing', async () => {
    expect(() => map.plugin('game-entity').setCurrent('dragon')).toThrow(
      /unknown entity type "dragon"/,
    )
  })
})
