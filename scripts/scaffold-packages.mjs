#!/usr/bin/env node
/**
 * Generates package.json / tsconfig.json / tsup.config.ts for every workspace
 * package.
 *
 * Doing this from one script — rather than hand-writing thirteen sets of nearly
 * identical files — is what keeps dependency versions, the `exports` map, and the
 * peer-dependency rule consistent across the monorepo. The rule that matters most:
 * `@blaeu/core` is a **peerDependency** of every plugin, never a dependency.
 * Two copies of the core means two event buses, and the symptom is a listener
 * that silently never fires.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const VERSION = '0.1.0'
const CORE_PEER = { '@blaeu/core': '^0.1.0' }

/** @type {Array<{name: string, deps?: Record<string,string>, peers?: Record<string,string>, refs?: string[], desc: string}>} */
const packages = [
  {
    name: 'core',
    desc: 'The BlaeuMap kernel: event bus, plugin registry, pipelines, command bus, feature store.',
    deps: {
      proj4: '^2.12.1',
      rbush: '^4.0.1',
    },
    peers: { 'maplibre-gl': '>=4.7.0 <6' },
    refs: [],
  },
  {
    name: 'plugin-snap',
    desc: 'Snapping engine: vertex, edge, midpoint, intersection, grid and guide providers.',
    peers: CORE_PEER,
    deps: { rbush: '^4.0.1' },
    refs: ['core'],
  },
  {
    name: 'plugin-draw',
    desc: 'Drawing tools: point, line, polygon, rectangle, circle, freehand.',
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'plugin-edit',
    desc: 'Editing: vertex editing, move, rotate, scale, split, merge — with topological awareness.',
    peers: CORE_PEER,
    deps: { jsts: '^2.12.1' },
    refs: ['core'],
  },
  {
    name: 'plugin-select',
    desc: 'Selection: single, multi, box, lasso.',
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'plugin-measure',
    desc: 'Measurement: distance, area, bearing — planar, in the working CRS.',
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'plugin-history',
    desc: 'Undo/redo across every plugin, by subscribing to the command bus.',
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'plugin-topology',
    desc: 'Topology validation via JSTS: self-intersection, overlaps, gaps, slivers.',
    peers: CORE_PEER,
    deps: { jsts: '^2.12.1' },
    refs: ['core'],
  },
  {
    name: 'plugin-ui',
    desc: 'Framework-free UI controls: toolbar, coordinate readout, snap indicator, issue panel.',
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'preset-cadastre',
    desc: 'Cadastre / land registry preset. Turkish CRS defaults, topological editing, mm precision.',
    peers: CORE_PEER,
    deps: {
      '@blaeu/plugin-snap': `^${VERSION}`,
      '@blaeu/plugin-draw': `^${VERSION}`,
      '@blaeu/plugin-edit': `^${VERSION}`,
      '@blaeu/plugin-select': `^${VERSION}`,
      '@blaeu/plugin-measure': `^${VERSION}`,
      '@blaeu/plugin-history': `^${VERSION}`,
      '@blaeu/plugin-topology': `^${VERSION}`,
      '@blaeu/plugin-ui': `^${VERSION}`,
    },
    refs: [
      'core',
      'plugin-snap',
      'plugin-draw',
      'plugin-edit',
      'plugin-select',
      'plugin-measure',
      'plugin-history',
      'plugin-topology',
      'plugin-ui',
    ],
  },
  {
    name: 'preset-urban',
    desc: 'Urban planning preset: zoning layers, scenario comparison, attribute forms.',
    peers: CORE_PEER,
    deps: {
      '@blaeu/plugin-snap': `^${VERSION}`,
      '@blaeu/plugin-draw': `^${VERSION}`,
      '@blaeu/plugin-edit': `^${VERSION}`,
      '@blaeu/plugin-select': `^${VERSION}`,
      '@blaeu/plugin-measure': `^${VERSION}`,
      '@blaeu/plugin-history': `^${VERSION}`,
      '@blaeu/plugin-ui': `^${VERSION}`,
    },
    refs: [
      'core',
      'plugin-snap',
      'plugin-draw',
      'plugin-edit',
      'plugin-select',
      'plugin-measure',
      'plugin-history',
      'plugin-ui',
    ],
  },
  {
    name: 'preset-game',
    desc: 'Game map preset: entity placement, grid snapping, procedural hooks.',
    peers: CORE_PEER,
    deps: {
      '@blaeu/plugin-snap': `^${VERSION}`,
      '@blaeu/plugin-draw': `^${VERSION}`,
      '@blaeu/plugin-select': `^${VERSION}`,
      '@blaeu/plugin-history': `^${VERSION}`,
      '@blaeu/plugin-ui': `^${VERSION}`,
    },
    refs: ['core', 'plugin-snap', 'plugin-draw', 'plugin-select', 'plugin-history', 'plugin-ui'],
  },
]

for (const pkg of packages) {
  const dir = join(root, 'packages', pkg.name)
  mkdirSync(join(dir, 'src'), { recursive: true })

  const isCore = pkg.name === 'core'

  const exportsMap = {
    '.': {
      // `development` resolves to source, so editing core is visible in an example
      // with no rebuild — and a type error in core surfaces immediately downstream.
      development: './src/index.ts',
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/index.cjs',
    },
    './package.json': './package.json',
  }
  if (isCore) {
    exportsMap['./testing'] = {
      development: './src/testing/index.ts',
      types: './dist/testing.d.ts',
      import: './dist/testing.js',
    }
  }

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@blaeu/${pkg.name}`,
        version: VERSION,
        description: pkg.desc,
        license: 'MIT',
        type: 'module',
        sideEffects: false,
        main: './dist/index.cjs',
        module: './dist/index.js',
        types: './dist/index.d.ts',
        exports: exportsMap,
        files: ['dist'],
        scripts: {
          build: 'tsup',
          dev: 'tsup --watch',
          clean: 'rm -rf dist *.tsbuildinfo',
        },
        ...(pkg.deps ? { dependencies: pkg.deps } : {}),
        ...(pkg.peers ? { peerDependencies: pkg.peers } : {}),
        devDependencies: {
          ...(isCore ? { 'maplibre-gl': '^5.6.0' } : { '@blaeu/core': `^${VERSION}` }),
          ...(pkg.name === 'core' ? { '@types/proj4': '^2.5.5', '@types/rbush': '^4.0.0' } : {}),
        },
        publishConfig: { access: 'public' },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          rootDir: './src',
          outDir: './dist',
          tsBuildInfoFile: './dist/.tsbuildinfo',
        },
        include: ['src/**/*'],
        exclude: ['src/**/*.test.ts', 'dist'],
        references: pkg.refs.map((r) => ({ path: `../${r}` })),
      },
      null,
      2,
    ) + '\n',
  )

  const entries = isCore ? `['src/index.ts', 'src/testing/index.ts']` : `['src/index.ts']`
  writeFileSync(
    join(dir, 'tsup.config.ts'),
    `import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ${entries},
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Never bundle the core into a plugin — that is how you end up with two event
  // buses in a user's app and a listener that mysteriously never fires.
  external: [${isCore ? "'maplibre-gl'" : "'@blaeu/core', 'maplibre-gl'"}],
})
`,
  )

  console.log(`✓ packages/${pkg.name}`)
}

console.log(`\n${packages.length} packages scaffolded.`)
