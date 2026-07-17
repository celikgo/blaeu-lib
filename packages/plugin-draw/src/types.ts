import type { CollectionId, FeatureProperties, LngLat } from '@blaeu/core'

/** The shapes this plugin knows how to draw. One tool each, one file each. */
export type DrawMode = 'point' | 'line' | 'polygon' | 'rectangle' | 'circle' | 'freehand'

/** Every mode, in toolbar order. Also what `drawPlugin` iterates when registering tools. */
export const DRAW_MODES: readonly DrawMode[] = [
  'point',
  'line',
  'polygon',
  'rectangle',
  'circle',
  'freehand',
]

export interface DrawOptions {
  /** Where completed shapes land. Default `'default'`. */
  readonly collection?: CollectionId
  /** Activated as soon as the plugin is installed. Omit to start with no tool active. */
  readonly defaultMode?: DrawMode
  /**
   * Douglas-Peucker tolerance for freehand traces, in **metres in the working CRS**.
   * Default 1 m. Zero keeps every captured point — which is almost never what you want.
   */
  readonly freehandTolerance?: number
  /** Vertices used to approximate a circle as a polygon. Default 64. */
  readonly circleSegments?: number
  /**
   * Properties stamped onto every shape this plugin creates. Called once per shape, so
   * a counter or a timestamp does the right thing.
   */
  readonly properties?: () => FeatureProperties
}

/** {@link DrawOptions} with the defaults filled in. What the session and the tools read. */
export interface ResolvedDrawOptions {
  readonly collection: CollectionId
  readonly defaultMode: DrawMode | null
  readonly freehandTolerance: number
  readonly circleSegments: number
  readonly properties: () => FeatureProperties
}

export interface DrawApi {
  /** Activates the tool for `mode`. Equivalent to `map.tools.activate('draw:' + mode)`. */
  start(mode: DrawMode): void
  /** Discards the shape in progress. The tool stays active, ready for the next one. */
  cancel(): void
  /** Completes the shape in progress, as a double-click would. */
  finish(): void
  readonly active: DrawMode | null
  /** The vertices committed so far in the current shape. Empty when nothing is in progress. */
  readonly vertices: readonly LngLat[]
  /** Retargets where *subsequent* shapes land. */
  setCollection(id: CollectionId): void
}

export const DEFAULT_COLLECTION: CollectionId = 'default'
export const DEFAULT_FREEHAND_TOLERANCE_METRES = 1
export const DEFAULT_CIRCLE_SEGMENTS = 64

export function resolveOptions(options: DrawOptions): ResolvedDrawOptions {
  return {
    collection: options.collection ?? DEFAULT_COLLECTION,
    defaultMode: options.defaultMode ?? null,
    freehandTolerance: options.freehandTolerance ?? DEFAULT_FREEHAND_TOLERANCE_METRES,
    circleSegments: options.circleSegments ?? DEFAULT_CIRCLE_SEGMENTS,
    properties: options.properties ?? (() => ({})),
  }
}
