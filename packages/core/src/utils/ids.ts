/**
 * Feature ids.
 *
 * Collision resistance is not paranoia here: two features minted in different
 * tabs, or in a browser and on a server, end up in the same collection the moment
 * anyone syncs, and a collision silently overwrites a parcel. A counter would
 * collide across sessions; a timestamp would collide within a millisecond.
 */

/** Disambiguates ids minted inside the same millisecond by the non-crypto fallback. */
let sequence = 0

/**
 * A collision-resistant id, optionally prefixed so that a raw id in a log or a
 * renderer's source dump still says what it is (`parcel_…` beats `a3f9…`).
 *
 * Uses `crypto.randomUUID` where it exists. It does not always exist: browsers
 * only expose it in a *secure context*, so an app served over plain http — which
 * is most internal municipal deployments — falls through to the second branch.
 * That branch is deliberately not "good enough random": it mixes time, a
 * per-process sequence and `Math.random`, because ids minted in a tight loop
 * (importing 50 000 parcels) must not depend on `Math.random` alone reseeding.
 */
export function createId(prefix = 'f'): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) return `${prefix}_${uuid}`

  sequence = (sequence + 1) % 0x10000
  const time = Date.now().toString(36)
  const seq = sequence.toString(36).padStart(4, '0')
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${time}${seq}${rand}`
}
