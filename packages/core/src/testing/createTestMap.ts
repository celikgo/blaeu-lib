import { FlexiMap } from '../FlexiMap.js'
// `FeatureId` lives in common.js — feature.ts imports it but does not re-export it.
import type { CollectionId, FeatureId, LngLat, ScreenPoint } from '../types/common.js'
import type { Command, CommandContext } from '../types/command.js'
import type { FeatureInput, FlexiFeature } from '../types/feature.js'
import type { FlexiMapConfig, FlexiMapOptions } from '../types/config.js'
import type { InteractionContext } from '../types/pipeline.js'
import type { PluginSpec } from '../types/plugin.js'
import type { Preset } from '../types/preset.js'
import type { Camera } from '../types/renderer.js'
import { FakeRenderer } from './FakeRenderer.js'
import { ANKARA } from './fixtures.js'

export interface TestMapOptions {
  readonly plugins?: readonly PluginSpec[]
  /** Seeded through the real command path, exactly as production data arrives. */
  readonly features?: Readonly<Record<CollectionId, readonly FeatureInput[]>>
  readonly camera?: Partial<Camera>
  readonly preset?: Preset
  readonly config?: FlexiMapConfig
  /** The fake viewport. 800×600 unless a test needs something else. */
  readonly viewport?: { readonly width: number; readonly height: number }
}

export interface DragOptions {
  /** Intermediate `pointermove`s between down and up. Default 10. */
  readonly steps?: number
  readonly button?: number
}

export type Modifiers = Partial<InteractionContext['modifiers']>

/**
 * Drives the map the way a user does: in geographic coordinates, through the
 * renderer, into the real interaction pipeline.
 *
 * Every position is converted to screen space with the `FakeRenderer`'s `project()`
 * before it is emitted, which is what makes pixel-denominated middleware — snapping
 * above all — behave exactly as it does in a browser. A harness that fed `lngLat`
 * straight to the tool would bypass the one part of the stack most worth testing.
 */
export interface TestFacade {
  readonly renderer: FakeRenderer

  project(lngLat: LngLat): ScreenPoint
  unproject(point: ScreenPoint): LngLat

  pointerMove(lngLat: LngLat, modifiers?: Modifiers): void
  pointerDown(lngLat: LngLat, modifiers?: Modifiers): void
  pointerUp(lngLat: LngLat, modifiers?: Modifiers): void
  click(lngLat: LngLat, modifiers?: Modifiers): void
  dblClick(lngLat: LngLat, modifiers?: Modifiers): void

  /** A keydown at the last pointer position. `map.test.key('Escape')`. */
  key(key: string, modifiers?: Modifiers): void

  /** pointerdown → N realistic intermediate pointermoves → pointerup. */
  drag(from: LngLat, to: LngLat, options?: DragOptions): void

  /** Move the fake camera, as a pan/zoom would. */
  camera(camera: Partial<Camera>, moving?: boolean): void

  /** Seed more features after construction. Same command path as the initial seed. */
  seed(collection: CollectionId, features: readonly FeatureInput[]): readonly FlexiFeature[]

  /** Let the async commit pipeline settle. Await this before asserting on validation. */
  flush(): Promise<void>
}

export interface TestMap extends FlexiMap {
  readonly test: TestFacade
}

/**
 * A real `FlexiMap` — real store, real command bus, real pipelines, real plugins —
 * wired to a `FakeRenderer` and a stub container.
 *
 * ```ts
 * const map = await createTestMap({
 *   plugins: [drawPlugin(), snapPlugin({ tolerance: 10 })],
 *   features: { parcels: sharedEdgeParcels() },
 *   camera: { center: ANKARA, zoom: 16 },
 * })
 * map.tools.activate('draw:polygon')
 * map.test.click([32.8501, 39.9301])
 * ```
 *
 * Nothing here is a mock except the renderer. That is the point: if a test passes
 * against this harness and fails in a browser, the renderer seam is leaking and the
 * bug is ours.
 */
export async function createTestMap(options: TestMapOptions = {}): Promise<TestMap> {
  const width = options.viewport?.width ?? 800
  const height = options.viewport?.height ?? 600

  // Zoom 16 puts a 50 m parcel at roughly 300 px across, which is the scale a
  // surveyor actually digitises at — and the scale at which a 12 px snap tolerance
  // is a sane number rather than a whole parcel.
  const camera: Camera = {
    center: options.camera?.center ?? options.config?.camera?.center ?? ANKARA,
    zoom: options.camera?.zoom ?? options.config?.camera?.zoom ?? 16,
    bearing: options.camera?.bearing ?? options.config?.camera?.bearing ?? 0,
    pitch: options.camera?.pitch ?? options.config?.camera?.pitch ?? 0,
  }

  const renderer = new FakeRenderer({ width, height, camera })

  const mapOptions: FlexiMapOptions = {
    ...(options.config ?? {}),
    container: createContainer(width, height),
    renderer,
    camera,
    ...(options.preset !== undefined ? { preset: options.preset } : {}),
    ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
  }

  const map = new FlexiMap(mapOptions)
  await map.whenReady()

  const facade = new TestFacadeImpl(map, renderer, camera.center)

  for (const [collection, features] of Object.entries(options.features ?? {})) {
    facade.seed(collection, features)
  }

  // `Object.assign` rather than a subclass: the harness must return the *real*
  // FlexiMap a plugin will see in production, with one extra property — not a
  // lookalike whose behaviour could drift from it.
  return Object.assign(map, { test: facade as TestFacade })
}

/* ========================================================================= */
/* The facade                                                                */
/* ========================================================================= */

class TestFacadeImpl implements TestFacade {
  #lastLngLat: LngLat

  constructor(
    readonly map: FlexiMap,
    readonly renderer: FakeRenderer,
    initialPosition: LngLat,
  ) {
    this.#lastLngLat = initialPosition
  }

  project(lngLat: LngLat): ScreenPoint {
    return this.renderer.project(lngLat)
  }

  unproject(point: ScreenPoint): LngLat {
    return this.renderer.unproject(point)
  }

  pointerMove(lngLat: LngLat, modifiers?: Modifiers): void {
    this.#pointer('pointermove', lngLat, modifiers)
  }

  pointerDown(lngLat: LngLat, modifiers?: Modifiers): void {
    this.#pointer('pointerdown', lngLat, modifiers)
  }

  pointerUp(lngLat: LngLat, modifiers?: Modifiers): void {
    this.#pointer('pointerup', lngLat, modifiers)
  }

  /**
   * One `click`, and only a click.
   *
   * A browser also fires pointerdown and pointerup around it, but making `click()`
   * emit all three would double-fire any tool that handles both — and a test that
   * genuinely wants the full sequence can write it: `pointerDown(p); pointerUp(p);
   * click(p)`. A primitive that quietly does three things is a primitive you cannot
   * reason about.
   */
  click(lngLat: LngLat, modifiers?: Modifiers): void {
    this.#pointer('click', lngLat, modifiers)
  }

  dblClick(lngLat: LngLat, modifiers?: Modifiers): void {
    this.#pointer('dblclick', lngLat, modifiers)
  }

  drag(from: LngLat, to: LngLat, options: DragOptions = {}): void {
    const steps = Math.max(options.steps ?? 10, 1)
    const button = options.button ?? 0

    this.#pointer('pointerdown', from, undefined, button)

    // Interpolate in *screen* space, not in degrees: a mouse travels a straight line
    // in pixels, and the difference matters to any middleware measuring pixel
    // distance — which is all of the interesting ones.
    const a = this.renderer.project(from)
    const b = this.renderer.project(to)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const point: ScreenPoint = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      // The last step lands on `to` exactly, rather than on unproject(project(to)),
      // so a drag ends where the test said it ends.
      const lngLat = i === steps ? to : this.renderer.unproject(point)
      this.#pointer('pointermove', lngLat, undefined, button)
    }

    this.#pointer('pointerup', to, undefined, button)
  }

  /**
   * A keydown, delivered where the kernel would deliver one.
   *
   * The `Renderer` contract has no keyboard channel — `RendererPointerEvent` has no
   * `keydown` kind — yet `InteractionContext` has both a `'keydown'` kind and a
   * `key` field, and every tool has an `onKeyDown`. So the harness builds the
   * context itself and walks it through the *real* interaction pipeline before
   * handing it to the *real* active tool. That keeps "press Escape to cancel the
   * ring" testable today; when the renderer grows an `onKey`, this method becomes a
   * one-line call into it and no test changes.
   */
  key(key: string, modifiers?: Modifiers): void {
    const ctx = this.#keyContext(key, modifiers)
    this.map.interaction.run(ctx)
    if (ctx.consumed) return
    this.map.tools.activeTool?.onKeyDown?.(ctx)
  }

  camera(camera: Partial<Camera>, moving = false): void {
    this.renderer.emitCamera(camera, moving)
  }

  seed(collection: CollectionId, features: readonly FeatureInput[]): readonly FlexiFeature[] {
    if (features.length === 0) return []

    if (!this.map.store.collections().includes(collection)) {
      this.map.store.createCollection(collection)
    }

    const result = this.map.commands.dispatch(new SeedFeaturesCommand(collection, features))
    if (!result.ok) {
      throw new Error(
        `[fleximap] seeding collection "${collection}" was rejected: ${result.rejectedReason}. ` +
          `A validation rule or a before:command:execute hook vetoed the fixture — either the fixture is genuinely ` +
          `invalid (some of them are, deliberately), or the rule is too strict.`,
      )
    }
    return result.value ?? []
  }

  flush(): Promise<void> {
    // A macrotask, not a microtask: commit middleware that awaits a fake network call
    // resolves on a timer, and a `await Promise.resolve()` would return before it.
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  #pointer(
    kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'click' | 'dblclick',
    lngLat: LngLat,
    modifiers?: Modifiers,
    button = 0,
  ): void {
    this.#lastLngLat = lngLat
    this.renderer.emitPointer({
      kind,
      lngLat,
      button,
      ...(modifiers !== undefined ? { modifiers } : {}),
    })
  }

  #keyContext(key: string, modifiers?: Modifiers): InteractionContext {
    const map = this.map
    const renderer = this.renderer
    const rawLngLat = this.#lastLngLat
    const screen = renderer.project(rawLngLat)
    let lngLat = rawLngLat
    let consumed = false

    return {
      kind: 'keydown',
      get lngLat() {
        return lngLat
      },
      set lngLat(value) {
        lngLat = value
      },
      // Derived, exactly as the kernel derives it — a cached `xy` that a middleware
      // forgot to update puts a vertex a metre from where the user meant it.
      get xy() {
        return map.crs.working.forward(lngLat)
      },
      screen,
      rawLngLat,
      snap: undefined,
      // The kernel populates this from the active tool; a synthetic keydown carries
      // whatever the tool currently has hold of, exactly as a real one would.
      dragging: this.map.tools.dragging,
      key,
      button: -1,
      modifiers: {
        shift: modifiers?.shift ?? false,
        ctrl: modifiers?.ctrl ?? false,
        alt: modifiers?.alt ?? false,
        meta: modifiers?.meta ?? false,
      },
      hits: () => renderer.queryAt(screen),
      consume: () => {
        consumed = true
      },
      get consumed() {
        return consumed
      },
      originalEvent: syntheticKeyEvent(key),
    }
  }
}

/* ========================================================================= */
/* Seeding                                                                   */
/* ========================================================================= */

/**
 * Puts fixture data into the store the way production data gets there: through the
 * command bus, through `before:command:execute` (so a validation plugin still gets
 * its veto), and through the store's ingest path (so the coordinates are quantised
 * to the working CRS's precision grid, the rings are closed, and the winding is
 * normalised — exactly as they would be for a real import).
 *
 * **Transient on purpose.** If seeding were recorded, a test with the history plugin
 * installed would find that its very first Ctrl-Z undid the fixture rather than the
 * action under test — and would then "fix" the plugin until that stopped happening.
 * Fixture setup is not a user action.
 */
class SeedFeaturesCommand implements Command<readonly FlexiFeature[]> {
  readonly type = 'testing:seed-features'
  readonly label = 'Seed test features'
  readonly transient = true

  readonly #collection: CollectionId
  readonly #features: readonly FeatureInput[]
  #added: readonly FeatureId[] = []

  constructor(collection: CollectionId, features: readonly FeatureInput[]) {
    this.#collection = collection
    this.#features = features
  }

  execute(ctx: CommandContext): readonly FlexiFeature[] {
    const added = ctx.store._add(this.#collection, this.#features)
    this.#added = added.map((f) => f.id)
    return added
  }

  undo(ctx: CommandContext): void {
    ctx.store._remove(this.#added)
  }
}

/* ========================================================================= */
/* The container                                                             */
/* ========================================================================= */

/**
 * Vitest runs this workspace in the **node** environment, where there is no
 * `document` — that is deliberate, because 95% of FlexiMap has no business needing
 * one, and the day a plugin quietly starts reaching for `document.body` we want the
 * test suite to say so rather than to shrug.
 *
 * So: a detached element when a DOM exists (jsdom, browser mode), and a structural
 * stand-in when it does not. The stand-in answers the handful of things a renderer
 * and a theme manager legitimately ask a container — size, style, class list,
 * children — and nothing else.
 */
function createContainer(width: number, height: number): HTMLElement {
  if (typeof document !== 'undefined') {
    const element = document.createElement('div')
    element.style.width = `${width}px`
    element.style.height = `${height}px`
    return element
  }
  return createStubElement(width, height)
}

function createStubElement(width = 0, height = 0): HTMLElement {
  const children: unknown[] = []
  const attributes = new Map<string, string>()
  const classes = new Set<string>()

  const style: Record<string, unknown> = {
    setProperty: (name: string, value: string) => {
      style[name] = value
    },
    removeProperty: (name: string) => {
      delete style[name]
    },
    getPropertyValue: (name: string) => String(style[name] ?? ''),
  }

  const element = {
    tagName: 'DIV',
    style,
    clientWidth: width,
    clientHeight: height,
    offsetWidth: width,
    offsetHeight: height,
    children,
    classList: {
      add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      contains: (name: string) => classes.has(name),
      toggle: (name: string) => (classes.has(name) ? classes.delete(name) : classes.add(name)),
    },
    appendChild: <T>(child: T): T => {
      children.push(child)
      return child
    },
    removeChild: <T>(child: T): T => {
      const i = children.indexOf(child)
      if (i >= 0) children.splice(i, 1)
      return child
    },
    insertBefore: <T>(child: T): T => {
      children.unshift(child)
      return child
    },
    contains: (child: unknown) => children.includes(child),
    remove: () => {},
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => attributes.delete(name),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
    // A theme manager that injects a <style> element needs somewhere to create it.
    ownerDocument: {
      createElement: () => createStubElement(),
      head: { appendChild: <T>(child: T): T => child, removeChild: <T>(child: T): T => child },
    },
  }

  return element as unknown as HTMLElement
}

function syntheticKeyEvent(key: string): Event {
  if (typeof Event === 'function') {
    const event = new Event('keydown')
    // The kernel reads `ctx.key`, not the DOM event — but a tool reaching for the
    // original event should still find the key on it rather than `undefined`.
    Object.defineProperty(event, 'key', { value: key, enumerable: true })
    return event
  }
  return {
    type: 'keydown',
    key,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as Event
}
