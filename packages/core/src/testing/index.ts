/**
 * `@fleximap/core/testing` — the headless harness.
 *
 * A real kernel, a real store, real plugins, real pipelines; a fake renderer and a
 * fake container. Nothing here imports a test framework, because this is a
 * published entry point and a helper that drags Vitest into a consumer's dependency
 * graph is a helper nobody can use.
 */

export { createTestMap } from './createTestMap.js'
export type {
  TestMap,
  TestMapOptions,
  TestFacade,
  DragOptions,
  Modifiers,
} from './createTestMap.js'

export { FakeRenderer } from './FakeRenderer.js'
export type {
  FakeRendererOptions,
  FakeLayerRecord,
  FakePointerEventInit,
  FeatureResolver,
} from './FakeRenderer.js'

export {
  ANKARA,
  PARCEL_WIDTH_M,
  PARCEL_HEIGHT_M,
  parcelFixture,
  sharedEdgeParcels,
  sliverParcels,
  selfIntersectingRing,
  duplicateVertexRing,
  gridOfParcels,
  offsetMetres,
  metresPerDegreeLat,
  metresPerDegreeLng,
  distanceMetres,
} from './fixtures.js'
export type { ParcelOptions } from './fixtures.js'

export { expectWithinMetres, withinMetres } from './matchers.js'
