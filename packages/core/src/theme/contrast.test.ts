/**
 * The contrast claim, made mechanical.
 *
 * `twitter.ts` opens with "every text pair and every on-map mark in all three has a
 * computed contrast on file". That was true and it was unenforced: the file was the
 * source file, the computation was a `//` comment, and a comment does not fail. This
 * suite recomputes every pair the shipped code actually paints, asserts the floor that
 * pair answers to, and renders `docs/contrast.md` from the results — so the claim now
 * breaks a build instead of quietly ageing.
 *
 * Three things it deliberately does *not* do:
 *
 * - It does not demand 4.5:1 everywhere. `accent` on `canvas` is exactly 3.00:1 in the
 *   Twitter light palette and that is the deliberate, documented choice this file exists
 *   to protect, not a defect to flatten.
 * - It does not adjust a colour to make a number pass. Pairs that sit below their floor
 *   are pinned in `RECORDED_BELOW_FLOOR` at the ratio they actually have, and published
 *   in `docs/contrast.md` as failures.
 * - It does not trust its own arithmetic. The first test checks it against published
 *   reference values before any theme is measured.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  ADVISORY_PAIRS,
  AUDITED_THEMES,
  CONTRAST_RULES,
  UNCONSUMED_TOKENS,
  auditTheme,
  contrastRatio,
  floorFor,
  measure,
  relativeLuminance,
  renderContrastDoc,
} from './contrast.js'
import { defaultTheme } from './defaultTheme.js'
import { twitterBlack, twitterDim, twitterLight } from './themes/index.js'
import type { ColorToken } from './contrast.js'

/**
 * Pairs that do not clear their floor today, at the ratio they actually have.
 *
 * A ratchet, in the shape `stryker.config.json` already uses: the number may not get
 * worse, and if it gets better the test fails and asks for the row to be deleted. What it
 * is not is a waiver — every one of these is printed in `docs/contrast.md` under "Below
 * the floor", with the call site that paints it.
 *
 * They are not seven separate mistakes. Eighteen of the twenty-five are `hover`, a token
 * chosen as a bright on-map highlight and then reused by `plugin-ui` as the background of
 * a control that keeps `color: inherit` — one token doing two incompatible jobs. Six more
 * are `border` against `canvas`, which is the only thing separating the scale bar from
 * the map.
 */
const RECORDED_BELOW_FLOOR: readonly {
  readonly theme: string
  readonly foreground: ColorToken
  readonly background: ColorToken
  readonly ratio: number
}[] = [
  { theme: 'blaeu-default', foreground: 'textMuted', background: 'surfaceMuted', ratio: 4.34 },
  { theme: 'blaeu-default', foreground: 'error', background: 'hover', ratio: 1.9 },
  { theme: 'blaeu-default', foreground: 'warning', background: 'hover', ratio: 1.25 },
  { theme: 'blaeu-default', foreground: 'border', background: 'canvas', ratio: 1.43 },
  { theme: 'twitter-light', foreground: 'error', background: 'hover', ratio: 1.31 },
  { theme: 'twitter-light', foreground: 'warning', background: 'hover', ratio: 1.28 },
  { theme: 'twitter-light', foreground: 'border', background: 'canvas', ratio: 1.44 },
  { theme: 'twitter-dim', foreground: 'text', background: 'hover', ratio: 2.26 },
  { theme: 'twitter-dim', foreground: 'error', background: 'hover', ratio: 1.16 },
  { theme: 'twitter-dim', foreground: 'warning', background: 'hover', ratio: 1.67 },
  { theme: 'twitter-dim', foreground: 'border', background: 'canvas', ratio: 1.65 },
  { theme: 'twitter-black', foreground: 'text', background: 'hover', ratio: 1.96 },
  { theme: 'twitter-black', foreground: 'error', background: 'hover', ratio: 1.16 },
  { theme: 'twitter-black', foreground: 'warning', background: 'hover', ratio: 1.67 },
  { theme: 'twitter-black', foreground: 'border', background: 'canvas', ratio: 1.65 },
  { theme: 'survey-paper', foreground: 'error', background: 'hover', ratio: 2.29 },
  { theme: 'survey-paper', foreground: 'warning', background: 'hover', ratio: 2.09 },
  { theme: 'survey-paper', foreground: 'border', background: 'canvas', ratio: 1.46 },
  { theme: 'high-contrast', foreground: 'text', background: 'hover', ratio: 4.08 },
  { theme: 'high-contrast', foreground: 'error', background: 'hover', ratio: 1.87 },
  { theme: 'high-contrast', foreground: 'warning', background: 'hover', ratio: 1.83 },
  { theme: 'imagery-dark', foreground: 'text', background: 'hover', ratio: 2.02 },
  { theme: 'imagery-dark', foreground: 'error', background: 'hover', ratio: 1.27 },
  { theme: 'imagery-dark', foreground: 'warning', background: 'hover', ratio: 1.67 },
  { theme: 'imagery-dark', foreground: 'border', background: 'canvas', ratio: 1.54 },
]

function recordedFor(
  themeId: string,
  foreground: ColorToken,
  background: ColorToken,
): number | undefined {
  return RECORDED_BELOW_FLOOR.find(
    (r) => r.theme === themeId && r.foreground === foreground && r.background === background,
  )?.ratio
}

describe('contrast — the arithmetic itself', () => {
  /**
   * An audit that is wrong and self-consistent is worse than no audit, because it reads
   * as proof. These are published values: the first two are the canonical greys either
   * side of AA on white, and the last two are the two numbers `twitter.ts` cites as X's
   * own failures — so if this suite can reproduce them, it is measuring what X measured.
   */
  it('reproduces published reference ratios', () => {
    expect(contrastRatio('#767676', '#FFFFFF')).toBe(4.54)
    expect(contrastRatio('#949494', '#FFFFFF')).toBe(3.03)
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21)
    expect(contrastRatio('#1D9BF0', '#FFFFFF')).toBe(3)
    expect(contrastRatio('#FFD400', '#FFFFFF')).toBe(1.43)
  })

  it('is symmetric, and a colour against itself is 1', () => {
    expect(contrastRatio('#1D9BF0', '#15202B')).toBe(contrastRatio('#15202B', '#1D9BF0'))
    expect(contrastRatio('#C2410C', '#C2410C')).toBe(1)
  })

  it('reads three-digit hex the same as six', () => {
    expect(relativeLuminance('#fff')).toBe(relativeLuminance('#ffffff'))
    expect(contrastRatio('#000', '#fff')).toBe(21)
  })

  it('refuses a string that is not a colour, rather than returning a number', () => {
    expect(() => contrastRatio('rgb(0,0,0)', '#fff')).toThrow(/hex colour/)
    expect(() => relativeLuminance('#12345')).toThrow(/hex colour/)
  })
})

describe('contrast — every gated pair in every audited theme', () => {
  for (const theme of AUDITED_THEMES) {
    for (const rule of CONTRAST_RULES) {
      const floor = floorFor(rule.kind)
      const recorded = recordedFor(theme.id, rule.foreground, rule.background)
      const pair = `${rule.foreground} on ${rule.background}`

      if (recorded === undefined) {
        it(`${theme.id}: ${pair} clears ${floor}:1`, () => {
          expect(measure(theme, rule).ratio).toBeGreaterThanOrEqual(floor)
        })
        continue
      }

      // Pinned, both ways. Downward so the palette cannot quietly rot; upward so a fix
      // cannot land while the generated document still calls the pair a failure.
      it(`${theme.id}: ${pair} is recorded below ${floor}:1, at ${recorded}`, () => {
        const { ratio } = measure(theme, rule)
        expect(ratio).toBeGreaterThanOrEqual(recorded)
        expect(ratio).toBeLessThan(floor)
      })
    }
  }
})

describe('contrast — the three corrections the Twitter palette makes to X', () => {
  /**
   * X's most-cited failure, and the reason `accentStrong` exists at all. The vivid blue
   * is *kept* — it is a map mark, and 3:1 is the floor for a graphic — and the filled
   * control reads a different token. A test that demanded 4.5:1 of `accent` would delete
   * exactly the nuance this palette was written to capture.
   */
  it('keeps #1D9BF0 at 3.00:1 as a mark, and puts the button label on accentStrong instead', () => {
    expect(twitterLight.tokens.color.accent).toBe('#1D9BF0')
    expect(contrastRatio(twitterLight.tokens.color.accent, twitterLight.tokens.color.canvas)).toBe(
      3,
    )

    // …and the pair that actually carries text clears the text floor, in all three.
    for (const theme of [twitterLight, twitterDim, twitterBlack]) {
      const { color } = theme.tokens
      expect(contrastRatio(color.onAccent, color.accentStrong)).toBeGreaterThanOrEqual(4.5)
      expect(color.accentStrong).not.toBe(color.accent)
    }
  })

  /**
   * X's snap yellow is 1.43:1 on white — invisible. The light theme deepens it; the two
   * dark themes keep it, because on their grounds the same yellow is 11:1 and 14:1.
   */
  it('deepens the snap yellow on the light ground and keeps it on the dark ones', () => {
    const X_SNAP_YELLOW = '#FFD400'

    expect(twitterLight.tokens.color.snapIndicator).not.toBe(X_SNAP_YELLOW)
    expect(contrastRatio(X_SNAP_YELLOW, twitterLight.tokens.color.canvas)).toBeLessThan(3)

    for (const theme of [twitterDim, twitterBlack]) {
      expect(theme.tokens.color.snapIndicator).toBe(X_SNAP_YELLOW)
      expect(
        contrastRatio(theme.tokens.color.snapIndicator, theme.tokens.color.canvas),
      ).toBeGreaterThanOrEqual(3)
    }

    // The indicator is also the tooltip's background, and `surface` is its label — so it
    // owes 4.5:1 in every one of the three, which is why the light one had to be deepened.
    for (const theme of [twitterLight, twitterDim, twitterBlack]) {
      const { color } = theme.tokens
      expect(contrastRatio(color.surface, color.snapIndicator)).toBeGreaterThanOrEqual(4.5)
    }
  })

  /** X's own Lights-out muted grey fails on the panel; this palette's does not. */
  it('lifts the lights-out muted text above 4.5:1, where X’s #71767B falls short', () => {
    const { color } = twitterBlack.tokens
    // The exact number the header comment cites for X's own grey, on X's own panel.
    expect(contrastRatio('#71767B', color.surfaceMuted)).toBe(3.88)
    expect(contrastRatio(color.textMuted, color.surfaceMuted)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('contrast — the audit covers the token set', () => {
  /**
   * The rule that keeps this suite from rotting. Add a colour token and it must be given
   * a gated pair, an advisory pair, or a place on the unconsumed list — the alternative
   * is a token nobody has thought about, which is how `accentMuted` and `success` came to
   * be hand-tuned for contrast in five files for a consumer that does not exist.
   */
  it('accounts for every colour token, as gated, advisory, or unconsumed', () => {
    const accountedFor = new Set<string>([
      ...CONTRAST_RULES.flatMap((r) => [r.foreground, r.background]),
      ...ADVISORY_PAIRS.flatMap((r) => [r.foreground, r.background]),
      ...UNCONSUMED_TOKENS,
    ])

    const unaccounted = Object.keys(defaultTheme.tokens.color).filter((t) => !accountedFor.has(t))
    expect(unaccounted).toEqual([])
  })

  it('audits the default theme as well as every registered one', () => {
    // `buildTheme` patches `defaultTheme`, so a token a theme does not re-tint *is* the
    // default's. Auditing the six without the seventh would leave the inherited half of
    // every palette unmeasured.
    expect(AUDITED_THEMES.map((t) => t.id)).toContain('blaeu-default')
    expect(AUDITED_THEMES).toHaveLength(7)
  })

  it('measures a rule for every theme, and every rule cites a call site', () => {
    for (const theme of AUDITED_THEMES) {
      expect(auditTheme(theme)).toHaveLength(CONTRAST_RULES.length)
    }
    for (const rule of [...CONTRAST_RULES, ...ADVISORY_PAIRS]) {
      expect(rule.where).toMatch(/\.ts:\d/)
    }
  })
})

/**
 * Every `// 4.67:1` annotation in the two theme files, parsed out of the source and
 * recomputed.
 *
 * The generated document is the authority, but the annotations are what a reader of
 * `twitter.ts` actually sees, and they were the original claim: "every text pair and every
 * on-map mark in all three has a computed contrast on file". Leaving them unchecked would
 * re-open the exact hole this suite was written to close, one file to the left.
 *
 * The shape recognised is `token: '#hex', // … N.NN:1 …`. Prose comments that mention a
 * ratio in passing — `defaultTheme.ts` recalls a colour that "was 2.15:1" before it was
 * replaced — are deliberately not parsed: a historical number is not a claim about the
 * value on the line.
 */
describe('contrast — the ratios written in the theme sources', () => {
  interface Claim {
    readonly themeId: string
    readonly token: string
    readonly hex: string
    readonly claimed: number
  }

  function claims(): readonly Claim[] {
    const found: Claim[] = []
    for (const file of ['./themes/twitter.ts', './themes/professional.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      for (const chunk of source.split('export const').slice(1)) {
        const themeId = /id:\s*'([^']+)'/.exec(chunk)?.[1]
        if (themeId === undefined) continue
        for (const line of chunk.matchAll(/^\s*(\w+):\s*'(#[0-9a-fA-F]{3,8})',\s*\/\/\s*(.*)$/gm)) {
          const ratio = /(\d+(?:\.\d+)?):1/.exec(line[3] ?? '')
          if (ratio === null) continue
          found.push({
            themeId,
            token: line[1] as string,
            hex: line[2] as string,
            claimed: Number.parseFloat(ratio[1] as string),
          })
        }
      }
    }
    return found
  }

  /**
   * A parser that silently matches nothing would pass this suite while checking none of
   * it. Pinning the count is what makes the other test mean something — and it is the same
   * reason `check-doc-fences.mjs` prints how many fences it skipped.
   */
  it('finds every annotation it should, and the count is pinned', () => {
    expect(claims()).toHaveLength(43)
  })

  it.each(claims())(
    '$themeId: the $token comment claims $claimed:1, and $claimed:1 is what it is',
    ({ themeId, token, hex, claimed }) => {
      const theme = AUDITED_THEMES.find((t) => t.id === themeId)
      expect(theme, `no such theme: ${themeId}`).toBeDefined()
      const { color } = theme!.tokens

      // `accentStrong` and `onAccent` annotate each other — the number on either line is
      // the label against the fill. Every other token is annotated against one of the
      // three grounds a theme has.
      const candidates =
        token === 'accentStrong' || token === 'onAccent'
          ? [contrastRatio(color.onAccent, color.accentStrong)]
          : [
              contrastRatio(hex, color.canvas),
              contrastRatio(hex, color.surface),
              contrastRatio(hex, color.surfaceMuted),
            ]

      expect(
        candidates.some((r) => Math.abs(r - claimed) < 0.005),
        `${token} (${hex}) claims ${claimed}:1, but against this theme's own grounds it is ${candidates.join(' / ')}`,
      ).toBe(true)
    },
  )
})

describe('contrast — the generated document', () => {
  /**
   * The committed table and a fresh run must agree. In CI this cannot self-heal — vitest
   * refuses to write a file snapshot there — so a re-tinted token that does not carry its
   * number into `docs/contrast.md` fails the build. Regenerate with `npx vitest run -u`.
   */
  it('matches docs/contrast.md', async () => {
    await expect(renderContrastDoc()).toMatchFileSnapshot('../../../../docs/contrast.md')
  })
})
