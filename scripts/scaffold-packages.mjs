#!/usr/bin/env node
/**
 * Generates package.json / tsconfig.json / tsup.config.ts for every workspace
 * package.
 *
 * Doing this from one script — rather than hand-writing twelve sets of nearly
 * identical files — is what keeps dependency versions, the `exports` map, and the
 * peer-dependency rule consistent across the monorepo. The rule that matters most:
 * `@blaeu/core` is a **peerDependency** of every plugin, never a dependency.
 * Two copies of the core means two event buses, and the symptom is a listener
 * that silently never fires.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `--check` compares what the generator *would* write against what is committed, and fails on
 * any difference, instead of overwriting.
 *
 * This exists because the generator drifting from the tree was not a cosmetic problem. It had
 * silently lost `plugin-select`'s two `@turf/*` runtime dependencies and grown a `rbush` that
 * `plugin-snap` never imported — and neither showed up in typecheck, test or build, because npm
 * hoists workspace dependencies to the root regardless. Only a published tarball would have
 * broken, at the consumer, with ERR_MODULE_NOT_FOUND.
 *
 * The one visible signal used to be `format:check` failing on the regenerated files, because
 * the generator wrote raw `JSON.stringify` output while the committed files were
 * prettier-formatted. The natural response to that — run `npm run format` — tidied the signal
 * away and left the dependency deletions in place. So the generator now formats its own output
 * with the repo's prettier config: generated and committed are byte-identical, the noise is
 * gone, and a real difference is the only thing `--check` can report.
 */
const CHECK = process.argv.includes('--check')
/** @type {string[]} */
const differences = []

async function emit(path, contents) {
  // `filepath` rather than an explicit `parser`, so prettier infers exactly what its CLI would.
  // That distinction is not cosmetic here: prettier picks the `json-stringify` parser for a file
  // literally named `package.json` (which keeps one array item per line) and `json` for every
  // other .json file. Forcing `json` made the generator's output disagree with `npm run format`
  // on all twelve manifests — which would have made `--check` cry wolf on every run, and a check
  // that always fails is a check everyone learns to skip.
  const formatted = await format(contents, { ...prettierConfig, filepath: path })
  if (!CHECK) {
    writeFileSync(path, formatted)
    return
  }
  let current = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    /* missing file — reported as a difference below */
  }
  if (current !== formatted) differences.push(relative(root, path))
}

const prettierConfig = JSON.parse(readFileSync(join(root, '.prettierrc.json'), 'utf8'))

/**
 * Read from the core manifest rather than declared here.
 *
 * A hard-coded literal would be a thirteenth copy of the version number, and the one thing
 * guaranteed to touch the other twelve is `changeset version`. The moment it bumped them, this
 * file would still say 0.1.0, `--check` would fail on every package, and the fix would look
 * like a scaffold bug rather than a stale constant. Changesets owns the version; this reads it.
 */
const VERSION = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).version
/**
 * Derived from {@link VERSION}, not written out.
 *
 * This was a hardcoded `^0.1.0` and it survived the change that made VERSION read from the
 * manifest — which meant the generator agreed with the tree only for as long as nobody released
 * anything. `changeset version` bumps this peer range in all eleven plugins and presets; the
 * generator kept saying `^0.1.0`, and `scaffold:check` (which runs first in `verify`) failed on
 * the very first Version Packages PR.
 */
const CORE_PEER = { '@blaeu/core': `^${VERSION}` }

/** @type {Array<{name: string, deps?: Record<string,string>, peers?: Record<string,string>, refs?: string[], desc: string, keywords: string[]}>} */
const packages = [
  {
    name: 'core',
    desc: 'The Blaeu kernel: event bus, plugin registry, pipelines, command bus, feature store.',
    keywords: [
      'geospatial',
      'gis',
      'maplibre',
      'maplibre-gl',
      'map-editor',
      'plugin-architecture',
      'geojson',
      'proj4',
      'coordinate-systems',
      'epsg',
      'event-bus',
      'typescript',
    ],
    deps: {
      proj4: '^2.12.1',
      rbush: '^4.0.1',
    },
    peers: { 'maplibre-gl': '>=4.7.0 <7' },
    refs: [],
  },
  {
    name: 'plugin-snap',
    desc: 'Snapping engine: vertex, edge, midpoint, intersection, grid and guide providers.',
    keywords: [
      'blaeu',
      'snapping',
      'snap',
      'vertex-snapping',
      'grid-snapping',
      'geospatial',
      'maplibre',
      'gis',
      'map-editor',
      'digitizing',
    ],
    peers: CORE_PEER,
    // No `deps`: nothing under packages/plugin-snap/src references rbush. It was declared here
    // and regeneration kept adding it back — a dependency a consumer downloads and never runs.
    refs: ['core'],
  },
  {
    name: 'plugin-draw',
    desc: 'Drawing tools: point, line, polygon, rectangle, circle, freehand.',
    keywords: [
      'blaeu',
      'geospatial',
      'maplibre',
      'drawing',
      'digitizing',
      'polygon',
      'freehand',
      'geojson',
      'map-editor',
    ],
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'plugin-edit',
    desc: 'Editing: vertex editing, move, rotate, scale, split, merge — with topological awareness.',
    keywords: [
      'blaeu',
      'geospatial',
      'maplibre',
      'geometry-editing',
      'vertex-editing',
      'split',
      'merge',
      'jsts',
      'topology',
      'map-editor',
    ],
    peers: CORE_PEER,
    deps: { jsts: '^2.12.1' },
    refs: ['core'],
  },
  {
    name: 'plugin-select',
    desc: 'Selection: single, multi, box, lasso.',
    keywords: [
      'blaeu',
      'geospatial',
      'selection',
      'lasso',
      'box-select',
      'turf',
      'maplibre',
      'map-editor',
      'geojson',
    ],
    peers: CORE_PEER,
    // Real, and imported at SelectionController.ts:1-2. They were missing here, so every
    // regeneration silently deleted them from the manifest — invisible to typecheck, test and
    // build, because npm hoists them to the root anyway. Only the published tarball broke.
    deps: {
      '@turf/boolean-point-in-polygon': '^7.3.5',
      '@turf/helpers': '^7.3.5',
    },
    refs: ['core'],
  },
  {
    name: 'plugin-measure',
    desc: 'Measurement: distance, area, bearing — planar, in the working CRS.',
    keywords: [
      'blaeu',
      'geospatial',
      'measurement',
      'distance',
      'area',
      'bearing',
      'surveying',
      'maplibre',
      'gis',
    ],
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'plugin-history',
    desc: 'Undo/redo across every plugin, by subscribing to the command bus.',
    keywords: [
      'blaeu',
      'undo',
      'redo',
      'undo-redo',
      'command-pattern',
      'command-bus',
      'maplibre',
      'map-editor',
      'geospatial',
    ],
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'plugin-topology',
    desc: 'Topology validation via JSTS: self-intersection, overlaps, gaps, slivers.',
    keywords: [
      'blaeu',
      'topology',
      'jsts',
      'gis',
      'geospatial',
      'validation',
      'overlap-detection',
      'sliver',
      'self-intersection',
      'cadastre',
    ],
    peers: CORE_PEER,
    deps: { jsts: '^2.12.1' },
    refs: ['core'],
  },
  {
    name: 'plugin-ui',
    desc: 'Framework-free UI controls: toolbar, coordinate readout, snap indicator, issue panel.',
    keywords: [
      'blaeu',
      'ui-controls',
      'toolbar',
      'framework-free',
      'vanilla-js',
      'maplibre',
      'map-editor',
      'coordinate-readout',
      'geospatial',
    ],
    peers: CORE_PEER,
    refs: ['core'],
  },
  {
    name: 'preset-cadastre',
    desc: 'Cadastre / land registry preset. Turkish CRS defaults, topological editing, mm precision.',
    keywords: [
      'blaeu',
      'cadastre',
      'land-registry',
      'parcel-editing',
      'surveying',
      'turkey',
      'turef',
      'epsg-5254',
      'topology',
      'gis',
    ],
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
    keywords: [
      'blaeu',
      'urban-planning',
      'zoning',
      'city-planning',
      'scenario-comparison',
      'planning',
      'gis',
      'map-editor',
      'geospatial',
    ],
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
    name: 'preset-game',
    desc: 'Game map preset: entity placement, grid snapping, procedural hooks.',
    keywords: [
      'blaeu',
      'level-editor',
      'game-map',
      'tilemap',
      'hex-grid',
      'grid-snapping',
      'procedural-generation',
      'gamedev',
      'map-editor',
    ],
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
  if (!CHECK) mkdirSync(join(dir, 'src'), { recursive: true })

  const isCore = pkg.name === 'core'

  // ESM only, and that is a decision rather than an omission — see the note on `format` in
  // the tsup template below. One condition, so there is no way for a consumer to resolve a
  // second copy of the kernel through a different entry point.
  //
  // In-repo, resolution goes through the tsconfig `paths` and the vite/vitest aliases (both to
  // source), not through this map — so there is no `development` condition here, which when
  // published would resolve a consumer to `./src`, which `files` never ships.
  const entry = (base) => ({
    types: `./dist/${base}.d.ts`,
    default: `./dist/${base}.js`,
  })
  const exportsMap = {
    '.': entry('index'),
    './package.json': './package.json',
  }
  if (isCore) exportsMap['./testing'] = entry('testing')

  await emit(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@blaeu/${pkg.name}`,
        version: VERSION,
        description: pkg.desc,
        // npm's search ranking is partly keyword-driven, and keywords are baked into the
        // published tarball's metadata — adding them after a publish needs a version bump
        // before anyone can search on them. So they are generated here, with the rest of the
        // manifest, rather than left to be remembered per package.
        keywords: pkg.keywords,
        license: 'MIT',
        type: 'module',
        sideEffects: false,
        // No `main`: it is the CJS entry point, and there is no CJS build. `module` and
        // `types` stay for bundlers and editors that predate `exports`.
        module: './dist/index.js',
        types: './dist/index.d.ts',
        exports: exportsMap,
        // A tarball with no licence text is a licence nobody can read, and a package page
        // with no README is a package nobody installs. Both are per-package files, so both
        // have to be listed — `files` is not inherited from the repo root.
        files: ['dist', 'README.md', 'LICENSE'],
        repository: {
          type: 'git',
          url: 'git+https://github.com/celikgo/blaeu-lib.git',
          directory: `packages/${pkg.name}`,
        },
        homepage: `https://github.com/celikgo/blaeu-lib/tree/main/packages/${pkg.name}#readme`,
        bugs: { url: 'https://github.com/celikgo/blaeu-lib/issues' },
        engines: { node: '>=20' },
        scripts: {
          build: 'tsup',
          dev: 'tsup --watch',
          clean: 'rm -rf dist .tsbuild *.tsbuildinfo',
          // Publishing from a stale `dist` is the classic way to ship yesterday's fix.
          prepack: 'npm run build',
        },
        ...(pkg.deps ? { dependencies: pkg.deps } : {}),
        ...(pkg.peers ? { peerDependencies: pkg.peers } : {}),
        devDependencies: {
          // The **ceiling** of the peer range, not the floor: the default CI leg installs this
          // one, so it should be the newest major we claim to support. The floor is covered by
          // the `peer-range` matrix, which type-checks against 4.7.0 and ^5 as well.
          ...(isCore ? { 'maplibre-gl': '^6.4.0' } : { '@blaeu/core': `^${VERSION}` }),
          ...(pkg.name === 'core' ? { '@types/proj4': '^2.5.5', '@types/rbush': '^4.0.0' } : {}),
        },
        publishConfig: { access: 'public' },
      },
      null,
      2,
    ) + '\n',
  )

  await emit(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          rootDir: './src',
          // `tsc --build` emits here, NOT into `dist` — tsup owns `dist`, and a stray
          // .tsbuildinfo there both ships in the tarball and collides with tsup's output.
          outDir: './.tsbuild',
          tsBuildInfoFile: './.tsbuild/.tsbuildinfo',
        },
        include: ['src/**/*'],
        exclude: ['src/**/*.test.ts', 'dist'],
        references: pkg.refs.map((r) => ({ path: `../${r}` })),
      },
      null,
      2,
    ) + '\n',
  )

  // Named entries give flat output (`dist/index.js`, `dist/testing.js`) that matches
  // the `exports` map above — array entries would nest as `dist/testing/index.js`.
  const entries = isCore
    ? `{ index: 'src/index.ts', testing: 'src/testing/index.ts' }`
    : `{ index: 'src/index.ts' }`
  await emit(
    join(dir, 'tsup.config.ts'),
    `import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ${entries},
  // ESM only. rbush@4 and jsts@2.12 are both \`"type": "module"\` with no CJS build, so a
  // \`require()\` of our CJS entry throws ERR_REQUIRE_ESM on the declared engine floor
  // (\`node >=20\`) — proven, not assumed. It appears to work on Node 22.12+ only because
  // \`require(esm)\` landed there. Shipping a format that cannot load on the version we claim
  // to support is worse than not shipping it, and removing a format after release is breaking.
  format: ['esm'],
  // tsup's dts build runs its own tsc program, which cannot use the project-references
  // (composite) tsconfig the typecheck relies on — so turn it off just for the .d.ts pass.
  //
  // \`ignoreDeprecations\` is not ours to want, and it is not silencing anything this repo
  // does: tsup hard-codes \`baseUrl: compilerOptions.baseUrl || '.'\` into that program
  // (\`tsup/dist/rollup.js\`), TypeScript 6 made \`baseUrl\` a deprecation *error*, and so
  // every \`.d.ts\` in the monorepo stopped building the moment the compiler moved. Our own
  // configs no longer set \`baseUrl\` anywhere — \`paths\` resolve relative to the config
  // that declares them — so this covers tsup's injection and nothing else.
  //
  // It is a stay of execution, not a fix: TypeScript 7 removes \`baseUrl\` outright and
  // \`ignoreDeprecations\` will not save it. tsup 8.5.1 is the current release and still
  // injects it, so the real fix is upstream. What holds the line here meanwhile is that
  // \`pack-and-consume\` installs these tarballs and type-checks a consumer against the
  // emitted \`.d.ts\`, so a dts pass that silently degrades fails CI rather than shipping.
  dts: {
    compilerOptions: { composite: false, declarationMap: false, ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Never bundle the core into a plugin — that is how you end up with two event
  // buses in a user's app and a listener that mysteriously never fires.
  external: [${isCore ? "'maplibre-gl'" : "'@blaeu/core', 'maplibre-gl'"}],
})
`,
  )

  if (!CHECK) console.log(`✓ packages/${pkg.name}`)
}

// `mkdirSync` is skipped under --check: the point is to report drift, not create anything.
if (CHECK) {
  if (differences.length > 0) {
    console.error(
      `✗ ${differences.length} generated file(s) differ from what is committed:\n` +
        differences.map((d) => `    ${d}`).join('\n') +
        `\n\n  Run \`npm run scaffold\` and commit the result — or, if the committed file is the\n` +
        `  one that is right, fix the template in scripts/scaffold-packages.mjs to match.\n\n` +
        `  If you got here from a dependency-bump PR (Dependabot or otherwise), it is the\n` +
        `  second one. The bot edits the generated manifest; the version in this script is\n` +
        `  still the old one, and that disagreement is what you are reading. Running\n` +
        `  \`npm run scaffold\` would resolve it by silently undoing the upgrade. Raise the\n` +
        `  range in this script instead, regenerate, and commit both.\n`,
    )
    process.exit(1)
  }
  console.log(`✓ ${packages.length} package manifests match the generator.`)
} else {
  console.log(`\n${packages.length} packages scaffolded.`)
}
