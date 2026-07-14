import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Never bundle the core into a plugin — that is how you end up with two event
  // buses in a user's app and a listener that mysteriously never fires.
  external: ['@fleximap/core', 'maplibre-gl'],
})
