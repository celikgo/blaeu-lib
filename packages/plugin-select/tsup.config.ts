import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  // ESM only. rbush@4 and jsts@2.12 are both `"type": "module"` with no CJS build, so a
  // `require()` of our CJS entry throws ERR_REQUIRE_ESM on the declared engine floor
  // (`node >=20`) — proven, not assumed. It appears to work on Node 22.12+ only because
  // `require(esm)` landed there. Shipping a format that cannot load on the version we claim
  // to support is worse than not shipping it, and removing a format after release is breaking.
  format: ['esm'],
  // tsup's dts build runs its own tsc program, which cannot use the project-references
  // (composite) tsconfig the typecheck relies on — so turn it off just for the .d.ts pass.
  dts: { compilerOptions: { composite: false, declarationMap: false } },
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Never bundle the core into a plugin — that is how you end up with two event
  // buses in a user's app and a listener that mysteriously never fires.
  external: ['@blaeu/core', 'maplibre-gl'],
})
