#!/usr/bin/env node
/**
 * Enforces the dependency rules that the whole architecture rests on.
 *
 * These are stated in the README and in .claude/skills/blaeu-core-invariants,
 * but a rule that lives only in prose is a rule that erodes. This script is what
 * makes them real: it runs in CI, and it fails the build.
 *
 * Three rules:
 *
 *   1. The core imports no plugin and no preset. If core needs what a plugin
 *      knows, the plugin *registers* it through an extension point core owns.
 *      The day core imports a plugin is the day "plugin-first" becomes marketing.
 *
 *   2. No plugin imports another plugin. Plugins compose through the kernel —
 *      the command bus, the event bus, the pipelines, ctx.tryPlugin() — never by
 *      reaching for each other. The draw plugin must not import the snap plugin;
 *      snapping reaches it as middleware that rewrote the pointer position before
 *      the draw tool ever read it. That indirection *is* the architecture.
 *
 *   3. Every plugin and preset declares @blaeu/core as a peerDependency, never
 *      a dependency. Two copies of core in a user's node_modules means two event
 *      buses, two command buses, two stores. Nothing throws. The plugin's
 *      listener simply never fires, and the user loses a day to it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

/** @type {{rule: string, file: string, detail: string, why: string}[]} */
const violations = []

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

function sourceFiles(dir) {
  /** @type {string[]} */
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = join(d, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(full)
    }
  }
  try {
    walk(dir)
  } catch {
    /* package has no src yet */
  }
  return out
}

function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  /** @type {string[]} */
  const specs = []
  for (const m of text.matchAll(IMPORT_RE)) {
    if (m[1]) specs.push(m[1])
  }
  return specs
}

const packageNames = readdirSync(packagesDir).filter((d) =>
  statSync(join(packagesDir, d)).isDirectory(),
)

/* ---- Rule 1: core imports nothing from this repo ---- */
for (const file of sourceFiles(join(packagesDir, 'core', 'src'))) {
  for (const spec of importsOf(file)) {
    if (/^@blaeu\/(plugin|preset)-/.test(spec)) {
      violations.push({
        rule: 'core-imports-plugin',
        file: relative(root, file),
        detail: `imports "${spec}"`,
        why: 'The core must not know a plugin exists. If core needs this capability, add an extension point instead — that is what makes a third-party plugin as powerful as a built-in one.',
      })
    }
  }
}

/* ---- Rule 2: plugins do not import each other ---- */
for (const pkg of packageNames.filter((p) => p.startsWith('plugin-'))) {
  const self = `@blaeu/${pkg}`
  for (const file of sourceFiles(join(packagesDir, pkg, 'src'))) {
    for (const spec of importsOf(file)) {
      if (/^@blaeu\/plugin-/.test(spec) && !spec.startsWith(self)) {
        violations.push({
          rule: 'plugin-imports-plugin',
          file: relative(root, file),
          detail: `imports "${spec}"`,
          why: 'Plugins compose through the kernel, not through each other. Use ctx.tryPlugin(id) for an optional dependency — and make sure it genuinely degrades when that plugin is absent.',
        })
      }
    }
  }
}

/* ---- Rule 3: core is a peerDependency, never a dependency ---- */
for (const pkg of packageNames.filter((p) => p.startsWith('plugin-') || p.startsWith('preset-'))) {
  const manifestPath = join(packagesDir, pkg, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    continue
  }
  if (manifest.dependencies?.['@blaeu/core']) {
    violations.push({
      rule: 'core-as-dependency',
      file: relative(root, manifestPath),
      detail: '"@blaeu/core" is listed under "dependencies"',
      why: 'It must be a peerDependency. Two copies of the core means two event buses and two stores — nothing throws, the listener just silently never fires, and that is a genuinely miserable afternoon for whoever hits it.',
    })
  }
  if (!manifest.peerDependencies?.['@blaeu/core']) {
    violations.push({
      rule: 'missing-core-peer',
      file: relative(root, manifestPath),
      detail: 'no "@blaeu/core" under "peerDependencies"',
      why: 'Every plugin and preset must declare the core as a peer, so npm can warn on a version mismatch instead of silently installing a second copy.',
    })
  }
}

/* ---- Report ---- */
if (violations.length === 0) {
  console.log(
    '✓ package boundaries clean — core imports no plugin, no plugin imports another, core is peer-only',
  )
  process.exit(0)
}

console.error(`\n✗ ${violations.length} boundary violation(s):\n`)
for (const v of violations) {
  console.error(`  [${v.rule}] ${v.file}`)
  console.error(`      ${v.detail}`)
  console.error(`      → ${v.why}\n`)
}
process.exit(1)
