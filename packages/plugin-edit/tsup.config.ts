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
  //
  // `ignoreDeprecations` is not ours to want, and it is not silencing anything this repo
  // does: tsup hard-codes `baseUrl: compilerOptions.baseUrl || '.'` into that program
  // (`tsup/dist/rollup.js`), TypeScript 6 made `baseUrl` a deprecation *error*, and so
  // every `.d.ts` in the monorepo stopped building the moment the compiler moved. Our own
  // configs no longer set `baseUrl` anywhere — `paths` resolve relative to the config
  // that declares them — so this covers tsup's injection and nothing else.
  //
  // It is a stay of execution, not a fix: TypeScript 7 removes `baseUrl` outright and
  // `ignoreDeprecations` will not save it. tsup 8.5.1 is the current release and still
  // injects it, so the real fix is upstream. What holds the line here meanwhile is that
  // `pack-and-consume` installs these tarballs and type-checks a consumer against the
  // emitted `.d.ts`, so a dts pass that silently degrades fails CI rather than shipping.
  dts: {
    compilerOptions: { composite: false, declarationMap: false, ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Never bundle the core into a plugin — that is how you end up with two event
  // buses in a user's app and a listener that mysteriously never fires.
  external: ['@blaeu/core', 'maplibre-gl'],
})
