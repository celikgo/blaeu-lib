import type { CollectionId, Command, CommandContext, FeatureId, FlexiFeature } from '@fleximap/core'
import type { Geometry } from '@fleximap/core'

/**
 * The in-progress shape lives in its own collection, separate from the data.
 *
 * Two reasons. A preview is not data — a `select` tool, an export, a topology check must
 * never see the half-drawn ring. And it gives a preset one styling handle for "the thing
 * the user is currently dragging", which is a different colour from everything else in
 * every drawing product ever shipped.
 */
export const PREVIEW_COLLECTION: CollectionId = 'draw:preview'

/** Stable, so each preview update replaces the last rather than piling up. */
export const PREVIEW_ID: FeatureId = 'draw:preview:feature'

/** Set on the preview feature so a renderer/styling rule can filter it in one predicate. */
export const PREVIEW_PROPERTY = 'draw:preview'

/**
 * Replaces the preview geometry, or clears it when given `null`.
 *
 * **Transient**, and that is the whole point of the class. The rubber band is rewritten on
 * every pointer move; if those writes were recorded, Ctrl-Z mid-draw would step the user
 * back through their own cursor path one sample at a time instead of undoing the last real
 * action. `FlexiCommandBus` skips `onDidExecute` for transient commands, so the history
 * plugin never sees these.
 *
 * It is still a `Command` rather than a direct `store._add` because invariant 2 admits no
 * exceptions: the store is written through the bus, or it is not written. `undo` is
 * implemented honestly (it restores the previous preview) even though nothing will ever
 * call it — a command whose undo is a lie is a trap for whoever makes it non-transient.
 */
export class SetPreviewCommand implements Command<void> {
  readonly type = 'draw:set-preview'
  readonly label = 'Draw preview'
  readonly transient = true

  readonly #geometry: Geometry | null
  #previous: FlexiFeature | undefined

  constructor(geometry: Geometry | null) {
    this.#geometry = geometry
  }

  execute(ctx: CommandContext): void {
    const [removed] = ctx.store._remove([PREVIEW_ID])
    this.#previous = removed

    if (this.#geometry === null) return
    ctx.store._add(PREVIEW_COLLECTION, [
      {
        id: PREVIEW_ID,
        geometry: this.#geometry,
        properties: { [PREVIEW_PROPERTY]: true },
        meta: { source: 'draw' },
      },
    ])
  }

  undo(ctx: CommandContext): void {
    ctx.store._remove([PREVIEW_ID])
    if (this.#previous !== undefined) {
      ctx.store._add(PREVIEW_COLLECTION, [this.#previous])
    }
  }
}
