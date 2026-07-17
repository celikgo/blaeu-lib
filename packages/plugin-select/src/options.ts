import type { CollectionId } from '@blaeu/core'

/** Which modifier turns a click into a multi-select. */
export type MultiKey = 'shift' | 'ctrl' | 'meta'

export interface SelectOptions {
  /**
   * Restrict what is selectable to these collections.
   *
   * Omit to make every collection selectable. A cadastre product sets
   * `['parcels']` so that a click on a basemap-derived building footprint does not
   * select something the user cannot edit.
   */
  readonly collections?: readonly CollectionId[]

  /** The modifier that adds to the selection rather than replacing it. Default `'shift'`. */
  readonly multiKey?: MultiKey

  /** Allow `meta.locked` features to be selected. Default `false`. */
  readonly selectLocked?: boolean
}

/** Every field present, so nothing downstream has to guard a default twice. */
export interface ResolvedSelectOptions {
  readonly collections: readonly CollectionId[] | undefined
  readonly multiKey: MultiKey
  readonly selectLocked: boolean
}

export function resolveSelectOptions(options: SelectOptions = {}): ResolvedSelectOptions {
  return {
    // `undefined` and `[]` are different answers: no restriction, versus a
    // restriction to nothing. Preserving that distinction is what lets a preset
    // temporarily freeze selection by passing an empty array.
    collections: options.collections,
    multiKey: options.multiKey ?? 'shift',
    selectLocked: options.selectLocked ?? false,
  }
}
