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
}
