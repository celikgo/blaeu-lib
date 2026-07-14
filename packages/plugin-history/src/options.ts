/** How many undo steps are kept before the oldest is dropped. */
export const DEFAULT_LIMIT = 100

/**
 * How long after a command another may still merge into it.
 *
 * 300 ms is a gesture, not a decision: it comfortably covers the gap between two
 * pointermoves in a drag, and comfortably fails to cover the gap between a user
 * finishing one edit and starting another.
 */
export const DEFAULT_COALESCE_WINDOW_MS = 300

export interface HistoryOptions {
  /** Maximum undo depth. Oldest entries are dropped from the bottom. Default 100. */
  readonly limit?: number

  /**
   * How long a command may still coalesce into the one before it. Default 300 ms.
   *
   * This is a *ceiling*, not a policy: a command that returns `null` from
   * `coalesceWith` is never merged no matter how fast it arrived, and a command
   * whose own coalesce rule is stricter (`SetPropertiesCommand` keeps its own
   * window) wins. Set to 0 to disable merging entirely.
   */
  readonly coalesceWindowMs?: number

  /** Bind Ctrl/Cmd+Z and Ctrl+Shift+Z / Ctrl+Y on the map container. Default true. */
  readonly keyboard?: boolean

  /**
   * Where to listen for the keyboard shortcuts.
   *
   * Defaults to the map's own container, which is deliberate: binding on `window`
   * means two maps on one page fight over Ctrl+Z, and the one that happened to be
   * constructed last wins. The core does not expose the container on
   * `PluginContext`, so we recover it from the renderer — and this option is the
   * escape hatch for a renderer we cannot recover it from, or for an app whose
   * keyboard focus legitimately lives somewhere else (a toolbar, a side panel).
   */
  readonly container?: HTMLElement
}

/** Every field present, so nothing downstream has to guard. */
export interface ResolvedHistoryOptions {
  readonly limit: number
  readonly coalesceWindowMs: number
  readonly keyboard: boolean
  readonly container: HTMLElement | undefined
}

export function resolveHistoryOptions(options: HistoryOptions): ResolvedHistoryOptions {
  const limit = options.limit ?? DEFAULT_LIMIT
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(
      `[fleximap] historyPlugin: limit must be a finite number >= 1, received ${String(options.limit)}. ` +
        `To disable undo entirely, do not install the history plugin.`,
    )
  }

  const coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS
  if (!Number.isFinite(coalesceWindowMs) || coalesceWindowMs < 0) {
    throw new Error(
      `[fleximap] historyPlugin: coalesceWindowMs must be a finite number >= 0, received ${String(
        options.coalesceWindowMs,
      )}. Use 0 to record every command as its own undo step.`,
    )
  }

  return {
    limit: Math.floor(limit),
    coalesceWindowMs,
    keyboard: options.keyboard ?? true,
    container: options.container,
  }
}
