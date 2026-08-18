/**
 * A GeometryCollection must not be able to switch the topology rules off.
 *
 * `isPolygonal` was a bare `type === 'Polygon' || 'MultiPolygon'` test, and it is the
 * `appliesTo` for all seven rules, the stored-neighbour filter in `candidateNeighbours`, *and*
 * the co-committed batch filter in `batchInCollection`. So a parcel whose rings arrived wrapped
 * in a collection — which ArcGIS and DXF converters do — was invisible to every rule, and,
 * because the same predicate filters neighbours, invisible *as* a neighbour: it blinded the
 * honest Polygon beside it too.
 *
 * Core stores a collection deliberately (its normaliser recurses into members, `CrsService.area`
 * sums them), so the fix belongs here rather than in the kernel: `polygonalGeometry` flattens a
 * collection to its polygonal content at the one JSTS conversion boundary, which also keeps a
 * GeometryCollection out of JTS overlay ops — they raise IllegalArgumentException on one.
 *
 * These run in EPSG:5254 (TUREF/TM30) for the reason the rest of this suite does: a Web Mercator
 * area at 40°N is inflated by 1.70, which is useless for measuring an overlap.
 */
import { describe, expect, it } from 'vitest'
import { ANKARA, createTestMap, offsetMetres, type TestMap } from '@blaeu/core/testing'
import { AddFeaturesCommand } from '@blaeu/core'
import type { Geometry, Polygon, Position } from 'geojson'

import { RULE_IDS, topologyPlugin } from './index.js'

function topologyMap(): Promise<TestMap> {
  return createTestMap({
    config: { crs: { working: 'EPSG:5254' } },
    // The plugin's own default rule set — `topologyPlugin` takes no `rules` option, and the
    // default overlap rule is already an `error`, which is what makes a refused commit the
    // observable signal below.
    plugins: [topologyPlugin()],
  })
}

function rect(dx: number, dy: number, width: number, height: number): Polygon {
  const at = (x: number, y: number): Position => [...offsetMetres(ANKARA, dx + x, dy + y)]
  return {
    type: 'Polygon',
    coordinates: [[at(0, 0), at(width, 0), at(width, height), at(0, height), at(0, 0)]],
  }
}

const wrap = (...parts: Polygon[]): Geometry => ({
  type: 'GeometryCollection',
  geometries: parts,
})

/** A 50 × 40 parcel, and one overlapping it by 30 m × 40 m = 1 200 m². */
const BASE = rect(0, 0, 50, 40)
const OVERLAPPING = rect(20, 0, 50, 40)

const seed = (map: TestMap, id: string, geometry: Geometry) =>
  map.commands.commit(new AddFeaturesCommand('parcels', [{ id, geometry, properties: {} }]))

describe('the overlap rule sees through a GeometryCollection', () => {
  it('reports it when the SUBJECT is a collection', async () => {
    const map = await topologyMap()
    expect((await seed(map, 'A', BASE)).ok).toBe(true)

    const result = await seed(map, 'B', wrap(OVERLAPPING))
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
  })

  it('reports it when the NEIGHBOUR is a collection', async () => {
    const map = await topologyMap()
    expect((await seed(map, 'A', wrap(BASE))).ok).toBe(true)

    // The second half of the defect: a collection must remain visible *as a neighbour*, or it
    // silently exempts the ordinary parcel committed against it.
    const result = await seed(map, 'B', OVERLAPPING)
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
  })

  it('reports it when both are collections committed in one batch', async () => {
    const map = await topologyMap()
    const result = await map.commands.commit(
      new AddFeaturesCommand('parcels', [
        { id: 'A', geometry: wrap(BASE), properties: {} },
        { id: 'B', geometry: wrap(OVERLAPPING), properties: {} },
      ]),
    )
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
  })

  it('flattens every polygonal member, not just the first', async () => {
    const map = await topologyMap()
    // The collection's *second* member is the one that overlaps. A fix that read only
    // `geometries[0]` would pass the first two tests and fail this one.
    expect((await seed(map, 'A', wrap(rect(-200, 0, 10, 10), BASE))).ok).toBe(true)

    const result = await seed(map, 'B', OVERLAPPING)
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
  })

  it('ignores a collection’s non-areal members rather than choking on them', async () => {
    const map = await topologyMap()
    const withPoint: Geometry = {
      type: 'GeometryCollection',
      geometries: [BASE, { type: 'Point', coordinates: [...offsetMetres(ANKARA, 25, 20)] }],
    }
    expect((await seed(map, 'A', withPoint)).ok).toBe(true)

    const result = await seed(map, 'B', OVERLAPPING)
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
  })

  /**
   * The first fix was incomplete, and this is the case that exposed it.
   *
   * A collection's members routinely SHARE AN EDGE — two halves of one parcel is the ordinary
   * thing for a converter that emits pieces. Concatenating them into a MultiPolygon makes
   * something OGC-invalid ("Self-intersection" along the shared edge), so `prepare()` discarded
   * it at the `validityError` early-out and skipped the rule — re-opening the exact exemption
   * this work closed, by a different door. `prepare()` now dissolves the parts it concatenated
   * (`unaryUnion`), scoped to the collection case so a genuinely invalid *stored* MultiPolygon
   * is still the self-intersection rule's problem rather than being quietly repaired.
   */
  it('reports it when the collection’s members SHARE AN EDGE', async () => {
    const map = await topologyMap()
    // Two halves meeting at x = 25; together exactly BASE.
    expect((await seed(map, 'A', wrap(rect(0, 0, 25, 40), rect(25, 0, 25, 40)))).ok).toBe(true)

    const result = await seed(map, 'B', OVERLAPPING)
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
  })

  it('reports it when the collection’s members OVERLAP EACH OTHER', async () => {
    const map = await topologyMap()
    expect((await seed(map, 'A', wrap(rect(0, 0, 30, 40), rect(20, 0, 30, 40)))).ok).toBe(true)

    const result = await seed(map, 'B', OVERLAPPING)
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/overlap/i)
  })

  /**
   * The other half of the same regression: judged as one concatenated MultiPolygon, an
   * edge-sharing collection is "self-intersecting" — so the rule blocked a parcel whose
   * boundary crosses itself nowhere. A collection is now judged member by member.
   */
  it('does not call an edge-sharing collection self-intersecting', async () => {
    const map = await topologyMap()
    const result = await seed(map, 'A', wrap(rect(0, 0, 25, 40), rect(25, 0, 25, 40)))
    expect(result.ok).toBe(true)
    expect(map.store.find('A')).toBeDefined()
  })

  it('does not call a collection whose members NEST self-intersecting', async () => {
    const map = await topologyMap()
    // A parcel with an inner piece. As one concatenated MultiPolygon this is OGC "Nested
    // shells"; as a collection of two members it is ordinary, and neither member crosses itself.
    const result = await seed(map, 'A', wrap(rect(0, 0, 50, 40), rect(10, 10, 20, 20)))
    expect(result.ok).toBe(true)
    expect(map.store.find('A')).toBeDefined()
  })

  it('still catches a member that genuinely crosses itself', async () => {
    const map = await topologyMap()
    // A bowtie with unequal lobes, so its ring has real signed area and survives ingest.
    const bowtie: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [...offsetMetres(ANKARA, 0, 0)],
          [...offsetMetres(ANKARA, 50, 0)],
          [...offsetMetres(ANKARA, 0, 30)],
          [...offsetMetres(ANKARA, 20, 30)],
          [...offsetMetres(ANKARA, 0, 0)],
        ],
      ],
    }
    const result = await seed(map, 'A', wrap(bowtie))
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toMatch(/self-intersection|crosses itself/i)
  })

  it('stays quiet for two collections that merely share an edge', async () => {
    const map = await topologyMap()
    expect((await seed(map, 'A', wrap(rect(0, 0, 50, 40)))).ok).toBe(true)

    // Shared edge, no shared area. If this reported, every real cadastral neighbour pair would.
    const result = await seed(map, 'B', wrap(rect(50, 0, 50, 40)))
    expect(result.ok).toBe(true)
  })

  it('has nothing to say about a collection with no polygonal member at all', async () => {
    const map = await topologyMap()
    const pointsOnly: Geometry = {
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [...offsetMetres(ANKARA, 25, 20)] }],
    }
    expect((await seed(map, 'A', BASE)).ok).toBe(true)
    // No area, so no overlap — and, critically, no crash inside JTS either.
    expect((await seed(map, 'P', pointsOnly)).ok).toBe(true)
  })

  it('the reported issue names the overlap rule', async () => {
    const map = await topologyMap()
    await seed(map, 'A', wrap(BASE))
    const issues = await map.validation.run([
      { ...map.store.find('A')!, geometry: OVERLAPPING, id: 'B' },
    ])
    expect(issues.map((i) => i.rule)).toContain(RULE_IDS.overlap)
  })
})
