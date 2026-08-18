#!/usr/bin/env node
/**
 * Type-check the TypeScript examples in the documentation.
 *
 * Docs drift, and this project's own history is the argument: the July audit found four
 * separate places teaching `map.commands.dispatch(new AddFeaturesCommand(...))` — a call that
 * `dispatch` refuses at compile time *and* throws on at runtime. It had been wrong for months
 * across a README, ARCHITECTURE.md, an ADR and a package README, because prose is the one part
 * of this repository nothing compiles.
 *
 * So: extract every ```ts fence that is a plausible standalone module, write it into a scratch
 * directory that resolves `@blaeu/*` to source, and run `tsc` over the lot.
 *
 * **What is checked, and what is not.** A fence is checked when it contains an `import`
 * statement — that is the signal that the author meant it as runnable code rather than as a
 * fragment showing the shape of a function body. Everything else is skipped, and the skipped
 * count is *printed*, because a coverage gate that quietly ignores most of its input reads as
 * "the docs are checked" when it is not true.
 *
 * A fence can opt out explicitly with a `doc-check: skip` comment on any line — for the
 * deliberate counter-examples, where the whole point is that the code does **not** compile.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, '.doc-fences')

/** Every markdown file worth checking, including the skills the tooling loads. */
function markdownFiles() {
  const roots = ['README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'ROADMAP.md']
  const out = roots.map((r) => join(root, r)).filter(exists)
  for (const dir of ['docs', 'packages', '.claude/skills']) {
    out.push(...walk(join(root, dir)))
  }
  return out
}

function exists(p) {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

function walk(dir) {
  if (!exists(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.tsbuild')
      continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/** Every ```ts fence, with the line it starts on so an error can be traced back. */
function fences(source) {
  const lines = source.split('\n')
  const out = []
  let start = -1
  let body = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (start === -1) {
      if (line.trim() === '```ts' || line.trim() === '```typescript') {
        start = i + 1
        body = []
      }
    } else if (line.trim() === '```') {
      out.push({ line: start, code: body.join('\n') })
      start = -1
    } else {
      body.push(line)
    }
  }
  return out
}

const files = markdownFiles()
const checked = []
const skipped = []

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const file of files) {
  const rel = relative(root, file)
  for (const fence of fences(readFileSync(file, 'utf8'))) {
    const where = `${rel}:${fence.line}`
    if (/doc-check:\s*skip/.test(fence.code)) {
      skipped.push([where, 'opted out with `doc-check: skip`'])
      continue
    }
    if (!/^\s*import\s/m.test(fence.code)) {
      skipped.push([where, 'no import — a fragment, not a module'])
      continue
    }
    const name = `${rel.replace(/[^a-zA-Z0-9]/g, '_')}__${fence.line}.ts`
    writeFileSync(join(OUT, name), `${fence.code}\n`)
    checked.push([name, where])
  }
}

if (checked.length === 0) {
  console.log('No documentation fences to check.')
  process.exit(0)
}

writeFileSync(
  join(OUT, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: '../tsconfig.base.json',
      compilerOptions: {
        noEmit: true,
        composite: false,
        incremental: false,
        // A doc example is illustrative: it declares things it never reads, and demanding
        // otherwise would make every snippet longer than the point it is making.
        noUnusedLocals: false,
        noUnusedParameters: false,
        // Examples are written for a browser host. `DOM.Iterable` matters: without it, a
        // `for…of` over a `NodeListOf` in the *source* these examples import fails, and the
        // error points at library code rather than at any documentation.
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        // `node` because the core reads `process.env` for its log level. These types are for
        // the source the examples pull in, not for the examples themselves.
        types: ['node'],
        paths: Object.fromEntries(
          readdirSync(join(root, 'packages')).flatMap((p) => {
            const name = p === 'core' ? '@blaeu/core' : `@blaeu/${p}`
            const entries = [[name, [`../packages/${p}/src/index.ts`]]]
            if (p === 'core')
              entries.push(['@blaeu/core/testing', ['../packages/core/src/testing/index.ts']])
            return entries
          }),
        ),
      },
      // The extracted fences, plus the ambient module declarations the source they import
      // relies on (`jsts-modules.d.ts`). Without those, `tsc` reports errors inside
      // `plugin-topology/src/jsts.ts` that have nothing to do with any documentation.
      include: ['*.ts', '../packages/*/src/*.d.ts'],
    },
    null,
    2,
  ) + '\n',
)

const byFile = new Map(checked)
let failed = false
try {
  execFileSync('npx', ['tsc', '-p', join(OUT, 'tsconfig.json')], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  })
} catch (err) {
  failed = true
  const lines = String(err.stdout ?? '')
    .split('\n')
    .filter(Boolean)
  console.error(`✗ ${lines.length} error(s) in documentation examples:\n`)
  for (const line of lines) {
    // Rewrite `README_md__42.ts(3,10): error …` back to `README.md:42 → error …`
    const m = /^(.+?)\((\d+),(\d+)\):\s*(.*)$/.exec(line)
    const key = m ? m[1].replace(/^.*[/\\]/, '') : ''
    if (m && byFile.has(key)) {
      console.error(`  ${byFile.get(key)} (+${m[2]})  ${m[4]}`)
    } else {
      console.error(`  ${line}`)
    }
  }
  console.error('')
}

console.log(
  `${failed ? '✗' : '✓'} ${checked.length} documentation example(s) type-checked, ` +
    `${skipped.length} skipped.`,
)
if (process.argv.includes('--verbose')) {
  for (const [where, why] of skipped) console.log(`    skipped ${where} — ${why}`)
}

rmSync(OUT, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
