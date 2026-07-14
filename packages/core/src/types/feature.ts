import type { Geometry } from 'geojson'
import type { CollectionId, FeatureId, Json } from './common.js'

export type { Geometry, Point, LineString, Polygon, MultiPolygon, Position } from 'geojson'

/**
 * Free-form, JSON-serialisable attributes. Generic so a domain can pin them down:
 *
 * ```ts
 * interface ParcelProps { ada: string; parsel: string; yuzolcumu: number }
 * const parcel: FlexiFeature<ParcelProps> = ...   // properties are now typed
 * ```
 */
export type FeatureProperties = Record<string, Json | undefined>

/**
 * Bookkeeping FlexiMap maintains *about* a feature, kept separate from the
 * user's `properties`.
 *
 * The separation is the point. Merging our bookkeeping into `properties` would
 * mean a round-trip through GeoJSON silently ships our internals to the user's
 * server — and would collide the day a cadastral schema legitimately has a
 * field called `version`.
 */
export interface FeatureMeta {
  /** Collection the feature belongs to. Also selects the renderer source. */
  readonly collection: CollectionId
  /** Monotonic per-feature revision. Bumped by every command that touches it. */
  readonly version: number
  /** Epoch ms. */
  readonly createdAt: number
  /** Epoch ms. */
  readonly updatedAt: number
  /** Where it came from: user drawing, an import, a server sync, a generator… */
  readonly source?: string
  /** Locked features are rendered but cannot be selected, moved, or edited. */
  readonly locked?: boolean
  /** Hidden features stay in the store but are not sent to the renderer. */
  readonly hidden?: boolean
  /**
   * `false` marks a feature as **UI scaffolding**: drawn, but never a target.
   *
   * Vertex handles, a transform box, a snap indicator, a rubber band. They live in the
   * store because that is where the renderer reads from — but they are pictures *of* the
   * data, not data, and treating them as geometry produces some genuinely baffling bugs.
   * The one that prompted this: a vertex handle sits exactly on the vertex it represents,
   * so a snapping middleware helpfully snapped the pointer onto the handle of the very
   * vertex the user was dragging, and the vertex could never move.
   *
   * Snapping is only the first consumer. Anything that treats features as *content* —
   * measurement, selection, a nearest-feature query, an export — wants to skip these, and
   * the alternative is every such plugin growing its own hardcoded list of the collection
   * names other plugins happen to use for scaffolding. Defaults to `true` (snappable),
   * because ordinary data is the common case and must not have to opt in.
   */
  readonly snappable?: boolean
  /** Free slot for plugins to stash their own per-feature state, namespaced by plugin id. */
  readonly ext?: Readonly<Record<string, unknown>>
}

/**
 * The unified data model. Everything in FlexiMap — drawn, imported, generated —
 * is one of these.
 *
 * It is *GeoJSON-shaped but not GeoJSON*: `geometry` and `properties` are exactly
 * the RFC 7946 fields, so `toGeoJSON()` is a projection rather than a conversion,
 * but `meta` and a mandatory string `id` are ours. That gets us cheap
 * interop without pretending the wire format is a good in-memory model.
 *
 * `geometry` is **always** EPSG:4326 (core invariant 3).
 */
export interface FlexiFeature<P extends FeatureProperties = FeatureProperties> {
  readonly id: FeatureId
  readonly geometry: Geometry
  readonly properties: P
  readonly meta: FeatureMeta
}

/** A feature as accepted on input, where the store fills in whatever is missing. */
export interface FeatureInput<P extends FeatureProperties = FeatureProperties> {
  readonly id?: FeatureId
  readonly geometry: Geometry
  readonly properties?: P
  readonly meta?: Partial<FeatureMeta>
}

/**
 * Addresses one vertex inside a feature's geometry.
 *
 * Rings and multi-parts make "which vertex?" genuinely ambiguous, and the editing
 * and snapping engines pass this around constantly, so it gets a name.
 * - `part`: index into a Multi* geometry (always 0 for single geometries)
 * - `ring`: index into a Polygon's rings (0 = exterior, 1+ = holes; 0 for lines)
 * - `index`: index of the coordinate within that ring
 */
export interface VertexRef {
  readonly feature: FeatureId
  readonly part: number
  readonly ring: number
  readonly index: number
}

/** Addresses the segment between vertex `index` and `index + 1`. */
export interface EdgeRef {
  readonly feature: FeatureId
  readonly part: number
  readonly ring: number
  /** Index of the segment's *first* vertex. */
  readonly index: number
}
