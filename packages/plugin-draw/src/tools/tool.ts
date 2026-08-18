import type { Tool } from '@blaeu/core'

/**
 * A draw tool is a {@link Tool} that can also be told to finish from *outside* the pointer
 * stream — from a toolbar button, a keyboard shortcut in the host app, or `DrawApi.finish()`.
 *
 * Without this, "finish" would only be expressible as a double-click, and a plugin-ui
 * toolbar would have to synthesise DOM events to complete a polygon. That is the kind of
 * indirection that works right up until someone uses a touch device.
 */
export interface DrawTool extends Tool {
  /** Completes the shape in progress. A no-op when there is nothing to complete. */
  finish(): void

  /**
   * Abandons the gesture in progress, discarding whatever the tool is holding.
   *
   * The counterpart to {@link finish}, and it exists for the same reason: cancelling has to be
   * expressible from outside the pointer stream. `DrawSession.cancel()` clears the session's
   * vertices and preview and emits `draw:cancel`, but a single-gesture tool also keeps an
   * **anchor in its own closure** — the rectangle's `origin`, the circle's `centre`, freehand's
   * `tracing` — and the session cannot reach it.
   *
   * So `DrawApi.cancel()` used to announce `draw:cancel`, leave the anchor set, and let the
   * pending `pointerup` commit the shape anyway: a feature written after the application was
   * told the drawing had been abandoned. Deactivating the tool did not have this problem
   * (`deactivate` clears the anchor), which is why `disable` was correct and `cancel` was not.
   *
   * Clears only what the tool owns. The caller still cancels the session — one owner per
   * concern, so neither can double-emit `draw:cancel`.
   *
   * A no-op for the multi-click tools (line, polygon, point), whose entire in-progress state
   * already lives in the session. That is worth implementing explicitly rather than making the
   * method optional: "there is nothing of mine to abandon" is a claim each tool should state.
   */
  abort(): void
}
