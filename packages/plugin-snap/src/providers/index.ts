import type { SnapKind, SnapProvider } from '@blaeu/core'
import type { SnapDeps } from '../geometry.js'
import { createVertexProvider } from './vertex.js'
import { createIntersectionProvider } from './intersection.js'
import { createMidpointProvider } from './midpoint.js'
import { createEdgeProvider } from './edge.js'
import { createExtensionProvider } from './extension.js'
import { createPerpendicularProvider } from './perpendicular.js'
import { createGridProvider } from './grid.js'

export { createVertexProvider } from './vertex.js'
export { createIntersectionProvider } from './intersection.js'
export { createMidpointProvider } from './midpoint.js'
export { createEdgeProvider } from './edge.js'
export { createExtensionProvider } from './extension.js'
export { createPerpendicularProvider } from './perpendicular.js'
export { createGridProvider } from './grid.js'

/**
 * The built-in providers, by kind.
 *
 * A `SnapKind` the engine does not know is not an error — plugins invent their own
 * kinds (`'parcel-corner'`, `'hex-centre'`, `'pipe-junction'`) and register the
 * provider themselves. The engine only builds the ones it ships.
 */
const BUILTINS: Readonly<Record<string, ((deps: SnapDeps) => SnapProvider) | undefined>> =
  Object.freeze({
    vertex: createVertexProvider,
    intersection: createIntersectionProvider,
    midpoint: createMidpointProvider,
    edge: createEdgeProvider,
    extension: createExtensionProvider,
    perpendicular: createPerpendicularProvider,
    grid: createGridProvider,
  })

export function createBuiltinProvider(kind: SnapKind, deps: SnapDeps): SnapProvider | undefined {
  return BUILTINS[kind]?.(deps)
}
