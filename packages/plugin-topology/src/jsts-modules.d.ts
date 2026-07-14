/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * JSTS ships no TypeScript types for its deep module paths, and — more awkwardly —
 * its `package.json` has neither `main` nor `exports`, so a bare `import 'jsts'`
 * fails at runtime under ESM. Every import in this package therefore reaches
 * straight at the module file, and every one of them needs a declaration here or
 * `tsc` cannot resolve it.
 *
 * These are `any` on purpose. The honest place to put the types is `jsts.ts`,
 * which wraps each of these in a narrow interface describing exactly the handful
 * of methods we call — a fabricated `.d.ts` for the whole of JTS would be a lie we
 * would have to maintain.
 *
 * One trap worth recording: the deep modules do **not** apply `jsts/monkey.js`,
 * which is what installs the convenience methods (`geometry.intersection()`,
 * `geometry.getCentroid()`, `geometry.relate()`) onto `Geometry.prototype`. Those
 * methods are simply absent here, and calling one fails with
 * "is not a function". Use the operation classes directly — `OverlayOp`,
 * `Centroid`, `IsValidOp` — which is what `jsts.ts` does.
 */

declare module 'jsts/org/locationtech/jts/io/GeoJSONReader.js' {
  const GeoJSONReader: any
  export default GeoJSONReader
}

declare module 'jsts/org/locationtech/jts/io/GeoJSONWriter.js' {
  const GeoJSONWriter: any
  export default GeoJSONWriter
}

declare module 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js' {
  const IsValidOp: any
  export default IsValidOp
}

declare module 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js' {
  const OverlayOp: any
  export default OverlayOp
}

declare module 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js' {
  const BufferOp: any
  export default BufferOp
}

declare module 'jsts/org/locationtech/jts/geom/PrecisionModel.js' {
  const PrecisionModel: any
  export default PrecisionModel
}

declare module 'jsts/org/locationtech/jts/precision/GeometryPrecisionReducer.js' {
  const GeometryPrecisionReducer: any
  export default GeometryPrecisionReducer
}

declare module 'jsts/org/locationtech/jts/algorithm/Centroid.js' {
  const Centroid: any
  export default Centroid
}

declare module 'jsts/org/locationtech/jts/algorithm/ConvexHull.js' {
  const ConvexHull: any
  export default ConvexHull
}
