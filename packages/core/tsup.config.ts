import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing/index.ts' },
  format: ['esm', 'cjs'],
  // tsup's dts build runs its own tsc program, which cannot use the project-references
  // (composite) tsconfig the typecheck relies on — so turn it off just for the .d.ts pass.
  dts: { compilerOptions: { composite: false, declarationMap: false } },
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Never bundle the core into a plugin — that is how you end up with two event
  // buses in a user's app and a listener that mysteriously never fires.
  external: ['maplibre-gl'],
})
