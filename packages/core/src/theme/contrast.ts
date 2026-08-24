import { defaultTheme } from './defaultTheme.js'
import { builtinThemes } from './themes/index.js'
import type { Theme, ThemeTokens } from '../types/theme.js'

/**
 * WCAG contrast, computed rather than commented.
 *
 * `twitter.ts` opens by claiming that "every text pair and every on-map mark in all
 * three has a computed contrast on file". Until this module existed, the file on which
 * they were computed was the source file itself, in `//` comments — and a comment does
 * not fail. Every number in those comments turned out to be right but one, which is
 * exactly the hit rate you would expect from arithmetic nobody re-runs.
 *
 * This module is not exported from the package. It exists for `contrast.test.ts`, which
 * asserts the floors and renders `docs/contrast.md` from the results — the same shape as
 * `store/test-crs.ts`, a helper that lives in `src/` because the thing it supports is a
 * test, not because it ships.
 *
 * **The rules are derived from call sites, not from the token names.** That distinction
 * is the whole design. A blanket "every pair clears 4.5:1" would fail `accent` against
 * `canvas` at 3.00:1 — which is not a defect but the *point* of the Twitter palette, a
 * colour deliberately kept vivid because it is a mark on a map and 3:1 is the floor for
 * a graphic. Equally it would pass `hover`, because nothing about the name says the
 * chrome puts body text on it. So each rule below cites the file and line that makes
 * the pair real, and the floor follows from what that line draws.
 */

/** A colour token name — the key half of `ThemeTokens['color']`. */
export type ColorToken = keyof ThemeTokens['color']

/**
 * Which WCAG floor a pair answers to.
 *
 * `text` is 1.4.3 Contrast (Minimum) at 4.5:1 — every text pair here is normal-size, and
 * the two smallest (the attribution and the snap tooltip, both 11 px) are emphatically
 * not "large text", which starts at 18 pt / 14 pt bold.
 *
 * `non-text` is 1.4.11 Non-text Contrast at 3:1 — a graphic that carries information, or
 * the visual boundary of a control.
 */
export type ContrastKind = 'text' | 'non-text'

export const TEXT_FLOOR = 4.5
export const NON_TEXT_FLOOR = 3

export interface ContrastRule {
  readonly foreground: ColorToken
  readonly background: ColorToken
  readonly kind: ContrastKind
  /** The call site that makes this pair real. Without one, there is no rule. */
  readonly where: string
}

/**
 * Every pair the shipped code actually paints, and nothing else.
 *
 * Ordered text-first, then non-text, and within each in the order a reader meets them:
 * the chrome, then the map.
 */
export const CONTRAST_RULES: readonly ContrastRule[] = [
  {
    foreground: 'text',
    background: 'surface',
    kind: 'text',
    where:
      'plugin-ui/src/styles.ts:31 on :57 — every control inherits this colour, on a surface panel',
  },
  {
    foreground: 'text',
    background: 'hover',
    kind: 'text',
    where:
      'plugin-ui/src/styles.ts:99,224 — the button and issue-row hover fill; the label keeps `color: inherit`',
  },
  {
    foreground: 'textMuted',
    background: 'surface',
    kind: 'text',
    where: 'plugin-ui/src/styles.ts:129,242 — the empty readout and the status line',
  },
  {
    foreground: 'textMuted',
    background: 'surfaceMuted',
    kind: 'text',
    where: 'plugin-ui/src/styles.ts:158-160 — the attribution, at 11 px',
  },
  {
    foreground: 'onAccent',
    background: 'accentStrong',
    kind: 'text',
    where: 'plugin-ui/src/styles.ts:108-111 — the label on a pressed toolbar button',
  },
  {
    foreground: 'surface',
    background: 'snapIndicator',
    kind: 'text',
    where:
      'plugin-ui/src/styles.ts:174-176 — the snap tooltip; its label is `surface`, not `onAccent`',
  },
  {
    foreground: 'text',
    background: 'labelHalo',
    kind: 'text',
    where: 'preset-cadastre/src/layers.ts:50-52 — the parcel-number labels against their halo',
  },
  {
    foreground: 'accent',
    background: 'canvas',
    kind: 'non-text',
    where:
      'plugin-draw/src/preview.ts:37-38, plugin-measure/src/layers.ts:60-62, preset-cadastre/src/layers.ts:16-25 — the draft outline, the measure line, the parcel line',
  },
  {
    foreground: 'accent',
    background: 'surface',
    kind: 'non-text',
    where: 'plugin-ui/src/styles.ts:66 — the 2 px focus ring; :227 — the 3 px info stripe',
  },
  {
    foreground: 'selection',
    background: 'canvas',
    kind: 'non-text',
    where: 'plugin-select/src/overlay.ts:128-143 — the selection fill, its outline, and the lasso',
  },
  {
    foreground: 'vertexActive',
    background: 'canvas',
    kind: 'non-text',
    where:
      'plugin-edit/src/handles.ts:228,241 — the stroke that bounds both handles; `vertex` and `midpoint` are fills inside it',
  },
  {
    foreground: 'snapIndicator',
    background: 'canvas',
    kind: 'non-text',
    where: 'plugin-snap/src/indicator.ts:101 — the snap ring',
  },
  {
    foreground: 'guide',
    background: 'canvas',
    kind: 'non-text',
    where: 'plugin-edit/src/handles.ts:251 — the alignment guide, at 0.9 alpha',
  },
  {
    foreground: 'error',
    background: 'surface',
    kind: 'non-text',
    where: 'plugin-ui/src/styles.ts:225 on :191 — the 3 px severity stripe on the issue panel',
  },
  {
    foreground: 'error',
    background: 'hover',
    kind: 'non-text',
    where: 'plugin-ui/src/styles.ts:224-225 — the same stripe, on a hovered row',
  },
  {
    foreground: 'warning',
    background: 'surface',
    kind: 'non-text',
    where: 'plugin-ui/src/styles.ts:226 on :191 — the 3 px severity stripe',
  },
  {
    foreground: 'warning',
    background: 'hover',
    kind: 'non-text',
    where: 'plugin-ui/src/styles.ts:224,226 — the same stripe, on a hovered row',
  },
  {
    foreground: 'border',
    background: 'canvas',
    kind: 'non-text',
    where:
      "plugin-ui/src/styles.ts:143 — the scale bar's only boundary: it carries no `.bl-ui-control` class (ScaleBar.ts:34) and so no box-shadow",
  },
]

/**
 * Pairs that are measured and printed but not gated, each with the reason it is not.
 *
 * A pair with no rule is a pair nobody has thought about. A pair on this list is one
 * somebody has, which is why the reason is stored next to it rather than left implicit
 * in the absence of a rule.
 */
export const ADVISORY_PAIRS: readonly (ContrastRule & { readonly reason: string })[] = [
  {
    foreground: 'vertexActive',
    background: 'vertex',
    kind: 'non-text',
    where: 'plugin-edit/src/handles.ts:226-229 — a 2 px ring around a white disc',
    reason:
      'A handle is perceivable because its ring clears 3:1 against the ground, which is gated above. How much the ring differs from its own fill is a legibility judgement, not a WCAG floor.',
  },
  {
    foreground: 'vertexActive',
    background: 'midpoint',
    kind: 'non-text',
    where: 'plugin-edit/src/handles.ts:239-242 — a 1 px ring, the thinnest boundary in the system',
    reason: 'Same as above, and worth watching: this is the pair that runs lowest.',
  },
  {
    foreground: 'accent',
    background: 'vertex',
    kind: 'non-text',
    where:
      'plugin-draw/src/preview.ts:39-44, plugin-measure/src/layers.ts:69-74 — the draw and measure vertex stroke',
    reason: 'Same as above.',
  },
  {
    foreground: 'surface',
    background: 'canvas',
    kind: 'non-text',
    where: 'plugin-ui/src/styles.ts:57 — a panel floating over the map',
    reason:
      'Every shipped theme sits a panel within ~1.2:1 of its own ground, deliberately: the chrome is meant to recede. That is precisely why `border` on `canvas` is gated instead.',
  },
  {
    foreground: 'surfaceMuted',
    background: 'canvas',
    kind: 'non-text',
    where: 'plugin-ui/src/styles.ts:158 — the attribution, which has neither border nor shadow',
    reason:
      'Same, with a sharper edge: the attribution has no boundary at all, so nothing here can carry 3:1. Recorded so the number is on file.',
  },
  {
    foreground: 'labelHalo',
    background: 'canvas',
    kind: 'non-text',
    where: 'preset-cadastre/src/layers.ts:51 — the halo behind an on-map label',
    reason:
      'A halo does its job by matching the ground, not by contrasting with it. Near 1:1 is correct here, and a high number would be the bug.',
  },
]

/** Tokens no package reads, anywhere under `packages`, so no rule can be derived. */
export const UNCONSUMED_TOKENS: readonly ColorToken[] = ['accentMuted', 'success']

/**
 * The sRGB relative luminance of a `#rgb` or `#rrggbb` colour, per WCAG 2.2.
 *
 * The 0.04045 knee and the 2.4 exponent are the specification's, not sRGB's true
 * transfer function — they differ in the last decimal, and every contrast checker in the
 * world uses the specification's, so this does too.
 */
export function relativeLuminance(hex: string): number {
  const channels = parseHex(hex)
  const [r, g, b] = channels.map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The WCAG contrast ratio between two colours, rounded to two decimals.
 *
 * Rounded, and that is load-bearing rather than cosmetic: two decimals is what the
 * generated table publishes and what the theme comments claim, so comparing the rounded
 * value is the only way a row reading `4.50` can also read `ok`. It moves a handful of
 * pairs across the line in the generous direction, by at most 0.005.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
}

function parseHex(hex: string): readonly [number, number, number] {
  const body = hex.startsWith('#') ? hex.slice(1) : hex
  const full = body.length === 3 ? [...body].map((c) => `${c}${c}`).join('') : body
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not a hex colour this module can read: ${hex}`)
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

export interface ContrastMeasurement extends ContrastRule {
  readonly themeId: string
  readonly foregroundHex: string
  readonly backgroundHex: string
  readonly ratio: number
  readonly floor: number
  readonly passes: boolean
}

export function floorFor(kind: ContrastKind): number {
  return kind === 'text' ? TEXT_FLOOR : NON_TEXT_FLOOR
}

/** Measure one rule against one theme. */
export function measure(theme: Theme, rule: ContrastRule): ContrastMeasurement {
  const foregroundHex = theme.tokens.color[rule.foreground]
  const backgroundHex = theme.tokens.color[rule.background]
  const ratio = contrastRatio(foregroundHex, backgroundHex)
  const floor = floorFor(rule.kind)
  return {
    ...rule,
    themeId: theme.id,
    foregroundHex,
    backgroundHex,
    ratio,
    floor,
    passes: ratio >= floor,
  }
}

/** Every gated rule, measured against one theme. */
export function auditTheme(theme: Theme): readonly ContrastMeasurement[] {
  return CONTRAST_RULES.map((rule) => measure(theme, rule))
}

/**
 * The themes this audit covers: the default every map starts on, then the six the kernel
 * registers. `defaultTheme` is not in `builtinThemes` and has to be named separately —
 * and it is the one that matters most, because `buildTheme` patches it, so a token a
 * theme does not re-tint *is* the default's.
 *
 * The three preset themes (`preset-cadastre`, `preset-urban`, `preset-game`) are not
 * here. They are applied through `theme.set()` rather than registered, they live in
 * packages that `@blaeu/core` may not import, and gating them needs a test in each of
 * those packages. That is a real gap, and it is stated in `docs/contrast.md` rather than
 * left to be inferred from a short list.
 */
export const AUDITED_THEMES: readonly Theme[] = [defaultTheme, ...builtinThemes]

/* ------------------------------------------------------------------------- *
 * Rendering docs/contrast.md
 * ------------------------------------------------------------------------- */

/**
 * Pad a table exactly the way Prettier would.
 *
 * Not a nicety: `npm run format:check` is its own CI step, `docs/` is not ignored, and a
 * generated file that Prettier wants to reformat fails the build every time. So the
 * generator produces Prettier's output directly — every cell padded to the widest in its
 * column, the delimiter row matching, a minimum of three dashes.
 */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, i) =>
    Math.max(3, cell.length, ...rows.map((row) => (row[i] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(' | ')} |`
  return [
    line(header),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map((row) => line(row)),
  ].join('\n')
}

const pairLabel = (rule: ContrastRule): string => `\`${rule.foreground}\` on \`${rule.background}\``

/**
 * Render the whole audit as the document committed at `docs/contrast.md`.
 *
 * The prose here is about *method* and does not move when a colour does; everything that
 * states a number is generated. That split is what lets the file be regenerated without
 * a human re-reading it, and it is why there is no "current findings" paragraph — the
 * findings are the tables.
 */
export function renderContrastDoc(): string {
  const audits = AUDITED_THEMES.map((theme) => ({ theme, results: auditTheme(theme) }))
  const total = audits.reduce((n, a) => n + a.results.length, 0)
  const below = audits.flatMap((a) => a.results.filter((r) => !r.passes))

  const out: string[] = []

  out.push('# Contrast')
  out.push('')
  out.push(
    'Generated. Do not edit — `packages/core/src/theme/contrast.test.ts` writes this file, and',
  )
  out.push('fails if the committed copy and a fresh run disagree, so a re-tinted token cannot land')
  out.push('without the number moving here too. Regenerate with `npx vitest run -u`.')
  out.push('')
  out.push(
    'Every ratio is WCAG 2.2 relative luminance over sRGB, rounded to two decimals, computed',
  )
  out.push('from the token values themselves. The arithmetic is checked in the same test against')
  out.push(
    'published reference values (`#767676` on white is 4.54:1; `#949494` on white is 3.03:1)',
  )
  out.push('so the audit cannot be wrong and self-consistent at once.')
  out.push('')
  out.push('## What is gated, and why each pair')
  out.push('')
  out.push('A pair is gated when the shipped code paints it. The floor follows from what that line')
  out.push(
    'draws — 4.5:1 for text (WCAG 1.4.3), 3:1 for a graphic or a control boundary (1.4.11) —',
  )
  out.push('and never from the token name.')
  out.push('')
  out.push('This is the part a blanket rule gets wrong in both directions. `accent` on `canvas` is')
  out.push('exactly 3.00:1 in the Twitter light palette: a blanket 4.5:1 would call the deliberate')
  out.push(
    'choice a defect, when the vivid blue is kept precisely because it is a mark on a map. And',
  )
  out.push('nothing in the name `hover` suggests the toolbar puts body text on it, which it does.')
  out.push('')
  out.push(
    table(
      ['Pair', 'Floor', 'Where it is painted'],
      CONTRAST_RULES.map((rule) => [
        pairLabel(rule),
        `${floorFor(rule.kind).toFixed(1)}:1`,
        rule.where,
      ]),
    ),
  )
  out.push('')
  out.push('## Summary')
  out.push('')
  out.push(
    table(
      ['Theme', 'Scheme', 'Pairs', 'At or above floor', 'Below floor'],
      audits.map(({ theme, results }) => [
        `\`${theme.id}\``,
        theme.scheme,
        String(results.length),
        String(results.filter((r) => r.passes).length),
        String(results.filter((r) => !r.passes).length),
      ]),
    ),
  )
  out.push('')
  out.push(
    `${total} gated pairs across ${audits.length} themes: ${total - below.length} at or above their floor, ${below.length} below.`,
  )
  out.push('')

  for (const { theme, results } of audits) {
    out.push(`## \`${theme.id}\``)
    out.push('')
    out.push(
      table(
        ['Pair', 'Colours', 'Ratio', 'Floor', ''],
        results.map((r) => [
          pairLabel(r),
          `${r.foregroundHex} on ${r.backgroundHex}`,
          r.ratio.toFixed(2),
          r.floor.toFixed(1),
          r.passes ? 'ok' : 'BELOW',
        ]),
      ),
    )
    out.push('')
  }

  out.push('## Below the floor')
  out.push('')
  if (below.length === 0) {
    out.push('Nothing. Every gated pair in every audited theme clears its floor.')
    out.push('')
  } else {
    out.push(
      'Grouped by rule, because these do not scatter — a pair that fails tends to fail in most',
    )
    out.push(
      'themes at once, and that is the signal. A rule failing everywhere is one token doing a',
    )
    out.push('job it was not chosen for, not seven separate mistakes.')
    out.push('')
    for (const rule of CONTRAST_RULES) {
      const hits = below.filter(
        (r) => r.foreground === rule.foreground && r.background === rule.background,
      )
      if (hits.length === 0) continue
      out.push(`### ${pairLabel(rule)} — needs ${floorFor(rule.kind).toFixed(1)}:1`)
      out.push('')
      out.push(rule.where)
      out.push('')
      out.push(
        table(
          ['Theme', 'Colours', 'Ratio'],
          hits.map((r) => [
            `\`${r.themeId}\``,
            `${r.foregroundHex} on ${r.backgroundHex}`,
            r.ratio.toFixed(2),
          ]),
        ),
      )
      out.push('')
    }
    out.push(
      'These are recorded, not waived. `contrast.test.ts` pins every one of them to the exact',
    )
    out.push(
      'ratio above: the number may not get worse, and if it gets better the test fails and asks',
    )
    out.push(
      'for the pair to be promoted out of the list. The same ratchet `stryker.config.json` uses',
    )
    out.push('on the mutation score.')
    out.push('')
  }

  out.push('## Measured but not gated')
  out.push('')
  out.push(
    'A pair with no rule is a pair nobody has thought about; a pair here is one somebody has.',
  )
  out.push('')
  for (const pair of ADVISORY_PAIRS) {
    out.push(`### ${pairLabel(pair)}`)
    out.push('')
    out.push(`${pair.where}.`)
    out.push('')
    out.push(pair.reason)
    out.push('')
    out.push(
      table(
        ['Theme', 'Colours', 'Ratio'],
        AUDITED_THEMES.map((theme) => {
          const m = measure(theme, pair)
          return [`\`${theme.id}\``, `${m.foregroundHex} on ${m.backgroundHex}`, m.ratio.toFixed(2)]
        }),
      ),
    )
    out.push('')
  }

  out.push('## Tokens with no rule at all')
  out.push('')
  out.push(
    `${UNCONSUMED_TOKENS.map((t) => `\`${t}\``).join(' and ')} are declared in \`ThemeTokens\`, given a value by`,
  )
  out.push(
    'every theme, mirrored to a CSS custom property — and read by nothing in `packages/*/src`.',
  )
  out.push(
    'There is no call site, so there is no pair, so there is no floor. Several themes carry a',
  )
  out.push('hand-computed ratio in a comment for `success`, which is arithmetic performed for a')
  out.push('consumer that does not exist.')
  out.push('')
  out.push('## What this document does not cover')
  out.push('')
  out.push('The three preset themes — `preset-cadastre`, `preset-urban`, `preset-game` — are not')
  out.push(
    'audited. They are applied through `theme.set()` rather than registered, and they live in',
  )
  out.push(
    'packages `@blaeu/core` may not import, so gating them needs a test inside each of those',
  )
  out.push('packages. Nothing checks their contrast today.')
  out.push('')
  out.push('Opacity is not modelled either. Several of the gated marks are painted with a fill')
  out.push(
    'opacity — the selection fill at 0.25, the parcel fill at 0.08 — and the ratios here are',
  )
  out.push(
    'for the token at full strength, which is what the accompanying line or outline is drawn',
  )
  out.push('at. A composited fill over an unknown basemap has no single ratio to compute.')

  return `${out.join('\n')}\n`
}
