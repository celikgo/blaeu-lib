import type {
  CollectionId,
  CrsCode,
  CrsService,
  Disposable,
  FeatureInput,
  FeatureStore,
  FlexiFeature,
  Locale,
  LngLat,
  Severity,
} from '@fleximap/core'

/**
 * A rectangle in **world units**: `[minX, minY, maxX, maxY]`.
 *
 * Deliberately *not* core's `Bbox`. That type is documented — and relied upon
 * everywhere else in the library — as `[west, south, east, north]` in EPSG:4326,
 * and the two are structurally identical, so reusing it here would let us hand a
 * pair of world coordinates to `map.renderer.fitBounds()` and get no complaint
 * from the compiler and a map somewhere off the coast of Ghana. A distinct name is
 * the only thing standing between those two meanings.
 *
 * Convert with {@link WorldTransform.boundsToLngLat}.
 */
export type WorldBbox = readonly [minX: number, minY: number, maxX: number, maxY: number]

/** A position in world units. The game's own plane — see {@link WorldTransform}. */
export type WorldXY = readonly [x: number, y: number]

/** Square tiles, or a pointy-top hex lattice. */
export type GridType = 'square' | 'hex'

/**
 * A kind of thing a level designer can place.
 *
 * This is the whole domain model of a game map, and it is four fields long — which
 * is the argument. A cadastre preset's domain model is `ada`/`parsel`/`malik`; a
 * game's is this. Neither one is known to the kernel.
 */
export interface EntityType {
  /** Stable key. Written to the `$entity` property and matched by the icon expression. */
  readonly id: string
  /** Shown in the toolbar and the entity picker. Localise via {@link GameOptions.locale} if you prefer. */
  readonly label: string
  /** A glyph (emoji works), or a sprite name if your renderer has a sprite sheet. */
  readonly icon: string
  /** Footprint, in **world units**. Drives the rendered radius, and is what a generator measures with. */
  readonly size?: number
  /** Which collection/layer it lands in. Defaults to {@link GameOptions.collection}. */
  readonly layer?: CollectionId
}

/**
 * The affine map between world units and the WGS84 plane the store insists on.
 *
 * Exact in both directions: `toWorld(toLngLat(p)) === p` up to float rounding, with
 * no trigonometry anywhere in the chain (see `world.ts` for why).
 */
export interface WorldTransform {
  /** World units per degree of longitude/latitude. The scale of the whole trick. */
  readonly unitsPerDegree: number
  toLngLat(xy: WorldXY): LngLat
  toWorld(lngLat: LngLat): WorldXY
  /** World bounds → a 4326 bbox, e.g. for `renderer.fitBounds()`. */
  boundsToLngLat(bounds: WorldBbox): readonly [number, number, number, number]
}

/** What `map.plugin('game-world')` returns. */
export interface WorldApi extends WorldTransform {
  readonly code: CrsCode
  readonly bounds: WorldBbox
  readonly gridSize: number
  readonly gridType: GridType
  /** Is this position inside the world? Placement and the bounds rule both ask. */
  contains(xy: WorldXY): boolean
  /** Nearest grid position — square cell corner, or hex centre. The snap providers use this. */
  snap(xy: WorldXY): WorldXY
}

/**
 * What a procedural generator is handed.
 *
 * Note `world`: a generator thinks in world units ("scatter three trees within 6
 * tiles"), never in degrees, and never has to know that the store is geographic.
 */
export interface GenerateContext {
  /** The entities being placed, already materialised (ids minted, properties stamped). */
  readonly placed: readonly FlexiFeature[]
  readonly store: FeatureStore
  readonly crs: CrsService
  readonly world: WorldApi
  /** Look up the {@link EntityType} an entity feature was placed from. */
  entityType(feature: FlexiFeature): EntityType | undefined
}

/**
 * Procedural generation, as a commit-middleware hook.
 *
 * Return extra features and they are committed **in the same command** as the
 * entity that triggered them — so one Ctrl+Z removes the building *and* the six
 * crates that appeared around it, which is the only behaviour a level designer will
 * accept.
 *
 * May be async: a generator that asks a server for a room layout is a perfectly
 * reasonable thing to write, and the commit pipeline is async precisely so it can
 * be. (The interaction pipeline is not — see core invariant 4.)
 */
export type EntityGenerator = (
  ctx: GenerateContext,
) => readonly FeatureInput[] | Promise<readonly FeatureInput[]>

/** What `map.plugin('game-entity')` returns. */
export interface EntityApi {
  readonly types: readonly EntityType[]
  /** The type the place tool will drop next. `null` until one is chosen. */
  readonly current: EntityType | null
  /** Throws on an unknown id — a typo here would otherwise silently place nothing. */
  setCurrent(id: string): void

  /**
   * Place an entity at a world position, exactly as a click would — same commit
   * pipeline, same generators, same validation, same single undo step.
   *
   * Async because the commit pipeline is (a generator may call a server). Resolves
   * to the features actually written, or an empty array if a validation rule vetoed
   * the placement.
   */
  place(xy: WorldXY, typeId?: string): Promise<readonly FlexiFeature[]>

  /**
   * Register a procedural generator. **Dispose it** — core invariant 5.
   *
   * ```ts
   * map.plugin('game-entity').onGenerate(({ placed, world }) =>
   *   placed.flatMap((building) => scatterAround(world, building, { icon: '🌲', count: 4, radius: 3 })),
   * )
   * ```
   */
  onGenerate(fn: EntityGenerator): Disposable
}

/**
 * Every knob a level designer would reach for.
 *
 * The test for whether something belongs here (preset rule 3): if you would have to
 * copy `preset.ts` into your project to change it, it should have been an option.
 */
export interface GameOptions {
  /** Tile size, in **world units — not metres**. Default 32. */
  readonly gridSize?: number
  /** Default `'square'`. `'hex'` swaps the drawn lattice *and* the snap provider. */
  readonly gridType?: GridType
  /** What can be placed. Default: a small starter set (see `DEFAULT_ENTITIES`). */
  readonly entities?: readonly EntityType[]
  /** The playable rectangle, in world units. Default `[-2048, -2048, 2048, 2048]`. */
  readonly bounds?: WorldBbox
  /** Default `'en'`. `'tr'` ships too. */
  readonly locale?: Locale

  /* --- placement --- */

  /** Where entities land unless their {@link EntityType.layer} says otherwise. Default `'entities'`. */
  readonly collection?: CollectionId
  /** Snap radius in **screen pixels**. Default 16 — a tile is a big target, so aim can be loose. */
  readonly snapTolerance?: number
  /** Undo depth. Default 50: a level editor's undo is shallow, and a deep one costs memory per step. */
  readonly historyLimit?: number
  /** Procedural generators, installed at construction. `onGenerate()` adds more at runtime. */
  readonly generators?: readonly EntityGenerator[]

  /* --- the world plane --- */

  /**
   * World units per degree of lng/lat. Default 100 000.
   *
   * You are unlikely to want to change this, but it is an option because it is the
   * one number that trades world *extent* against coordinate *precision*, and only
   * you know which your game needs. See the README, "How the CRS trick works".
   */
  readonly unitsPerDegree?: number
  /** The code the world plane registers under. Default `'GAME:WORLD'`. */
  readonly crsCode?: CrsCode
  /** Quantisation grid, in world units. Default 0.001 — a millitile, plenty for a decoration's jitter. */
  readonly precision?: number

  /* --- look --- */

  /** The whole basemap. A flat colour, because in a game the *world* is the map. Default `'#0f1216'`. */
  readonly backgroundColor?: string
  readonly gridColor?: string
  readonly gridOpacity?: number
  readonly gridLineWidth?: number
  /** Every Nth grid line is drawn heavier. Default 8. `0` disables major lines. */
  readonly majorEvery?: number
  /**
   * Refuses to build a grid with more lines (or hex cells) than this. Default 4096.
   *
   * A guard, not a preference: `bounds: [-1e6, -1e6, 1e6, 1e6]` with `gridSize: 1`
   * is four million line features, and the honest failure is an error naming both
   * numbers rather than a tab that stops responding.
   */
  readonly maxGridCells?: number

  /* --- rules --- */

  /** Placing outside {@link bounds}. Default `'error'` — off the map is off the map. */
  readonly boundsSeverity?: Severity
  /**
   * Two entities on one tile. Default `'warning'`: stacking a torch on a crate is
   * usually fine, and a tower-defence game that wants it fatal sets `'error'`.
   * `'off'` removes the rule entirely.
   */
  readonly occupancySeverity?: Severity | 'off'

  /* --- optional plugins --- */

  /** Mount the framework-free chrome (toolbar, readout, undo buttons). Default `true`. */
  readonly ui?: boolean
  readonly attributions?: readonly string[]
  /** Polygon drawing for terrain zones (water, forest, spawn area). Default `true`. */
  readonly zones?: boolean
  /** Where drawn zones land. Default `'zones'`. */
  readonly zoneCollection?: CollectionId
  /** Fill and outline colour for drawn zones. Default `'#38bdf8'`. */
  readonly zoneColor?: string
}

/** {@link GameOptions} with every default applied. What the plugins actually read. */
export interface ResolvedGameOptions {
  readonly gridSize: number
  readonly gridType: GridType
  readonly entities: readonly EntityType[]
  readonly bounds: WorldBbox
  readonly locale: Locale
  readonly collection: CollectionId
  readonly snapTolerance: number
  readonly historyLimit: number
  readonly generators: readonly EntityGenerator[]
  readonly unitsPerDegree: number
  readonly crsCode: CrsCode
  readonly precision: number
  readonly backgroundColor: string
  readonly gridColor: string
  readonly gridOpacity: number
  readonly gridLineWidth: number
  readonly majorEvery: number
  readonly maxGridCells: number
  readonly boundsSeverity: Severity
  readonly occupancySeverity: Severity | 'off'
  readonly ui: boolean
  readonly attributions: readonly string[]
  readonly zones: boolean
  readonly zoneCollection: CollectionId
  readonly zoneColor: string
}
