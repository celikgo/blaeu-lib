import type { Disposable, InteractionContext, InteractionPipeline } from '@blaeu/core'
import type { PointerFeed, PointerSample } from './types.js'

/**
 * One interaction middleware, feeding every control that cares about the cursor.
 *
 * Two things are worth knowing here.
 *
 * **It reads the post-pipeline position.** Priority is far below the snap engine's
 * (100) and the grid lock's (90), so by the time this runs `ctx.lngLat` is the
 * position the vertex will actually be stored at. A readout that shows the raw
 * cursor while the tool stores a snapped point is not a cosmetic discrepancy — a
 * surveyor reads that number, writes it in a report, and it does not match the
 * parcel.
 *
 * **It reads `ctx.snap`, not a `snap:changed` event.** `InteractionContext.snap`
 * is the core's own contract ("set by the snapping middleware, read by UI
 * middleware that draws the indicator"), which means this works with *any* snap
 * engine that honours the contract — including one written by someone else to
 * replace ours. Listening for an event named `snap:changed` would have hardcoded
 * our snap plugin's name into the UI, which is precisely the coupling the plugin
 * architecture exists to avoid.
 */
export class InteractionPointerFeed implements PointerFeed {
  #current: PointerSample | undefined
  #handlers: ((sample: PointerSample) => void)[] = []

  get current(): PointerSample | undefined {
    return this.#current
  }

  on(handler: (sample: PointerSample) => void): Disposable {
    this.#handlers.push(handler)
    return {
      dispose: () => {
        const i = this.#handlers.indexOf(handler)
        if (i >= 0) this.#handlers.splice(i, 1)
      },
    }
  }

  /** Install the middleware. The returned disposable removes it — invariant 5. */
  install(interaction: InteractionPipeline): Disposable {
    return interaction.use(
      (ctx: InteractionContext, next: () => void) => {
        // Keydowns carry a stale pointer position; publishing them would make the
        // readout twitch every time the user presses Escape.
        if (ctx.kind !== 'keydown') this.#publish(ctx)
        next()
      },
      // Last. Everything that rewrites the position has already run.
      { id: 'ui:pointer-feed', priority: -1000 },
    )
  }

  #publish(ctx: InteractionContext): void {
    const candidate = ctx.snap?.candidate
    const sample: PointerSample = {
      lngLat: ctx.lngLat,
      screen: ctx.screen,
      snap:
        candidate === undefined
          ? undefined
          : { kind: String(candidate.kind), hint: candidate.hint },
    }
    this.#current = sample

    for (const handler of [...this.#handlers]) {
      try {
        handler(sample)
      } catch (err) {
        // This runs at pointer frequency. A throwing readout must not take the
        // snap indicator down with it, and must certainly not kill the pipeline —
        // the map would stop responding to the mouse.
        console.error('[blaeu/ui] a pointer handler threw:', err)
      }
    }
  }
}
