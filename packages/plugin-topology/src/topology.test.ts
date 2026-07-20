import { describe, expect, it } from 'vitest'
import {
  ANKARA,
  createTestMap,
  offsetMetres,
  parcelFixture,
  sharedEdgeParcels,
  type TestMap,
} from '@blaeu/core/testing'
import type {
  Command,
  FeatureInput,
  BlaeuFeature,
  ValidationContext,
  ValidationIssue,
} from '@blaeu/core'
import { AddFeaturesCommand, UpdateFeaturesCommand } from '@blaeu/core'

import {
  closedRings,
  minParcelArea,
  noDuplicateVertices,
  noOverlapWithNeighbours,
  noSelfIntersection,
  noSlivers,
  RULE_IDS,
  topologyPlugin,
} from './index.js'

/* ------------------------------------------------------------------ *
 * Fixtures beyond the core's
 * ------------------------------------------------------------------ */

/**
 * A bowtie whose two lobes are *unequal*.
 *
 * The core's own `selfIntersectingRing()` fixture cannot be used here: its lobes are
 * symmetric, so the ring's signed area is exactly zero, and the store's ingest
 * normaliser rejects a zero-area ring before any validation rule ever sees the
 * feature ("ring has zero area — its corners are collinear"). This one crosses itself
 * just as thoroughly and has an area of ~450 m², so it reaches the store — which is
 * the only place a topology rule can find it.
 *
 * The crossing is at ~(14.29 m, 21.43 m) from the origin: the intersection of the
 * segments (50,0)→(0,30) and (20,30)→(0,0).
 */
const CROSSING_EAST_M = 30 / 2.1
const CROSSING_NORTH_M = 1.5 * CROSSING_EAST_M

function bowtieParcel(id = 'bowtie'): FeatureInput {
  const a = ANKARA
  const b = offsetMetres(ANKARA, 50, 0)
  const c = offsetMetres(ANKARA, 0, 30)
  const d = offsetMetres(ANKARA, 20, 30)
  return {
    id,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [a[0], a[1]],
          [b[0], b[1]],
          [c[0], c[1]],
          [d[0], d[1]],
          [a[0], a[1]],
        ],
      ],
    },
    properties: {},
  }
}

/** `parcel-left` (50×40 at the origin) plus one that eats 5 m into it. */
function overlappingParcels(): readonly [FeatureInput, FeatureInput] {
  const left = parcelFixture('parcel-left')
  const right: FeatureInput = {
    id: 'parcel-right',
    geometry: {
      type: 'Polygon',
      coordinates: [ring(offsetMetres(ANKARA, 45, 0), 50, 40)],
    },
    properties: {},
  }
  return [left, right]
}

/** Two parcels that do not quite meet: a strip `gapMetres` wide down the 40 m shared edge. */
function gappedParcels(gapMetres: number): readonly [FeatureInput, FeatureInput] {
  const left = parcelFixture('parcel-left')
  const right: FeatureInput = {
    id: 'parcel-right',
    geometry: {
      type: 'Polygon',
      coordinates: [ring(offsetMetres(ANKARA, 50 + gapMetres, 0), 50, 40)],
    },
    properties: {},
  }
  return [left, right]
}

/**
 * A map whose working CRS is a real cadastral plane.
 *
 * The kernel's default is EPSG:3857 (Web Mercator), where a metre is not a metre: at
 * Ankara's latitude every length is inflated by 1/cos(39.93°) ≈ 1.30 and every area
 * by 1.70. A 200 m² overlap measures 340 m². That is fine for a basemap and useless
 * for a land registry, so every assertion below runs in EPSG:5254 (TUREF / TM30) —
 * which is also what a cadastre preset sets, and why it sets it.
 */
function cadastreMap(options: Parameters<typeof createTestMap>[0] = {}): Promise<TestMap> {
  return createTestMap({
    ...options,
    config: { ...options.config, crs: { working: 'EPSG:5254' } },
  })
}

function ring(
  origin: readonly [number, number],
  width: number,
  height: number,
): [number, number][] {
  const sw = origin
  const se = offsetMetres(origin, width, 0)
  const ne = offsetMetres(origin, width, height)
  const nw = offsetMetres(origin, 0, height)
  return [
    [sw[0], sw[1]],
    [se[0], se[1]],
    [ne[0], ne[1]],
    [nw[0], nw[1]],
    [sw[0], sw[1]],
  ]
}

/**
 * A rule's own `check()`, driven directly.
 *
 * The structural rules need this: the store *cleans* geometry on ingest — it closes
 * rings and drops duplicate vertices — so a fixture with a duplicate vertex cannot
 * be seeded and then found again. Which is exactly right, and exactly why the rules
 * that catch those defects have to be exercised on the pre-store geometry, the way
 * the commit pipeline sees them.
 */
function validationContext(map: TestMap): ValidationContext {
  return { store: map.store, crs: map.crs, t: (key, params) => map.i18n.t(key, params) }
}

function rawFeature(input: FeatureInput): BlaeuFeature {
  return {
    id: input.id ?? 'raw',
    geometry: input.geometry,
    properties: input.properties ?? {},
    meta: {
      collection: 'parcels',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    },
  }
}

const bySeverity = (
  issues: readonly ValidationIssue[],
  rule: string,
): ValidationIssue | undefined => issues.find((issue) => issue.rule === rule)

/* ------------------------------------------------------------------ *
 * The three tests every plugin owes
 * ------------------------------------------------------------------ */

describe('the plugin contract', () => {
  it('works with no other plugin installed (it has no optional dependencies to degrade from)', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [...sharedEdgeParcels()] },
    })

    const topology = map.plugin('topology')
    const issues = await topology.validate()

    // Two parcels sharing an edge exactly: no overlap, no gap, no sliver, nothing.
    expect(issues).toEqual([])
    expect(topology.issues).toEqual([])
    await map.destroy()
  })

  it('leaks nothing on removal', async () => {
    const baseline = await cadastreMap({})
    const before = baseline.debug.snapshot()
    await baseline.destroy()

    const map = await cadastreMap({ plugins: [topologyPlugin()] })
    map.plugin('topology').onIssues(() => {})
    await map.validation.run([])

    await map.remove('topology')

    // The core installs its own validation middleware and its own listeners, so the
    // honest assertion is "back to where a map with no plugins starts", not "zero".
    expect(map.debug.snapshot()).toEqual(before)
    expect(map.validation.list()).toEqual([])
    await map.destroy()
  })

  it('round-trips a fix through undo, to deep equality', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [bowtieParcel('bowtie')] },
    })

    // The command bus holds no undo stack — that is the history plugin's job — so the
    // round-trip is asserted against the command the repair actually dispatched.
    const commands: Command[] = []
    map.commands.onDidExecute((command) => commands.push(command))

    const before = map.store.snapshot()
    const issues = await map.plugin('topology').validate(['bowtie'])
    const issue = bySeverity(issues, RULE_IDS.selfIntersection)
    expect(issue).toBeDefined()

    expect(await map.plugin('topology').fix(issue!)).toBe(true)
    expect(map.store.snapshot()).not.toEqual(before)

    expect(commands).toHaveLength(1)
    map.commands._apply(commands[0]!, 'undo')

    expect(map.store.snapshot()).toEqual(before)
    await map.destroy()
  })
})

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

describe('noSelfIntersection', () => {
  it('rejects a bowtie and names the coordinate', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [bowtieParcel('bowtie')] },
    })

    const issues = await map.plugin('topology').validate(['bowtie'])
    const issue = bySeverity(issues, RULE_IDS.selfIntersection)

    expect(issue?.severity).toBe('error')
    expect(issue?.message).toContain('crosses itself')
    expect(issue?.data).toMatchObject({ detail: 'Self-intersection' })

    // The whole reason for carrying `at`: a UI can zoom straight to the crossing. It is
    // where the two crossing segments meet, and it must land there in *metres*.
    expect(issue?.at).toBeDefined()
    const [lng, lat] = issue!.at!
    const [x, y] = map.crs.working.forward([lng, lat])
    const [cx, cy] = map.crs.working.forward(
      offsetMetres(ANKARA, CROSSING_EAST_M, CROSSING_NORTH_M),
    )
    expect(Math.hypot(x - cx, y - cy)).toBeLessThan(0.5)

    await map.destroy()
  })

  it('passes a clean parcel', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [parcelFixture('clean')] },
    })
    expect(await map.plugin('topology').validate(['clean'])).toEqual([])
    await map.destroy()
  })
})

describe('noOverlapWithNeighbours', () => {
  it('reports the overlap area, in square metres', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [...overlappingParcels()] },
    })

    const issues = await map.plugin('topology').validate(['parcel-left'])
    const issue = bySeverity(issues, RULE_IDS.overlap)

    expect(issue?.severity).toBe('error')
    expect(issue?.data?.['neighbour']).toBe('parcel-right')
    // 5 m of overlap along the 40 m edge = 200 m². Metres, not square degrees: if this
    // number is ~1e-8, something is feeding JSTS lng/lat.
    expect(issue?.data?.['overlapArea'] as number).toBeGreaterThan(199)
    expect(issue?.data?.['overlapArea'] as number).toBeLessThan(201)
    await map.destroy()
  })

  it('does not report two parcels that share an edge exactly', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [...sharedEdgeParcels()] },
    })
    const issues = await map.plugin('topology').validate()
    expect(issues.filter((i) => i.rule === RULE_IDS.overlap)).toEqual([])
    await map.destroy()
  })

  it('rejects a single commit carrying two overlapping *new* parcels (co-committed sibling)', async () => {
    // Both parcels are new and exist only inside this one command. Validation runs *before*
    // the store write, so neither is in the store index when the other is checked — a rule
    // that only queried the store would find no neighbour for either and wave the overlap
    // through. The batch itself must be visible to the rule (ctx.pending).
    const map = await cadastreMap({ plugins: [topologyPlugin()] })
    expect(map.store.collection('parcels').size).toBe(0)

    const failed: ValidationIssue[] = []
    map.events.on('validation:failed', (e) => failed.push(...e.payload.issues))

    const result = await map.commands.commit(
      new AddFeaturesCommand('parcels', [...overlappingParcels()]),
    )

    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
    // A vetoed write leaves nothing behind — not even the one parcel that was fine alone.
    expect(map.store.collection('parcels').size).toBe(0)
    // One physical overlap, reported once — not a mirror pair (A,B)+(B,A) from validating both.
    expect(failed.filter((i) => i.rule === RULE_IDS.overlap)).toHaveLength(1)
    await map.destroy()
  })

  it('detects a gap between two co-committed parcels as one warning, and still writes', async () => {
    // The fix must make the sibling *visible*, not make every co-commit fail: a 2 cm gap
    // between two batch-committed parcels is a warning (a digitisation artefact), so the write
    // still lands. Asserting the gap issue was actually raised — via ctx.pending, since neither
    // parcel is in the store index during validation — is what makes this discriminate the fix:
    // store-only, the sibling is invisible and no gap is found.
    const map = await cadastreMap({ plugins: [topologyPlugin()] })

    const warned: ValidationIssue[] = []
    map.events.on('validation:failed', (e) => warned.push(...e.payload.issues))

    const result = await map.commands.commit(
      new AddFeaturesCommand('parcels', [...gappedParcels(0.02)]),
    )

    expect(result.ok).toBe(true)
    expect(map.store.collection('parcels').size).toBe(2)
    const gaps = warned.filter((i) => i.rule === RULE_IDS.gap)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.data?.['neighbour']).toBeDefined()
    await map.destroy()
  })

  it('retires an overlapping neighbour when a co-committed update relocates it away', async () => {
    // A mis-digitised state: parcel-right was drawn overlapping parcel-left. One update fixes it
    // by moving parcel-right far away, and also carries parcel-left (unchanged) as a subject.
    // Validating parcel-left, the batch member's *new* geometry is far — but its stale stored
    // copy still overlaps, so it must be retired for the whole batch, not only for siblings that
    // stayed near the subject. Otherwise the valid correction is vetoed by a phantom overlap.
    const map = await cadastreMap() // no topology plugin, so the overlapping seed is allowed in
    const seeded = map.test.seed('parcels', [...overlappingParcels()])
    const left = seeded.find((f) => f.id === 'parcel-left')!
    const rightOld = seeded.find((f) => f.id === 'parcel-right')!

    // Register the overlap rule only now, after the intentionally-overlapping seed.
    map.validation.add(noOverlapWithNeighbours({ severity: 'error' }))

    const rightMovedFar: BlaeuFeature = {
      ...rightOld,
      geometry: { type: 'Polygon', coordinates: [ring(offsetMetres(ANKARA, 500, 0), 50, 40)] },
    }
    const result = await map.commands.commit(new UpdateFeaturesCommand([left, rightMovedFar]))

    expect(result.ok).toBe(true)
    await map.destroy()
  })
})

describe('noGapsWithNeighbours', () => {
  it('finds a 2 cm gap between neighbours, as a warning', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [...gappedParcels(0.02)] },
    })

    const issues = await map.plugin('topology').validate(['parcel-left'])
    const issue = bySeverity(issues, RULE_IDS.gap)

    // A gap is a digitisation artefact, not a dispute — hence `warning`, unlike overlap.
    expect(issue?.severity).toBe('warning')
    expect(issue?.data?.['neighbour']).toBe('parcel-right')
    // 0.02 m × 40 m = 0.8 m², comfortably inside the 1 m² artefact threshold.
    expect(issue?.data?.['gapArea'] as number).toBeGreaterThan(0.7)
    expect(issue?.data?.['gapArea'] as number).toBeLessThan(0.9)
    await map.destroy()
  })

  it('ignores a gap wide enough to be a road', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [...gappedParcels(0.5)] },
    })
    // 0.5 m × 40 m = 20 m². Nobody digitises 20 m² of nothing by accident: that is a
    // lane, and reporting it as a defect would be noise on every street in the layer.
    const issues = await map.plugin('topology').validate(['parcel-left'])
    expect(issues.filter((i) => i.rule === RULE_IDS.gap)).toEqual([])
    await map.destroy()
  })
})

describe('the structural rules', () => {
  it('closedRings rejects an unclosed ring', async () => {
    const map = await cadastreMap({})
    const rule = closedRings()
    const issues = await rule.check(
      rawFeature({
        id: 'open',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [32.85, 39.93],
              [32.851, 39.93],
              [32.851, 39.931],
            ],
          ],
        },
      }),
      validationContext(map),
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe(RULE_IDS.closedRings)
    expect(issues[0]?.severity).toBe('error')
    await map.destroy()
  })

  it('noDuplicateVertices measures the duplicate in metres, not degrees', async () => {
    const map = await cadastreMap({})
    const rule = noDuplicateVertices({ tolerance: 0.001 })

    // 0.4 mm apart — below the 1 mm grid, so the same corner. A degree-space equality
    // check would call these distinct and let them through.
    const a = ANKARA
    const b = offsetMetres(ANKARA, 0.0004, 0)
    const issues = await rule.check(
      rawFeature({
        id: 'dupe',
        geometry: {
          type: 'Polygon',
          coordinates: [[[a[0], a[1]], [b[0], b[1]], ...ring(ANKARA, 50, 40).slice(1)]],
        },
      }),
      validationContext(map),
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]?.data).toMatchObject({ count: 1 })
    await map.destroy()
  })
})

describe('minParcelArea', () => {
  it('measures the area in the projected working CRS', async () => {
    const map = await cadastreMap({
      features: { parcels: [parcelFixture('small', { widthMetres: 4, heightMetres: 4 })] },
    })

    const rule = minParcelArea({ minArea: 25 })
    const issues = await rule.check(map.store.find('small')!, validationContext(map))

    expect(issues).toHaveLength(1)
    // ~16 m². In square degrees it would be ~1e-9, and every parcel on earth would fail.
    expect(issues[0]?.data?.['area'] as number).toBeGreaterThan(15)
    expect(issues[0]?.data?.['area'] as number).toBeLessThan(17)
    await map.destroy()
  })
})

describe('noSlivers', () => {
  it('flags a 100 m × 0.5 m strip and spares a normal parcel', async () => {
    const map = await cadastreMap({
      features: {
        parcels: [
          parcelFixture('fat'),
          parcelFixture('strip', { widthMetres: 100, heightMetres: 0.5 }),
        ],
      },
    })

    const rule = noSlivers()
    const ctx = validationContext(map)

    expect(await rule.check(map.store.find('fat')!, ctx)).toEqual([])
    const issues = await rule.check(map.store.find('strip')!, ctx)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.data?.['ratio'] as number).toBeGreaterThan(100)
    await map.destroy()
  })
})

/* ------------------------------------------------------------------ *
 * The product decision
 * ------------------------------------------------------------------ */

describe('autoFix', () => {
  it('is off by default: validate() reports the bowtie and changes nothing', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [bowtieParcel('bowtie')] },
    })

    const before = map.store.snapshot()
    const issues = await map.plugin('topology').validate()

    expect(issues.some((i) => i.rule === RULE_IDS.selfIntersection)).toBe(true)
    expect(map.store.snapshot()).toEqual(before)
    await map.destroy()
  })

  it('repairs the bowtie when a human turned it on', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin({ autoFix: true })],
      features: { parcels: [bowtieParcel('bowtie')] },
    })

    const issues = await map.plugin('topology').validate()

    expect(issues.some((i) => i.rule === RULE_IDS.selfIntersection)).toBe(false)

    // The repaired parcel really is valid now — and it is a *different* parcel: buffer(0)
    // dropped a lobe, so the area on the deed changed. Which is exactly why this only
    // ever happens when a human asked for it.
    const repaired = map.store.find('bowtie')!
    expect(await noSelfIntersection().check(repaired, validationContext(map))).toEqual([])
    expect(map.crs.area(repaired.geometry)).toBeLessThan(450)
    await map.destroy()
  })

  it('refuses to fix an overlap — that is a decision, not a defect', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [...overlappingParcels()] },
    })

    const issues = await map.plugin('topology').validate(['parcel-left'])
    const overlap = bySeverity(issues, RULE_IDS.overlap)!
    const before = map.store.snapshot()

    expect(await map.plugin('topology').fix(overlap)).toBe(false)
    expect(map.store.snapshot()).toEqual(before)
    await map.destroy()
  })
})

/* ------------------------------------------------------------------ *
 * Events and i18n
 * ------------------------------------------------------------------ */

describe('reporting', () => {
  it('emits topology:issues and calls onIssues subscribers', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [bowtieParcel('bowtie')] },
    })

    const fromEvent: ValidationIssue[][] = []
    const fromHandler: ValidationIssue[][] = []
    map.events.on('topology:issues', (e) => fromEvent.push([...e.payload.issues]))
    map.plugin('topology').onIssues((issues) => fromHandler.push([...issues]))

    await map.plugin('topology').validate()

    expect(fromEvent).toHaveLength(1)
    expect(fromHandler).toHaveLength(1)
    expect(fromEvent[0]?.[0]?.rule).toBe(RULE_IDS.selfIntersection)
    await map.destroy()
  })

  it('speaks Turkish when the map does', async () => {
    const map = await cadastreMap({
      plugins: [topologyPlugin()],
      features: { parcels: [bowtieParcel('bowtie')] },
      config: { locale: 'tr' },
    })

    const issues = await map.plugin('topology').validate()
    expect(issues[0]?.message).toContain('kendisiyle kesişiyor')
    await map.destroy()
  })
})

/* ------------------------------------------------------------------ *
 * Composition: a preset's severities win
 * ------------------------------------------------------------------ */

describe('rule composition', () => {
  it('does not overwrite a rule a preset already registered', async () => {
    const map = await cadastreMap({})
    // Registered before the plugin is installed, exactly as a preset's rules are.
    map.validation.add(noOverlapWithNeighbours({ severity: 'warning' }))
    await map.use(topologyPlugin())

    const overlap = map.validation.list().find((rule) => rule.id === RULE_IDS.overlap)
    expect(overlap?.severity).toBe('warning')
    await map.destroy()
  })

  it('registers the rules it owns, and not minParcelArea', async () => {
    const map = await cadastreMap({ plugins: [topologyPlugin()] })
    const ids = map.validation.list().map((rule) => rule.id)

    expect(ids).toContain(RULE_IDS.selfIntersection)
    expect(ids).toContain(RULE_IDS.gap)
    // The minimum area is a legal number in a jurisdiction. The plugin does not know one.
    expect(ids).not.toContain(RULE_IDS.minArea)
    expect(noSelfIntersection().severity).toBe('error')
    await map.destroy()
  })
})
