/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * jsts ships no `main` and no `exports` field, so a bare `import 'jsts'` fails at
 * runtime. The deep ESM paths below are the only ones that resolve — and they
 * carry no types, hence this file.
 *
 * `any` is honest here: the alternative is hand-writing a partial JTS type tree
 * that would drift from the library and give a false sense of safety. Everything
 * that crosses back out of `jsts.ts` is typed as GeoJSON, so the `any` is
 * quarantined to one module.
 */
declare module 'jsts/org/locationtech/jts/io/GeoJSONReader.js' {
  const GeoJSONReader: any
  export default GeoJSONReader
}

declare module 'jsts/org/locationtech/jts/io/GeoJSONWriter.js' {
  const GeoJSONWriter: any
  export default GeoJSONWriter
}

declare module 'jsts/org/locationtech/jts/operation/BoundaryOp.js' {
  const BoundaryOp: any
  export default BoundaryOp
}

declare module 'jsts/org/locationtech/jts/operation/union/UnionOp.js' {
  const UnionOp: any
  export default UnionOp
}

declare module 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js' {
  const OverlayOp: any
  export default OverlayOp
}

declare module 'jsts/org/locationtech/jts/operation/relate/RelateOp.js' {
  const RelateOp: any
  export default RelateOp
}

declare module 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js' {
  const Polygonizer: any
  export default Polygonizer
}

declare module 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js' {
  const InteriorPointArea: any
  export default InteriorPointArea
}

declare module 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js' {
  const IsValidOp: any
  export default IsValidOp
}

declare module 'jsts/org/locationtech/jts/geom/PrecisionModel.js' {
  const PrecisionModel: any
  export default PrecisionModel
}

declare module 'jsts/org/locationtech/jts/precision/GeometryPrecisionReducer.js' {
  const GeometryPrecisionReducer: any
  export default GeometryPrecisionReducer
}
