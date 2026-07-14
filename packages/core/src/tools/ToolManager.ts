import type { Disposable, FeatureId } from '../types/common.js'
import type { EventBus } from '../types/events.js'
import type { Tool, ToolManager } from '../types/extensions.js'

/**
 * Owns the one interactive mode that is active at a time.
 *
 * The manager is deliberately dumb: it does not know what a tool *does*, only
 * that exactly one of them may be listening at once. That single constraint is
 * what keeps a map from becoming modal soup — a draw tool and an edit tool both
 * live on `pointerdown`, and if both are active the user gets a vertex *and* a
 * drag, which reads as a bug in whichever one they were not thinking about.
 *
 * Ambient behaviour that should always run — hover highlighting, the snap
 * indicator — is *not* a tool. It is interaction middleware, and it composes with
 * every tool rather than competing with them.
 */
export class FlexiToolManager implements ToolManager {
  readonly #events: EventBus
  readonly #tools = new Map<string, Tool>()
  #active: string | null = null
  #dragging: readonly FeatureId[] = []

  constructor(events: EventBus) {
    this.#events = events
  }

  get dragging(): readonly FeatureId[] {
    return this.#dragging
  }

  setDragging(ids: readonly FeatureId[]): void {
    this.#dragging = [...ids]
  }

  /**
   * The registry key is `id`, not `tool.id` — `activate(id)` looks it up by the
   * key you registered under. A plugin may therefore register the same tool
   * implementation under an aliased id without the tool knowing.
   */
  register(id: string, tool: Tool): Disposable {
    const existing = this.#tools.get(id)
    if (existing) {
      throw new Error(
        `[fleximap] tool "${id}" is already registered. ` +
          `Two tools under one id means activate("${id}") silently picks one of them. ` +
          `Register under a distinct id, or dispose the first registration.`,
      )
    }
    this.#tools.set(id, tool)

    return {
      dispose: () => {
        // Only unregister the tool we actually put here — a re-registration under
        // the same id after this one was replaced must not be torn down by our
        // stale disposable.
        if (this.#tools.get(id) !== tool) return
        // An active tool that is unregistered without being deactivated keeps its
        // listeners and its half-drawn geometry alive, with nothing left to switch
        // it off. Deactivate first, always.
        if (this.#active === id) this.deactivate()
        this.#tools.delete(id)
      },
    }
  }

  activate(id: string): void {
    const tool = this.#tools.get(id)
    if (!tool) {
      throw new Error(
        `[fleximap] no tool registered as "${id}". Registered: [${this.list().join(', ')}]. ` +
          `Tools are registered by plugins — check that the plugin providing "${id}" is installed.`,
      )
    }

    // Re-activating the active tool is a no-op, *not* a deactivate/reactivate.
    // A user double-clicking the same toolbar button would otherwise lose the
    // polygon they are halfway through drawing.
    if (this.#active === id) return

    const previous = this.#active
    const { allowed } = this.#events.emitCancellable('before:tool:activate', { id, previous })
    // A veto is a decision, not an error: a permissions plugin refusing an edit
    // tool for a read-only user is behaving correctly. Leave the previous tool
    // exactly as it was.
    if (!allowed) return

    // Deactivate before activating. The previous tool must be given the chance to
    // clean up its half-finished geometry and drop its handles *before* the next
    // tool starts drawing — otherwise both are listening, both are drawing, and
    // the user's next click lands in two tools at once.
    this.deactivate()

    this.#active = id
    try {
      tool.activate()
    } catch (err) {
      // A tool that throws while activating is not active, whatever it thinks. If
      // we left `#active` set, every subsequent pointer event would be dispatched
      // into a half-constructed tool.
      this.#active = null
      throw new Error(
        `[fleximap] tool "${id}" threw during activate(): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }

    this.#events.emit('tool:activated', { id, previous })
  }

  deactivate(): void {
    const id = this.#active
    if (id === null) return
    const tool = this.#tools.get(id)

    // Cleared before `deactivate()` runs, so that a tool which dispatches a final
    // command from its own teardown does not see itself as still active.
    this.#active = null

    try {
      tool?.deactivate()
    } catch (err) {
      // A throwing teardown must not strand the manager with no active tool *and*
      // no way to activate the next one. Report and carry on.
      console.error(`[fleximap] tool "${id}" threw during deactivate():`, err)
    }

    this.#events.emit('tool:deactivated', { id })
  }

  get active(): string | null {
    return this.#active
  }

  /**
   * The live tool object, for dispatching pointer events into.
   *
   * `active` (the id) is the public, serialisable answer to "what mode am I in?";
   * this is the kernel's handle for actually delivering events, and is why
   * {@link FlexiMap} does not have to look the tool up on every pointer move.
   */
  get activeTool(): Tool | null {
    if (this.#active === null) return null
    return this.#tools.get(this.#active) ?? null
  }

  list(): readonly string[] {
    return [...this.#tools.keys()]
  }
}
