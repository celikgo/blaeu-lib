#!/usr/bin/env node
/**
 * Builds the GitHub Pages site from the markdown already in the tree.
 *
 * The repository carries ~36 KB of ARCHITECTURE.md and a ~30 KB README. On GitHub
 * those are one long scroll each, with no way to get from one to the other except
 * the back button — which is the problem this script exists to fix, not a general
 * ambition to have a docs site.
 *
 * The rule it follows: **the markdown in the tree is the source of truth.** Nothing
 * here rewrites prose, and no page exists that is not a file someone can read in the
 * repo. That keeps the site from becoming a second, staler copy of the docs — the
 * failure mode that makes generated documentation worse than none.
 *
 * Cross-document links are rewritten so they work in both places: `docs/CRS.md`
 * resolves to `crs.html` here and to the file on GitHub there. A link that points at
 * source code rather than prose is sent to GitHub, because the source is not on this
 * site and pretending otherwise would produce a dead link.
 */
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'site')
const REPO = 'https://github.com/celikgo/blaeu-lib'
const BLOB = `${REPO}/blob/main`

/**
 * Every page on the site, in nav order.
 *
 * `src` is the markdown file, relative to the repo root. `slug` is the output name.
 * Adding a page means adding a row here; there is no directory scan, because a docs
 * site that silently grows a page when someone drops a scratch file in `docs/` is a
 * site nobody trusts.
 */
const PAGES = [
  {
    src: 'README.md',
    slug: 'index',
    nav: 'Overview',
    blurb: 'What Blaeu is, and the claim it makes',
  },
  {
    src: 'docs/CRS.md',
    slug: 'crs',
    nav: 'Coordinate systems',
    blurb: 'TUREF, ED50, and measuring land correctly',
  },
  {
    src: 'ARCHITECTURE.md',
    slug: 'architecture',
    nav: 'Architecture',
    blurb: 'Every core abstraction, and the life of an event',
  },
  {
    src: 'docs/theming.md',
    slug: 'theming',
    nav: 'Theming',
    blurb: 'The theme system and writing your own',
  },
  {
    src: 'ROADMAP.md',
    slug: 'roadmap',
    nav: 'Roadmap',
    blurb: 'What is next, and why in that order',
  },
  {
    src: 'docs/PUBLISHING.md',
    slug: 'publishing',
    nav: 'Publishing',
    blurb: 'What is packaged, and what is left before npm',
  },
  {
    src: 'CONTRIBUTING.md',
    slug: 'contributing',
    nav: 'Contributing',
    blurb: 'Boundary rules and the three tests every plugin owes',
  },
  {
    src: 'docs/adr/README.md',
    slug: 'adr',
    nav: 'Decisions',
    blurb: 'The ADRs, each with the alternatives rejected',
  },
]

/** The ADRs get a page each, linked from the ADR index. */
const ADR_FILES = [
  '0001-plugin-first-kernel',
  '0002-commands-for-cross-plugin-undo',
  '0003-snapping-as-interaction-middleware',
  '0004-sync-interaction-async-commit',
  '0005-wgs84-interior-projected-working-crs',
  '0006-presets-as-data-not-subclasses',
  '0007-jsts-over-turf-for-topology',
  '0008-maplibre-with-a-renderer-seam',
  '0009-commit-commands',
  '0010-tools-declare-what-they-drag',
  '0011-transient-previews-preserve-ring-order',
  '0012-transaction-scope-is-an-explicit-handle',
  '0013-geometrycollection-is-flattened-not-rejected',
  '0014-maplibre-peer-range-policy',
  '0015-browser-tests-are-a-fence-gated-on-a-gpu-probe',
  '0016-one-lockstep-version-for-the-whole-kernel',
  '0017-package-manifests-are-generated',
]

/** markdown path (repo-relative, normalised) -> output page */
const slugBySource = new Map()
for (const p of PAGES) slugBySource.set(p.src, `${p.slug}.html`)
for (const a of ADR_FILES) slugBySource.set(`docs/adr/${a}.md`, `adr-${a}.html`)

/**
 * Resolve a markdown link against the document that contains it.
 *
 * Three outcomes, and the third is the one that matters: a link to something the site
 * does not host (source files, LICENSE, the examples directory) becomes an absolute
 * GitHub URL rather than a relative path that would 404 here.
 */
function resolveLink(href, fromDir) {
  if (/^(https?:|mailto:|#)/.test(href)) return href

  const [pathPart, hash = ''] = href.split('#')
  if (!pathPart) return href

  // Normalise the link target to a repo-root-relative path.
  const segments = join(fromDir, pathPart).split('/').filter(Boolean)
  const stack = []
  for (const s of segments) {
    if (s === '.') continue
    if (s === '..') stack.pop()
    else stack.push(s)
  }
  let target = stack.join('/')

  // `docs/adr/` with no filename means the ADR index.
  if (target.endsWith('/')) target += 'README.md'
  if (slugBySource.has(target)) {
    return slugBySource.get(target) + (hash ? `#${hash}` : '')
  }
  if (slugBySource.has(`${target}/README.md`)) {
    return slugBySource.get(`${target}/README.md`) + (hash ? `#${hash}` : '')
  }
  // Not a page on this site — send it to the repository, where it does exist.
  return `${BLOB}/${target}${hash ? `#${hash}` : ''}`
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Slugify a heading the way GitHub does, so in-page anchors keep working. */
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function render(markdown, fromDir) {
  const renderer = new marked.Renderer()

  const baseLink = renderer.link.bind(renderer)
  renderer.link = (token) => {
    const html = baseLink({ ...token, href: resolveLink(token.href ?? '', fromDir) })
    return html
  }

  const seen = new Map()
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens)
    let id = slugifyHeading(text)
    // GitHub disambiguates repeated headings with -1, -2, …; match that.
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    if (n > 0) id = `${id}-${n}`
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>\n`
  }

  return marked.parse(markdown, { renderer, mangle: false, headerIds: false })
}

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1b1f24; --muted: #5b6673; --rule: #d8dee4;
  --link: #0a5ad6; --code-bg: #f4f6f8; --sidebar: #fafbfc; --accent: #8a5a20;
}
:root:not([data-theme='light']) { }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: #0f1216; --fg: #dfe4ea; --muted: #98a2b0; --rule: #2b323b;
    --link: #79b0ff; --code-bg: #171c22; --sidebar: #12161b; --accent: #d8ab6a;
  }
}
:root[data-theme='dark'] {
  --bg: #0f1216; --fg: #dfe4ea; --muted: #98a2b0; --rule: #2b323b;
  --link: #79b0ff; --code-bg: #171c22; --sidebar: #12161b; --accent: #d8ab6a;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
}
.wrap { display: flex; min-height: 100vh; align-items: flex-start; }
nav.side {
  width: 250px; flex: 0 0 250px; background: var(--sidebar);
  border-right: 1px solid var(--rule); padding: 24px 18px; position: sticky; top: 0;
  max-height: 100vh; overflow-y: auto;
}
nav.side .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 2px; }
nav.side .brand a { color: var(--fg); text-decoration: none; }
nav.side .tag { color: var(--muted); font-size: 12.5px; margin-bottom: 18px; line-height: 1.45; }
nav.side a.item {
  display: block; padding: 6px 9px; margin: 1px -9px; border-radius: 6px;
  color: var(--fg); text-decoration: none; font-size: 14.5px;
}
nav.side a.item:hover { background: var(--code-bg); }
nav.side a.item[aria-current='page'] { background: var(--code-bg); font-weight: 600; color: var(--accent); }
nav.side .sec { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--muted); margin: 20px 0 6px; font-weight: 700; }
main { flex: 1 1 auto; min-width: 0; padding: 40px 44px 96px; max-width: 900px; }
main h1 { font-size: 32px; letter-spacing: -0.02em; margin: 0 0 18px; line-height: 1.2; }
main h2 { font-size: 23px; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--rule); letter-spacing: -0.01em; }
main h3 { font-size: 18.5px; margin: 28px 0 8px; }
main h4 { font-size: 16px; margin: 22px 0 6px; }
a { color: var(--link); }
.anchor { float: left; margin-left: -0.75em; padding-right: 0.25em; color: var(--muted);
  text-decoration: none; opacity: 0; font-weight: 400; }
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }
code { background: var(--code-bg); padding: 0.15em 0.38em; border-radius: 4px;
  font: 13.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: var(--code-bg); padding: 14px 16px; border-radius: 8px;
  overflow-x: auto; border: 1px solid var(--rule); }
pre code { background: none; padding: 0; font-size: 13px; line-height: 1.55; }
blockquote { margin: 18px 0; padding: 2px 16px; border-left: 3px solid var(--accent);
  color: var(--muted); background: var(--code-bg); border-radius: 0 6px 6px 0; }
blockquote p { margin: 10px 0; }
table { border-collapse: collapse; width: 100%; margin: 18px 0; font-size: 14.5px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--rule); padding: 7px 11px; text-align: left; }
th { background: var(--code-bg); font-weight: 650; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 32px 0; }
.foot { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--rule);
  color: var(--muted); font-size: 13.5px; }
.foot a { color: var(--muted); }
@media (max-width: 820px) {
  .wrap { flex-direction: column; }
  nav.side { width: 100%; flex: none; position: static; max-height: none;
    border-right: 0; border-bottom: 1px solid var(--rule); }
  main { padding: 26px 20px 72px; }
  main h1 { font-size: 26px; }
}
`

function navHtml(currentSlug) {
  const item = (href, label, cur) =>
    `<a class="item" href="${href}"${cur ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`

  const main = PAGES.map((p) => item(`${p.slug}.html`, p.nav, p.slug === currentSlug)).join(
    '\n      ',
  )

  return `<nav class="side">
      <div class="brand"><a href="index.html">Blaeu</a></div>
      <div class="tag">A plugin-first geospatial editing kernel, in TypeScript.</div>
      ${main}
      <div class="sec">Elsewhere</div>
      ${item(REPO, 'GitHub', false)}
      ${item(`${REPO}/releases`, 'Releases', false)}
    </nav>`
}

function page({ title, bodyHtml, slug, sourcePath }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Blaeu — a plugin-first geospatial editing kernel in TypeScript, with Turkish cadastral coordinate reference systems built in.">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  ${navHtml(slug)}
  <main>
${bodyHtml}
    <div class="foot">
      <a href="${BLOB}/${sourcePath}">Edit this page on GitHub</a> — this site is generated
      from <code>${escapeHtml(sourcePath)}</code>, which is the source of truth.
    </div>
  </main>
</div>
</body>
</html>
`
}

mkdirSync(out, { recursive: true })

let count = 0
function build(sourcePath, slug, title) {
  const md = readFileSync(join(root, sourcePath), 'utf8')
  const fromDir = dirname(sourcePath) === '.' ? '' : dirname(sourcePath)
  const bodyHtml = render(md, fromDir)
  writeFileSync(join(out, `${slug}.html`), page({ title, bodyHtml, slug, sourcePath }))
  count++
}

for (const p of PAGES) {
  build(
    p.src,
    p.slug,
    p.slug === 'index' ? 'Blaeu — a geospatial editing kernel' : `${p.nav} — Blaeu`,
  )
}
for (const a of ADR_FILES) {
  build(
    `docs/adr/${a}.md`,
    `adr-${a}`,
    `${a.replace(/^(\d+)-/, 'ADR $1 — ').replace(/-/g, ' ')} — Blaeu`,
  )
}

// Tell GitHub Pages not to run the output through Jekyll, which would otherwise
// swallow any file or directory beginning with an underscore.
writeFileSync(join(out, '.nojekyll'), '')

// A social-preview image, if one has been committed, is served from the site too so
// the meta tags on this page and the repo card can point at the same file.
const preview = join(root, 'docs', 'assets', 'social-preview.png')
if (existsSync(preview)) {
  mkdirSync(join(out, 'assets'), { recursive: true })
  cpSync(preview, join(out, 'assets', 'social-preview.png'))
}

console.log(`✓ ${count} pages written to site/`)
