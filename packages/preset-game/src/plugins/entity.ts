import {
  AddFeaturesCommand,
  type CommitMiddleware,
  type Disposable,
  type FlexiFeature,
  type FlexiPlugin,
  type LngLat,
  type PluginContext,
  type Tool,
} from '@fleximap/core'

import { entityCollections, resolveGameOptions } from '../options.js'
import { en, tr } from '../messages.js'
import { ENTITY_PROPERTY, GENERATED_PROPERTY } from '../styles.js'
import type {
  EntityApi,
  EntityGenerator,
  EntityType,
  GameOptions,
  GenerateContext,
  ResolvedGameOptions,
  WorldApi,
  WorldXY,
} from '../types.js'

/** The tool id. `map.tools.activate(PLACE_TOOL)`. */
export const PLACE_TOOL = 'entity:place'

/** Where the generator middleware sits: **above** validation (-100), so its output is validated too. */
const GENERATE_PRIORITY = 0

/**
 * Entity placement, and the procedural-generation seam.
 *
 * Two things worth reading this file for:
 *
 * **1. The place tool is fifteen lines, and it does not snap.** It reads
 * `ctx.lngLat`, which the snap middleware rewrote to the exact centre of a tile
 * before any tool saw the event. The tool has never heard of the grid — which is
 * why swapping `gridType: 'hex'` changes where entities land without changing a
 * line of it.
 *
 * **2. Generators run in the commit pipeline, and they are not validation.** The
 * commit pipeline was built so a land registry could ask a server whether a parcel
 * overlaps a neighbour's. The same seam, here, auto-scatters four crates around a
 * placed building — asynchronously, if the generator wants to ask a server for a
 * room layout — and the generated features land in the *same command* as the entity
 * that triggered them, so one Ctrl+Z removes all of it. Nothing in the pipeline's
 * design anticipated either use, and that is the whole claim of this package.
 */
export function entityPlugin(options: GameOptions = {}): FlexiPlugin<EntityApi, GameOptions> {
  return {
    id: 'game-entity',
    version: '1.0.0',

    dependencies: [
      // Hard: an entity is placed at a world coordinate, and only the world plugin
      // knows what one is.
      { id: 'game-world' },
      // Optional, both of them. Without `snap`, entities land exactly where the
      // pointer was — the editor still works, it is simply less forgiving. Without
      // `history`, placements still commit; nothing records them, which is what a
      // read-only level *viewer* wants. Both are covered by the degradation test.
      { id: 'snap', optional: true },
      { id: 'history', optional: true },
      { id: 'ui', optional: true },
    ],

    setup(ctx: PluginContext<GameOptions>): EntityApi {
      const resolved = resolveGameOptions({ ...options, ...(ctx.options ?? {}) })
      const world = ctx.plugin('game-world')

      ctx.disposables.add(ctx.i18n.register('en', en))
      ctx.disposables.add(ctx.i18n.register('tr', tr))

      // Declared up front, not on first placement: the renderer creates one source per
      // collection, and a source that appears halfway through a session appears *above*
      // the grid layer, which is where entities must not be. Deliberately **not**
      // removed on teardown — unlike the draw plugin's preview, these hold the level.
      for (const collection of entityCollections(resolved)) {
        ctx.store.createCollection(collection)
      }

      const session = new EntitySession(ctx, resolved, world)
      ctx.disposables.addFn(() => session.dispose())

      ctx.disposables.add(
        ctx.commit.use(session.generateMiddleware, {
          id: 'game:generate',
          priority: GENERATE_PRIORITY,
        }),
      )

      ctx.disposables.add(ctx.tools.register(PLACE_TOOL, createPlaceTool(ctx, session)))

      for (const generator of resolved.generators) {
        ctx.disposables.add(session.onGenerate(generator))
      }

      // The toolbar is a nicety, and its absence must be survivable: a game embedding
      // FlexiMap in its own React chrome installs no UI plugin and drives placement
      // through `api.setCurrent()`.
      const ui = ctx.tryPlugin('ui')
      if (ui) {
        for (const [index, entity] of resolved.entities.entries()) {
          ctx.disposables.add(
            ui.toolbar.addButton({
              id: `entity:${entity.id}`,
              label: entity.label,
              icon: entity.icon,
              order: index,
              onClick: () => {
                session.setCurrent(entity.id)
                ctx.tools.activate(PLACE_TOOL)
              },
            }),
          )
        }
      }

      return session.api
    },

    /** Dormant, not gone: the chosen entity type survives a toggle, as a tool palette should. */
    disable(ctx): void {
      if (ctx.tools.active === PLACE_TOOL) ctx.tools.deactivate()
    },
  }
}

/* ========================================================================= */
/* The tool                                                                  */
/* ========================================================================= */

function createPlaceTool(ctx: PluginContext<GameOptions>, session: EntitySession): Tool {
  return {
    id: PLACE_TOOL,
    cursor: 'crosshair',

    activate(): void {
      session.announce()
    },

    deactivate(): void {
      ctx.tryPlugin('ui')?.status.clear('game')
    },

    onClick(interaction): boolean {
      // `interaction.lngLat` has already been through the snap middleware, so it is
      // the centre of a tile — or the raw pointer, if no snap plugin is installed.
      // Either way the tool does not know, and does not need to.
      session.placeAt(interaction.lngLat)
      return true
    },

    onKeyDown(interaction): boolean | void {
      if (interaction.key !== 'Escape') return
      ctx.tools.deactivate()
      return true
    },
  }
}

/* ========================================================================= */
/* The session                                                               */
/* ========================================================================= */

class EntitySession {
  readonly #ctx: PluginContext<GameOptions>
  readonly #options: ResolvedGameOptions
  readonly #world: WorldApi
  readonly #generators: EntityGenerator[] = []
  #current: EntityType | null
  #disposed = false

  constructor(ctx: PluginContext<GameOptions>, options: ResolvedGameOptions, world: WorldApi) {
    this.#ctx = ctx
    this.#options = options
    this.#world = world
    // The first type, so a freshly-constructed editor can place something without a
    // call nobody would think to make.
    this.#current = options.entities[0] ?? null
  }

  get api(): EntityApi {
    // An arrow, not a `const self = this`: inside the object literal below, `this` is
    // the literal rather than the session, and capturing the *accessor* keeps the API
    // live (a `setCurrent` from the toolbar must be visible through `api.current`)
    // without aliasing `this`.
    const current = (): EntityType | null => this.#current

    return {
      types: this.#options.entities,
      get current() {
        return current()
      },
      setCurrent: (id: string) => this.setCurrent(id),
      place: (xy: WorldXY, typeId?: string) => this.place(xy, typeId),
      onGenerate: (fn: EntityGenerator) => this.onGenerate(fn),
    }
  }

  setCurrent(id: string): void {
    const entity = this.#options.entities.find((candidate) => candidate.id === id)
    if (!entity) {
      throw new Error(
        `[preset-game] unknown entity type "${id}". Declared types: ` +
          `[${this.#options.entities.map((e) => e.id).join(', ')}]. ` +
          `Add it to gameMapPreset({ entities: [...] }) — the type list drives the icon expression too, ` +
          `so an entity placed without one would render as "?".`,
      )
    }
    this.#current = entity
    this.announce()
  }

  onGenerate(fn: EntityGenerator): Disposable {
    this.#generators.push(fn)
    return {
      dispose: () => {
        const at = this.#generators.indexOf(fn)
        if (at >= 0) this.#generators.splice(at, 1)
      },
    }
  }

  /** Fire-and-forget placement, for the tool's synchronous click handler. */
  placeAt(lngLat: LngLat): void {
    void this.place(this.#world.toWorld(lngLat)).catch((err: unknown) => {
      // A rejected placement resolves; only a *thrown* generator lands here, and it
      // has no caller to catch it — the click handler returned long ago.
      this.#ctx.events.emit('map:error', {
        error: err instanceof Error ? err : new Error(String(err)),
        source: 'game-entity:place',
      })
    })
  }

  async place(xy: WorldXY, typeId?: string): Promise<readonly FlexiFeature[]> {
    if (this.#disposed) return []

    const entity = typeId === undefined ? this.#current : this.#find(typeId)
    if (!entity) {
      this.#ctx.log.warn(
        'no entity type is selected, so the click placed nothing. ' +
          'Call map.plugin("game-entity").setCurrent(id) first.',
      )
      return []
    }

    // Snapped again, here, on purpose. `placeAt` comes in pre-snapped from the
    // interaction pipeline — but `place()` is also the *programmatic* entry point,
    // called by a level importer or a test with an arbitrary coordinate, and an
    // entity that is on the grid when clicked but off it when imported is the kind of
    // inconsistency that shows up as a one-pixel seam in a shipped game.
    const at = this.#world.snap(xy)
    const label = this.#ctx.i18n.t('game.tool.place', { entity: entity.label })

    // One commit. The generators run *inside* it, as middleware, so the building and
    // the crates it spawned are validated together, land together, and undo together.
    //
    // This used to hand-roll its own `CommitContext` and call `ctx.commit.run()`
    // directly, because at the time the kernel never ran the commit pipeline on the
    // write path at all and this was the only way to make generators fire. That hole
    // is closed: `commands.commit()` runs the chain, and the features the generators
    // appended come back through `AddFeaturesCommand.adopt()` — each one routed to the
    // collection its own `meta` names.
    const result = await this.#ctx.commands.commit(
      new AddFeaturesCommand(
        entity.layer ?? this.#options.collection,
        [
          {
            geometry: { type: 'Point', coordinates: [...this.#world.toLngLat(at)] },
            properties: { [ENTITY_PROPERTY]: entity.id, label: entity.label },
            meta: { source: PLACE_TOOL },
          },
        ],
        { label },
      ),
    )

    if (!result.ok) {
      this.#ctx.events.emit('entity:rejected', {
        type: entity.id,
        reason: result.rejectedReason ?? 'rejected',
      })
      return []
    }

    const written = result.value ?? []
    this.#ctx.events.emit('entity:placed', { type: entity.id, features: written })
    return written
  }

  /**
   * The generator seam, as commit middleware.
   *
   * It runs on `add` only, and only for features that are entities and are not
   * themselves generated — otherwise a generator that scatters trees would see its
   * own trees on the next pass and scatter trees around those, which is a forest and
   * then a hang.
   */
  readonly generateMiddleware: CommitMiddleware = async (commit, next) => {
    if (commit.operation !== 'add' || this.#generators.length === 0) return next()

    const placed = commit.features.filter(
      (feature) =>
        feature.properties[ENTITY_PROPERTY] !== undefined &&
        feature.properties[GENERATED_PROPERTY] !== true,
    )
    if (placed.length === 0) return next()

    const context: GenerateContext = {
      placed,
      store: this.#ctx.store,
      crs: this.#ctx.crs,
      world: this.#world,
      entityType: (feature) => {
        const id = feature.properties[ENTITY_PROPERTY]
        return typeof id === 'string' ? this.#find(id) : undefined
      },
    }

    for (const generator of this.#generators) {
      const produced = await generator(context)
      for (const input of produced) {
        // Through the store's own `materialise`, not a local imitation of it. The
        // difference is not cosmetic: `materialise` normalises the ring winding and
        // snaps coordinates to the working CRS's grid, so a scattered tree lands on
        // the tile grid exactly as a hand-placed one does. Minting the id here (rather
        // than letting the store do it later) is what lets the generator's feature be
        // the *same* feature that validation judges and that `entity:placed` reports.
        commit.features.push(
          ...this.#ctx.store.materialise(input.meta?.collection ?? this.#options.collection, [
            {
              ...input,
              properties: { ...input.properties, [GENERATED_PROPERTY]: true },
              meta: { ...input.meta, source: 'game:generate' },
            },
          ]),
        )
      }
    }

    // Validation sits below us (priority -100), so everything a generator produced is
    // validated too — a generator that scatters a tree outside the world bounds is
    // caught by the same rule that catches a designer who clicks there.
    await next()
  }

  announce(): void {
    const ui = this.#ctx.tryPlugin('ui')
    if (!ui) return
    ui.status.set(
      'game',
      this.#current
        ? this.#ctx.i18n.t('game.tool.place.hint', { entity: this.#current.label })
        : this.#ctx.i18n.t('game.entity.none'),
    )
  }

  dispose(): void {
    this.#disposed = true
    this.#generators.length = 0
  }

  #find(id: string): EntityType | undefined {
    return this.#options.entities.find((entity) => entity.id === id)
  }
}

declare module '@fleximap/core' {
  interface FlexiPluginRegistry {
    'game-entity': EntityApi
  }

  interface FlexiEventMap {
    /** An entity — and everything a generator spawned alongside it — reached the store. */
    'entity:placed': { readonly type: string; readonly features: readonly FlexiFeature[] }
    /** A validation rule or a commit middleware vetoed the placement. Nothing was written. */
    'entity:rejected': { readonly type: string; readonly reason: string }
  }
}
