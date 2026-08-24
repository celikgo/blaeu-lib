---
name: blaeu-theming
description: How a Blaeu theme is composed — `buildTheme` as a patch over `defaultTheme`, the one token set that feeds both the map and the chrome, why the floor a colour owes comes from where it is painted rather than from its name, the three corrections the Twitter/X palettes make to X's own values, and the generated WCAG audit the suite diffs. Use when adding or re-tinting a theme, when adding a colour token, when `contrast.test.ts` or `docs/contrast.md` fails, or when a colour reads fine on one scheme and vanishes on the other.
---

# Theming

A theme here is not a stylesheet. It is one set of tokens that feeds the map
paint expressions and the DOM chrome at the same time, which is the only reason
the selection halo on the map is exactly the colour of the selected row in the
attribute table. Two files that agree today are not the same thing as one number
read twice.

The trap this surface has is specific: a colour is a value that always renders.
Nothing throws, nothing goes red, and a token that is invisible against the
ground it is drawn on looks exactly like a token that is fine — until it is on a
laptop in a field. Every mechanism below exists to turn that class of defect
into a failing test.

## A theme is a patch over `defaultTheme`

`buildTheme` takes a sparse draft and returns a complete theme. It enforces two
things rather than trusting each author with them:

```ts
import { buildTheme } from '@blaeu/core'
import type { BlaeuMap } from '@blaeu/core'

declare const map: BlaeuMap

const brand = buildTheme({
  id: 'acme',
  scheme: 'light',
  color: {
    canvas: '#ffffff',
    accent: '#7c3aed',
    accentStrong: '#5b21b6',
    onAccent: '#ffffff',
    // …only what you re-tint. The rest is inherited.
  },
})

map.theme.register(brand)
map.theme.use('acme')
```

**The flat basemap is painted the theme's own `canvas`.** A theme cannot ship a
dark palette and forget to darken the ground, because the ground _is_ the token
(`themes/build.ts:49`). That is what makes `use('twitter-dim')` turn the map
dark instead of leaving dark features floating on a white page.

**Every token has a value.** The draft patches `defaultTheme`, so a token the
author did not mention is inherited and a plugin reading `token('color').guide`
never gets `undefined`.

The second one has a consequence worth stating plainly, because it is the source
of most surprises here: **a token a theme does not mention is the default's.**
`twitter-black` never sets `accentMuted`, so `twitter-black`'s `accentMuted` is
`#93c5fd` — a pale sky blue, in a true-black OLED palette. `ThemeManager`
registers all seven, but `builtinThemes` holds only six, so auditing that array
alone would leave the inherited half of every palette unmeasured — which is why
`AUDITED_THEMES` names `defaultTheme` separately.

Preset themes do not go through `buildTheme`. `cadastreTheme` and `gameTheme`
spread `defaultTheme.tokens.color` by hand; `urbanTheme` is a
`DeepPartial<Theme>` applied through `theme.set()`. None of the three is
registered, so `use('cadastre')` throws, and none of the three is audited.

## One token set, two consumers

`ThemeManager` mirrors every token in every group onto the map container as a
CSS custom property — `color.accentStrong` becomes `--bl-color-accent-strong`,
`size.vertexRadius` becomes `--bl-size-vertex-radius` with the `px`, and the `z`
group stays unitless because a `z-index: 30px` is simply ignored. There is no
per-token allow-list: the loop mirrors whatever is on the object
(`ThemeManager.ts:345-371`), and `plugin-ui/src/tokens.ts` runs the same loop
for a toolbar mounted outside the container.

That is why a token can be _declared, themed, mirrored, and read by nothing_.
`accentMuted` and `success` are exactly that today: six theme files give them
values, several with a hand-computed contrast ratio in a comment, and no code in
any package reads either one.

## The floor a colour owes comes from where it is painted

This is the part that a reasonable-sounding blanket rule gets wrong in both
directions, so it is worth being emphatic.

`accent` in the Twitter light palette is `#1D9BF0` on a white ground: exactly
**3.00:1**. A rule that demanded 4.5:1 of every pair would call that a defect.
It is not — it is the point. `accent` is a mark on a map and a link, 3:1 is the
WCAG floor for a graphic, and the vivid blue is kept deliberately. The filled
control that carries a label reads a _different_ token, `accentStrong` with
`onAccent`, sized so the label clears 4.5:1.

And the same blanket rule waves through `hover`, because nothing in the name
says the toolbar uses it as the background of a button that keeps `color:
inherit` (`plugin-ui/src/styles.ts:94,99`). It does, and `text` on `hover` is
1.96:1 in `twitter-black`. Twenty-nine of the thirty-six pairs currently below
their floor share that one background — one token doing two incompatible jobs.

The subtlest of the twenty-nine is worth knowing before you touch that
stylesheet. `.bl-ui-button:hover:not(:disabled)` has specificity (0,4,0) and
`.bl-ui-button[aria-pressed='true']` has (0,3,0), so hovering a button that is
already pressed keeps the pressed rule's `color: onAccent` while the hover fill
wins the background. The pair painted is `onAccent` on `hover` — a pair neither
rule looks like it creates.

So every rule in `packages/core/src/theme/contrast.ts` carries the file and line
that paints it, and the floor follows from what that line draws — 4.5:1 for text
(WCAG 1.4.3), 3:1 for a graphic or a control boundary (1.4.11). A pair with no
call site gets no rule. Some consequences that are not guessable from the names:

- `surface` is a **foreground**: it is the snap tooltip's label colour, on a
  `snapIndicator` background. Not `onAccent`, whatever the JSDoc on `onAccent`
  says.
- `vertex` is white, and against a white ground that is 1.00:1 — correct, and
  measured nowhere. It is always stroked; the 3:1 obligation belongs to the
  stroke, `vertexActive`.
- `border` is measured against `canvas`, not `surface`. The scale bar's only
  separation from the map is its 1 px border — it carries no `.bl-ui-control`
  class and so no box-shadow — and `surface` sits within ~1.2:1 of `canvas` in
  every shipped theme by design.

## The three corrections to X

The Twitter palettes reproduce X's schemes and correct three places where X's
own values fail WCAG, keeping the hue in each case. Each is a named test in
`contrast.test.ts`, not a sentence in a comment:

1. **White on blue is 3.00:1.** The vivid `#1D9BF0` stays as the map mark and
   link; `accentStrong` (`#1578C2`, white label 4.67:1) carries the button.
2. **X's snap yellow `#FFD400` is 1.43:1 on white.** The light theme deepens it
   to `#C2410C` (5.18:1). Dim and Lights-out keep the yellow, where it is
   11.52:1 and 14.67:1 — and the indicator is also the tooltip's background, so
   all three owe 4.5:1 to the `surface` label on it.
3. **Lights-out muted text was 3.88:1** on the panel grey with X's `#71767B`.
   Nudged to `#7E8388`, which is 4.65:1.

## The audit is generated, and the suite diffs it

```bash
# assert every pair, and check the committed docs/contrast.md still matches
npx vitest run packages/core/src/theme/contrast.test.ts

# regenerate docs/contrast.md after a deliberate re-tint
npx vitest run packages/core/src/theme/contrast.test.ts -u
```

`contrast.test.ts` recomputes every gated pair in all seven audited themes,
renders `docs/contrast.md`, and compares it to the committed copy through
`toMatchFileSnapshot`. Locally a missing file is written; in CI vitest refuses
to write, so a re-tinted token whose number has not reached the document fails
the build. It runs inside `npm run verify` like any other test.

Two more gates in the same file, both of which have already caught something:

- It checks its own arithmetic against published reference values (`#767676` on
  white is 4.54:1) before measuring any theme. An audit that is wrong and
  self-consistent reads as proof.
- It parses the `// 4.67:1` annotations back out of `twitter.ts` and
  `professional.ts` and recomputes them — forty-three of them. Where a comment
  names its ground ("on white", "on the panel grey") it is checked against
  _that_ ground rather than whichever one happens to fit. That distinction is
  the whole value: the light snap indicator was recorded as 4.96:1, a true ratio
  for `#C2410C` — on survey-paper's off-white, not on the white it is painted
  on.
- It resolves every citation. The `where` strings name 30-odd line numbers
  across seven packages, and the suite opens each file, checks the line exists,
  and checks the file mentions the token it is cited for. A citation-shaped
  string is not enough — that would be the same "a comment does not fail" hole,
  one level up.

Regenerating the document is not optional housekeeping. `npm run format:check`
is its own CI step and `docs/` is not ignored, so the generator emits Prettier's
exact output — padded cells and all — and a hand-edit will fail there even if
the snapshot somehow matched.

## Adding a colour token

Two rules, and both are enforced today:

**1. Give it a value in `defaultTheme`.** `defaultTheme` is typed `Theme`, so
`tsc` fails on a token in `ThemeTokens` that it does not set. Nothing requires
you to set it in the other themes — `buildTheme` merges over the default, so
they inherit — and that inheritance is exactly why the default is audited too.

**2. Classify it in `contrast.ts`.** A token must appear in `CONTRAST_RULES`, in
`ADVISORY_PAIRS`, or in `UNCONSUMED_TOKENS`, or `contrast.test.ts` fails with
the name. A gated rule needs a real call site: if you cannot cite the file and
line that paints it, the token has no consumer yet and belongs on the unconsumed
list until it does.

## When a number will not go up

Do not repaint a colour to make a test green. A pair that sits below its floor
goes into `RECORDED_BELOW_FLOOR` at the ratio it actually has, and it is printed
in `docs/contrast.md` under "Below the floor" with its call site — published,
not waived. The pin is an **equality**: any movement, in either direction, fails
until the row is updated or deleted. A one-way `>=` will not do — it lets a
colour improve well inside the band while the number on file stays quietly
wrong, which is the failure this suite exists to prevent rather than a smaller
version of it. A second assertion holds the list and the set of actually-failing
pairs to be the same set, so a row cannot go stale and a new failure cannot go
unrecorded.

The reason for the rule is that the alternative is worse than the defect.
Nudging `hover` until `text` clears 4.5:1 in all seven themes would produce
seven plausible colours and quietly delete the finding — which is that one token
is being used both as a bright on-map highlight and as chrome behind inherited
body text, and no single value satisfies both. That is a design decision with a
real trade-off, and it belongs to a person, not to whoever was making a test
pass.
