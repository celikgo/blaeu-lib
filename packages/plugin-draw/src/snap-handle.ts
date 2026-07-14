import type { FeatureId, LngLat, PluginContext } from '@fleximap/core'

/**
 * The only thing the draw plugin ever says to the snap engine.
 *
 * Note what is *not* here: no `snap(point)`, no `query()`, nothing that returns a
 * position. The tools never ask the snap engine where the pointer should go — by the
 * time a tool reads `ctx.lngLat`, the snap middleware has already rewritten it. All
 * the draw plugin contributes is context the engine cannot work out for itself:
 *
 * - `setInProgress` — the vertices of the ring being drawn, so the user can close it
 *   by snapping to its first vertex. The engine cannot know about them; they are not
 *   in the store yet.
 * - `exclude` — the preview feature, so the rubber band cannot snap to itself.
 *
 * The names are not invented here: they are `SnapApi.setInProgress` and `SnapApi.exclude`
 * as the snap plugin declares them. Because the two packages may not import one another,
 * nothing checks that agreement at compile time — so it is checked at *runtime* instead
 * (see {@link resolveSnapHandle}), loudly, rather than degrading into a silent no-op.
 */
export interface DrawSnapHandle {
  setInProgress?(vertices: readonly LngLat[]): void
  exclude?(ids: Iterable<FeatureId>): void
}

type UntypedLookup = (id: string) => unknown

/**
 * Resolves the snap plugin's API structurally, or `undefined` when it is not installed.
 *
 * Two constraints meet here. A plugin may not import another plugin (boundary rule 2 —
 * `scripts/check-boundaries.mjs` fails the build for it), so `@fleximap/plugin-snap`'s
 * augmentation of `FlexiPluginRegistry` is not in scope and `'snap'` is not a key
 * `ctx.tryPlugin` will accept. Hence the cast to an untyped lookup and the duck-typing
 * on the way out: we ask the *kernel* for the id, and treat whatever comes back as a
 * bag of optional methods.
 *
 * Every call site guards with `?.`, so a map with no snap plugin — or one whose snap
 * plugin exposes a different API — degrades to doing nothing at all, which is exactly
 * what `{ id: 'snap', optional: true }` promises.
 *
 * Resolved per gesture rather than once in `setup`: plugins are installed concurrently
 * (`Promise.all` in `FlexiMap#init`), so snap may not exist yet when draw's setup runs.
 */
export function resolveSnapHandle(ctx: PluginContext<unknown>): DrawSnapHandle | undefined {
  const api = (ctx.tryPlugin as unknown as UntypedLookup)('snap')
  if (api === null || typeof api !== 'object') return undefined

  const handle = api as DrawSnapHandle
  warnOnMismatch(ctx, handle)
  return handle
}

/** Warned once per method per map: a `#syncSnap` on every vertex must not become a log flood. */
const warned = new WeakSet<object>()

/**
 * A snap plugin that is installed but does not answer to these names is not a degradation,
 * it is a bug — the exclusion never lands and the pointer snaps to the rubber band it is
 * dragging. Without a shared type there is no compiler to say so, so this says it instead.
 */
function warnOnMismatch(ctx: PluginContext<unknown>, handle: DrawSnapHandle): void {
  if (warned.has(handle)) return
  warned.add(handle)

  const missing = (['setInProgress', 'exclude'] as const).filter(
    (name) => typeof handle[name] !== 'function',
  )
  if (missing.length === 0) return

  ctx.log.warn(
    `[draw] the installed "snap" plugin exposes no ${missing.map((m) => `${m}()`).join(' or ')} — ` +
      `drawing still works, but snapping cannot close a ring on its own first vertex and the ` +
      `preview may snap to itself.`,
  )
}
