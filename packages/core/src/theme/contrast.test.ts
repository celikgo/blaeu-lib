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
import { readFileSync, statSync } from 'node:fs'
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
 * Pinned as an **equality**, not as a one-way ratchet. An earlier version asserted only
 * `>= recorded` and `< floor`, which let a colour improve by 73% inside that band and
 * still pass — leaving the number on file quietly wrong, which is precisely the failure
 * mode this suite exists to close. The list is also asserted to be *exactly* the set of
 * pairs below their floor, so a row cannot go stale and a new failure cannot go
 * unrecorded.
 *
 * What it is not is a waiver — every one of these is printed in `docs/contrast.md` under
 * "Below the floor", with the call site that paints it.
 *
 * They are not thirty-six separate mistakes. **Twenty-nine of the thirty-six share one
 * background:** `hover`, a token chosen as a bright on-map highlight and then reused by
 * `plugin-ui` as the fill behind controls that keep `color: inherit` — one token doing two
 * incompatible jobs, and no single value satisfies both. Six more are `border` against
 * `canvas`, the only thing separating the scale bar and the status line from the map. That
 * leaves exactly one pair that is its own isolated near-miss.
 */
const RECORDED_BELOW_FLOOR: readonly {
  readonly theme: string
  readonly foreground: ColorToken
  readonly background: ColorToken
  readonly ratio: number
}[] = [
  { theme: 'blaeu-default', foreground: 'textMuted', background: 'surfaceMuted', ratio: 4.34 },
  { theme: 'blaeu-default', foreground: 'onAccent', background: 'hover', ratio: 2.54 },
  { theme: 'blaeu-default', foreground: 'error', background: 'hover', ratio: 1.9 },
  { theme: 'blaeu-default', foreground: 'accent', background: 'hover', ratio: 2.03 },
  { theme: 'blaeu-default', foreground: 'warning', background: 'hover', ratio: 1.25 },
  { theme: 'blaeu-default', foreground: 'border', background: 'canvas', ratio: 1.43 },
  { theme: 'twitter-light', foreground: 'onAccent', background: 'hover', ratio: 3.84 },
  { theme: 'twitter-light', foreground: 'error', background: 'hover', ratio: 1.31 },
  { theme: 'twitter-light', foreground: 'accent', background: 'hover', ratio: 1.28 },
  { theme: 'twitter-light', foreground: 'warning', background: 'hover', ratio: 1.28 },
  { theme: 'twitter-light', foreground: 'border', background: 'canvas', ratio: 1.44 },
  { theme: 'twitter-dim', foreground: 'text', background: 'hover', ratio: 2.26 },
  { theme: 'twitter-dim', foreground: 'onAccent', background: 'hover', ratio: 2.39 },
  { theme: 'twitter-dim', foreground: 'error', background: 'hover', ratio: 1.16 },
  { theme: 'twitter-dim', foreground: 'accent', background: 'hover', ratio: 1.26 },
  { theme: 'twitter-dim', foreground: 'warning', background: 'hover', ratio: 1.67 },
  { theme: 'twitter-dim', foreground: 'border', background: 'canvas', ratio: 1.65 },
  { theme: 'twitter-black', foreground: 'text', background: 'hover', ratio: 1.96 },
  { theme: 'twitter-black', foreground: 'onAccent', background: 'hover', ratio: 2.39 },
  { theme: 'twitter-black', foreground: 'error', background: 'hover', ratio: 1.16 },
  { theme: 'twitter-black', foreground: 'accent', background: 'hover', ratio: 1.26 },
  { theme: 'twitter-black', foreground: 'warning', background: 'hover', ratio: 1.67 },
  { theme: 'twitter-black', foreground: 'border', background: 'canvas', ratio: 1.65 },
  { theme: 'survey-paper', foreground: 'onAccent', background: 'hover', ratio: 2.62 },
  { theme: 'survey-paper', foreground: 'error', background: 'hover', ratio: 2.29 },
  { theme: 'survey-paper', foreground: 'warning', background: 'hover', ratio: 2.09 },
  { theme: 'survey-paper', foreground: 'border', background: 'canvas', ratio: 1.46 },
  { theme: 'high-contrast', foreground: 'text', background: 'hover', ratio: 4.08 },
  { theme: 'high-contrast', foreground: 'error', background: 'hover', ratio: 1.87 },
  { theme: 'high-contrast', foreground: 'accent', background: 'hover', ratio: 1.95 },
  { theme: 'high-contrast', foreground: 'warning', background: 'hover', ratio: 1.83 },
  { theme: 'imagery-dark', foreground: 'text', background: 'hover', ratio: 2.02 },
  { theme: 'imagery-dark', foreground: 'error', background: 'hover', ratio: 1.27 },
  { theme: 'imagery-dark', foreground: 'accent', background: 'hover', ratio: 1.37 },
  { theme: 'imagery-dark', foreground: 'warning', background: 'hover', ratio: 1.67 },
  { theme: 'imagery-dark', foreground: 'border', background: 'canvas', ratio: 1.54 },
]

const pairKey = (theme: string, foreground: string, background: string): string =>
  `${theme}: ${foreground} on ${background}`

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

      it(`${theme.id}: ${pair} is recorded below ${floor}:1, at exactly ${recorded}`, () => {
        expect(measure(theme, rule).ratio).toBe(recorded)
      })
    }
  }

  /**
   * The assertion that makes the list a ratchet rather than a note. Without it, a row
   * naming a pair that no longer fails is simply never consulted — `recordedFor` returns
   * `undefined`, the pair is asserted against its floor, and the stale row sits there
   * meaning nothing. A pair that *starts* failing would equally get no row at all.
   */
  it('records exactly the pairs that are below their floor, and no others', () => {
    const failing = AUDITED_THEMES.flatMap((theme) =>
      auditTheme(theme)
        .filter((m) => !m.passes)
        .map((m) => pairKey(m.themeId, m.foreground, m.background)),
    ).sort()
    const recorded = RECORDED_BELOW_FLOOR.map((r) =>
      pairKey(r.theme, r.foreground, r.background),
    ).sort()

    expect(recorded).toEqual(failing)
  })
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
    const light = twitterLight.tokens.color

    expect(contrastRatio(X_SNAP_YELLOW, light.canvas)).toBeLessThan(3)
    // "Deepens", literally: darker than X's, and clearing on the ground X's cannot.
    expect(relativeLuminance(light.snapIndicator)).toBeLessThan(relativeLuminance(X_SNAP_YELLOW))
    expect(contrastRatio(light.snapIndicator, light.canvas)).toBeGreaterThanOrEqual(3)

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
   * be hand-tuned for contrast in six files for a consumer that does not exist.
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

  it('audits the default theme as well as the six in builtinThemes', () => {
    // `buildTheme` patches `defaultTheme`, so a token a theme does not re-tint *is* the
    // default's. Auditing the six without the seventh would leave the inherited half of
    // every palette unmeasured.
    expect(AUDITED_THEMES.map((t) => t.id)).toContain('blaeu-default')
    expect(AUDITED_THEMES).toHaveLength(7)
  })

  it('measures the theme it is handed, not a fixed one', () => {
    // Deliberately not `expect(auditTheme(t)).toHaveLength(CONTRAST_RULES.length)`: that is
    // a `.map` over a constant, and is true however wrong `measure` is.
    const rule = CONTRAST_RULES.find((r) => r.foreground === 'accent' && r.background === 'canvas')
    expect(rule).toBeDefined()

    const light = measure(twitterLight, rule!)
    const dim = measure(twitterDim, rule!)

    expect(light.backgroundHex).toBe(twitterLight.tokens.color.canvas)
    expect(dim.backgroundHex).toBe(twitterDim.tokens.color.canvas)
    expect(light.ratio).not.toBe(dim.ratio)
  })

  /**
   * Citations are resolved, not merely shaped. A `where` string is the only evidence a rule
   * offers that it describes something real, and a check that it "matches `/\.ts:\d/`" is
   * satisfied by a file that does not exist — the same "a comment does not fail" hole this
   * module exists to close, one level up. Secondary references in parentheses
   * (`ScaleBar.ts:34`) carry no package path and are not resolved; every rule must carry at
   * least one citation that is.
   */
  it('cites call sites that exist, at line numbers those files actually have', () => {
    const packages = fileURLToPath(new URL('../../../', import.meta.url))

    for (const rule of [...CONTRAST_RULES, ...ADVISORY_PAIRS]) {
      const label = `${rule.foreground} on ${rule.background}`
      const cites = [...rule.where.matchAll(/([a-z][a-z0-9-]*\/src\/[A-Za-z0-9/_.-]*\.ts):(\d+)/g)]
      expect(cites.length, `${label} cites no resolvable call site`).toBeGreaterThan(0)

      for (const cite of cites) {
        const relative = cite[1] as string
        const line = Number(cite[2])
        const file = `${packages}${relative}`

        expect(() => statSync(file), `${label} cites a missing file: ${relative}`).not.toThrow()
        const source = readFileSync(file, 'utf8')
        const lines = source.split('\n').length
        expect(
          line,
          `${label} cites ${relative}:${line}, but that file has ${lines} lines`,
        ).toBeLessThanOrEqual(lines)

        // The cited file must at least name the token it is cited for, in one of the two
        // forms a consumer can read it: `color.accent` or `--bl-color-accent`.
        const kebab = rule.foreground.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
        expect(
          source.includes(`.${rule.foreground}`) || source.includes(`--bl-color-${kebab}`),
          `${label} cites ${relative}, which never mentions ${rule.foreground}`,
        ).toBe(true)
      }
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
    readonly comment: string
  }

  function claims(): readonly Claim[] {
    const found: Claim[] = []
    for (const file of ['./themes/twitter.ts', './themes/professional.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      for (const chunk of source.split('export const').slice(1)) {
        const themeId = /id:\s*'([^']+)'/.exec(chunk)?.[1]
        if (themeId === undefined) continue
        for (const line of chunk.matchAll(/^\s*(\w+):\s*'(#[0-9a-fA-F]{3,8})',\s*\/\/\s*(.*)$/gm)) {
          const comment = line[3] ?? ''
          const ratio = /(\d+(?:\.\d+)?):1/.exec(comment)
          if (ratio === null) continue
          found.push({
            themeId,
            token: line[1] as string,
            hex: line[2] as string,
            claimed: Number.parseFloat(ratio[1] as string),
            comment,
          })
        }
      }
    }
    return found
  }

  /**
   * A parser that silently matches nothing would pass this suite while checking none of
   * it — `it.each([])` in vitest generates zero tests and raises nothing at all. Pinning the
   * count is what makes the test below mean something, and it is the same reason
   * `check-doc-fences.mjs` prints how many fences it skipped.
   */
  it('finds every annotation it should, and the count is pinned', () => {
    expect(claims()).toHaveLength(43)
  })

  it.each(claims())(
    '$themeId: the $token comment claims $claimed:1, and $claimed:1 is what it is',
    ({ themeId, token, hex, claimed, comment }) => {
      const theme = AUDITED_THEMES.find((t) => t.id === themeId)
      expect(theme, `no such theme: ${themeId}`).toBeDefined()
      const { color } = theme!.tokens

      // `accentStrong` and `onAccent` annotate each other — the number on either line is
      // the label against the fill.
      if (token === 'accentStrong' || token === 'onAccent') {
        expect(contrastRatio(color.onAccent, color.accentStrong)).toBeCloseTo(claimed, 2)
        return
      }

      // Where the comment *names* its ground, that is the ground it is checked against.
      // Allowing any of the three would let a comment cite a true number measured
      // elsewhere — which is exactly the defect that was here: the light snap indicator
      // said "4.96:1 on white" when 4.96 is its ratio on survey-paper's off-white.
      const named = /panel grey/.test(comment)
        ? color.surfaceMuted
        : /on (?:white|black|paper|the (?:dim )?ground)/.test(comment)
          ? color.canvas
          : undefined

      if (named !== undefined) {
        expect(contrastRatio(hex, named)).toBeCloseTo(claimed, 2)
        return
      }

      const candidates = [
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
   * number into `docs/contrast.md` fails the build.
   *
   * Locally the asymmetry is worth knowing: a *missing* file is written rather than
   * reported, so deleting the document and getting a green run proves nothing. The run that
   * gates is CI's. Regenerate deliberately with `npx vitest run -u`.
   */
  it('matches docs/contrast.md', async () => {
    await expect(renderContrastDoc()).toMatchFileSnapshot('../../../../docs/contrast.md')
  })
})
