# Contrast

Generated. Do not edit — `packages/core/src/theme/contrast.test.ts` writes this file, and
fails if the committed copy and a fresh run disagree, so a re-tinted token cannot land
without the number moving here too. Regenerate with `npx vitest run -u`.

Every ratio is WCAG 2.2 relative luminance over sRGB, rounded to two decimals, computed
from the token values themselves. The arithmetic is checked in the same test against
published reference values (`#767676` on white is 4.54:1; `#949494` on white is 3.03:1)
so the audit cannot be wrong and self-consistent at once.

## What is gated, and why each pair

A pair is gated when the shipped code paints it. The floor follows from what that line
draws — 4.5:1 for text (WCAG 1.4.3), 3:1 for a graphic or a control boundary (1.4.11) —
and never from the token name.

This is the part a blanket rule gets wrong in both directions. `accent` on `canvas` is
exactly 3.00:1 in the Twitter light palette: a blanket 4.5:1 would call the deliberate
choice a defect, when the vivid blue is kept precisely because it is a mark on a map. And
nothing in the name `hover` suggests the toolbar puts body text on it, which it does.

| Pair                          | Floor | Where it is painted                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text` on `surface`           | 4.5:1 | plugin-ui/src/styles.ts:31 on :57 — the root colour, inherited by every control that does not override it, on a surface panel                                                                                                                                                                                    |
| `text` on `hover`             | 4.5:1 | plugin-ui/src/styles.ts:99,224 — the button and issue-row hover fill; the label keeps `color: inherit`                                                                                                                                                                                                           |
| `textMuted` on `surface`      | 4.5:1 | plugin-ui/src/styles.ts:129,242 — the empty readout and the status line                                                                                                                                                                                                                                          |
| `textMuted` on `surfaceMuted` | 4.5:1 | plugin-ui/src/styles.ts:158-160 — the attribution, at 11 px                                                                                                                                                                                                                                                      |
| `onAccent` on `accentStrong`  | 4.5:1 | plugin-ui/src/styles.ts:108-111 — the label on a pressed toolbar button                                                                                                                                                                                                                                          |
| `onAccent` on `hover`         | 4.5:1 | plugin-ui/src/styles.ts:99 over :108-111 — a hovered pressed toggle. `:hover:not(:disabled)` is specificity (0,4,0) and `[aria-pressed='true']` is (0,3,0), so the hover fill wins the background while the pressed rule still supplies `color: onAccent`                                                        |
| `surface` on `snapIndicator`  | 4.5:1 | plugin-ui/src/styles.ts:174-176 — the snap tooltip; its label is `surface`, not `onAccent`                                                                                                                                                                                                                       |
| `text` on `labelHalo`         | 4.5:1 | preset-cadastre/src/layers.ts:50-52 — the parcel-number labels against their halo                                                                                                                                                                                                                                |
| `accent` on `canvas`          | 3.0:1 | plugin-draw/src/preview.ts:37-38, plugin-measure/src/layers.ts:60-62, preset-cadastre/src/layers.ts:16-25 — the draft outline, the measure line, the parcel line                                                                                                                                                 |
| `accent` on `surface`         | 3.0:1 | plugin-ui/src/styles.ts:66 — the 2 px focus ring; :227 — the 3 px info stripe                                                                                                                                                                                                                                    |
| `selection` on `canvas`       | 3.0:1 | plugin-select/src/overlay.ts:128-143 — the selection fill, its outline, and the lasso                                                                                                                                                                                                                            |
| `vertexActive` on `canvas`    | 3.0:1 | plugin-edit/src/handles.ts:228,241 — the stroke that bounds both handles; `vertex` and `midpoint` are fills inside it                                                                                                                                                                                            |
| `snapIndicator` on `canvas`   | 3.0:1 | plugin-snap/src/indicator.ts:101 — the indicator disc. Its 2 px stroke at :106 is `surface`, and MapLibre paints a circle stroke outside the radius, so the disc meets the ground through a halo the colour of the panels; the disc still owes 3:1, because a halo that matches the ground cannot carry the mark |
| `guide` on `canvas`           | 3.0:1 | plugin-edit/src/handles.ts:251 — the transform bounding box and the split-line preview (transform.ts:102, split.ts:40), at 0.9 alpha; :252 fills the same shape at 0.05                                                                                                                                          |
| `error` on `surface`          | 3.0:1 | plugin-ui/src/styles.ts:225 on :191 — the 3 px severity stripe on the issue panel                                                                                                                                                                                                                                |
| `error` on `hover`            | 3.0:1 | plugin-ui/src/styles.ts:224-225 — the same stripe, on a hovered row                                                                                                                                                                                                                                              |
| `accent` on `hover`           | 3.0:1 | plugin-ui/src/styles.ts:224,227 — the info severity stripe on a hovered row, exactly as error and warning above                                                                                                                                                                                                  |
| `warning` on `surface`        | 3.0:1 | plugin-ui/src/styles.ts:226 on :191 — the 3 px severity stripe                                                                                                                                                                                                                                                   |
| `warning` on `hover`          | 3.0:1 | plugin-ui/src/styles.ts:224,226 — the same stripe, on a hovered row                                                                                                                                                                                                                                              |
| `border` on `canvas`          | 3.0:1 | plugin-ui/src/styles.ts:143 and :240 — the only boundary of the scale bar and of the status line. Neither carries `.bl-ui-control` (ScaleBar.ts:34, plugin.ts:160), so neither gets its box-shadow, and both sit over the map                                                                                    |

## Summary

| Theme           | Scheme | Pairs | At or above floor | Below floor |
| --------------- | ------ | ----- | ----------------- | ----------- |
| `blaeu-default` | light  | 20    | 14                | 6           |
| `twitter-light` | light  | 20    | 15                | 5           |
| `twitter-dim`   | dark   | 20    | 14                | 6           |
| `twitter-black` | dark   | 20    | 14                | 6           |
| `survey-paper`  | light  | 20    | 16                | 4           |
| `high-contrast` | light  | 20    | 16                | 4           |
| `imagery-dark`  | dark   | 20    | 15                | 5           |

140 gated pairs across 7 themes: 104 at or above their floor, 36 below.

## `blaeu-default`

| Pair                          | Colours            | Ratio | Floor |       |
| ----------------------------- | ------------------ | ----- | ----- | ----- |
| `text` on `surface`           | #0f172a on #ffffff | 17.85 | 4.5   | ok    |
| `text` on `hover`             | #0f172a on #60a5fa | 7.02  | 4.5   | ok    |
| `textMuted` on `surface`      | #64748b on #ffffff | 4.76  | 4.5   | ok    |
| `textMuted` on `surfaceMuted` | #64748b on #f1f5f9 | 4.34  | 4.5   | BELOW |
| `onAccent` on `accentStrong`  | #ffffff on #1d4ed8 | 6.70  | 4.5   | ok    |
| `onAccent` on `hover`         | #ffffff on #60a5fa | 2.54  | 4.5   | BELOW |
| `surface` on `snapIndicator`  | #ffffff on #b45309 | 5.02  | 4.5   | ok    |
| `text` on `labelHalo`         | #0f172a on #ffffff | 17.85 | 4.5   | ok    |
| `accent` on `canvas`          | #2563eb on #fafbfc | 4.99  | 3.0   | ok    |
| `accent` on `surface`         | #2563eb on #ffffff | 5.17  | 3.0   | ok    |
| `selection` on `canvas`       | #2563eb on #fafbfc | 4.99  | 3.0   | ok    |
| `vertexActive` on `canvas`    | #2563eb on #fafbfc | 4.99  | 3.0   | ok    |
| `snapIndicator` on `canvas`   | #b45309 on #fafbfc | 4.85  | 3.0   | ok    |
| `guide` on `canvas`           | #a855f7 on #fafbfc | 3.82  | 3.0   | ok    |
| `error` on `surface`          | #dc2626 on #ffffff | 4.83  | 3.0   | ok    |
| `error` on `hover`            | #dc2626 on #60a5fa | 1.90  | 3.0   | BELOW |
| `accent` on `hover`           | #2563eb on #60a5fa | 2.03  | 3.0   | BELOW |
| `warning` on `surface`        | #d97706 on #ffffff | 3.19  | 3.0   | ok    |
| `warning` on `hover`          | #d97706 on #60a5fa | 1.25  | 3.0   | BELOW |
| `border` on `canvas`          | #cbd5e1 on #fafbfc | 1.43  | 3.0   | BELOW |

## `twitter-light`

| Pair                          | Colours            | Ratio | Floor |       |
| ----------------------------- | ------------------ | ----- | ----- | ----- |
| `text` on `surface`           | #0F1419 on #FFFFFF | 18.51 | 4.5   | ok    |
| `text` on `hover`             | #0F1419 on #F91880 | 4.82  | 4.5   | ok    |
| `textMuted` on `surface`      | #536471 on #FFFFFF | 6.12  | 4.5   | ok    |
| `textMuted` on `surfaceMuted` | #536471 on #F7F9F9 | 5.80  | 4.5   | ok    |
| `onAccent` on `accentStrong`  | #FFFFFF on #1578C2 | 4.67  | 4.5   | ok    |
| `onAccent` on `hover`         | #FFFFFF on #F91880 | 3.84  | 4.5   | BELOW |
| `surface` on `snapIndicator`  | #FFFFFF on #C2410C | 5.18  | 4.5   | ok    |
| `text` on `labelHalo`         | #0F1419 on #FFFFFF | 18.51 | 4.5   | ok    |
| `accent` on `canvas`          | #1D9BF0 on #FFFFFF | 3.00  | 3.0   | ok    |
| `accent` on `surface`         | #1D9BF0 on #FFFFFF | 3.00  | 3.0   | ok    |
| `selection` on `canvas`       | #E01673 on #FFFFFF | 4.63  | 3.0   | ok    |
| `vertexActive` on `canvas`    | #E01673 on #FFFFFF | 4.63  | 3.0   | ok    |
| `snapIndicator` on `canvas`   | #C2410C on #FFFFFF | 5.18  | 3.0   | ok    |
| `guide` on `canvas`           | #6941E0 on #FFFFFF | 6.12  | 3.0   | ok    |
| `error` on `surface`          | #D91F2C on #FFFFFF | 5.02  | 3.0   | ok    |
| `error` on `hover`            | #D91F2C on #F91880 | 1.31  | 3.0   | BELOW |
| `accent` on `hover`           | #1D9BF0 on #F91880 | 1.28  | 3.0   | BELOW |
| `warning` on `surface`        | #A16207 on #FFFFFF | 4.92  | 3.0   | ok    |
| `warning` on `hover`          | #A16207 on #F91880 | 1.28  | 3.0   | BELOW |
| `border` on `canvas`          | #CFD9DE on #FFFFFF | 1.44  | 3.0   | BELOW |

## `twitter-dim`

| Pair                          | Colours            | Ratio | Floor |       |
| ----------------------------- | ------------------ | ----- | ----- | ----- |
| `text` on `surface`           | #F7F9F9 on #15202B | 15.61 | 4.5   | ok    |
| `text` on `hover`             | #F7F9F9 on #FF7ABF | 2.26  | 4.5   | BELOW |
| `textMuted` on `surface`      | #8B98A5 on #15202B | 5.60  | 4.5   | ok    |
| `textMuted` on `surfaceMuted` | #8B98A5 on #1E2732 | 5.13  | 4.5   | ok    |
| `onAccent` on `accentStrong`  | #FFFFFF on #1578C2 | 4.67  | 4.5   | ok    |
| `onAccent` on `hover`         | #FFFFFF on #FF7ABF | 2.39  | 4.5   | BELOW |
| `surface` on `snapIndicator`  | #15202B on #FFD400 | 11.52 | 4.5   | ok    |
| `text` on `labelHalo`         | #F7F9F9 on #15202B | 15.61 | 4.5   | ok    |
| `accent` on `canvas`          | #1D9BF0 on #15202B | 5.50  | 3.0   | ok    |
| `accent` on `surface`         | #1D9BF0 on #15202B | 5.50  | 3.0   | ok    |
| `selection` on `canvas`       | #F91880 on #15202B | 4.30  | 3.0   | ok    |
| `vertexActive` on `canvas`    | #F91880 on #15202B | 4.30  | 3.0   | ok    |
| `snapIndicator` on `canvas`   | #FFD400 on #15202B | 11.52 | 3.0   | ok    |
| `guide` on `canvas`           | #9B7BFF on #15202B | 5.24  | 3.0   | ok    |
| `error` on `surface`          | #F87171 on #15202B | 5.96  | 3.0   | ok    |
| `error` on `hover`            | #F87171 on #FF7ABF | 1.16  | 3.0   | BELOW |
| `accent` on `hover`           | #1D9BF0 on #FF7ABF | 1.26  | 3.0   | BELOW |
| `warning` on `surface`        | #FFD400 on #15202B | 11.52 | 3.0   | ok    |
| `warning` on `hover`          | #FFD400 on #FF7ABF | 1.67  | 3.0   | BELOW |
| `border` on `canvas`          | #38444D on #15202B | 1.65  | 3.0   | BELOW |

## `twitter-black`

| Pair                          | Colours            | Ratio | Floor |       |
| ----------------------------- | ------------------ | ----- | ----- | ----- |
| `text` on `surface`           | #E7E9EA on #000000 | 17.24 | 4.5   | ok    |
| `text` on `hover`             | #E7E9EA on #FF7ABF | 1.96  | 4.5   | BELOW |
| `textMuted` on `surface`      | #7E8388 on #000000 | 5.49  | 4.5   | ok    |
| `textMuted` on `surfaceMuted` | #7E8388 on #16181C | 4.65  | 4.5   | ok    |
| `onAccent` on `accentStrong`  | #FFFFFF on #1578C2 | 4.67  | 4.5   | ok    |
| `onAccent` on `hover`         | #FFFFFF on #FF7ABF | 2.39  | 4.5   | BELOW |
| `surface` on `snapIndicator`  | #000000 on #FFD400 | 14.67 | 4.5   | ok    |
| `text` on `labelHalo`         | #E7E9EA on #000000 | 17.24 | 4.5   | ok    |
| `accent` on `canvas`          | #1D9BF0 on #000000 | 7.00  | 3.0   | ok    |
| `accent` on `surface`         | #1D9BF0 on #000000 | 7.00  | 3.0   | ok    |
| `selection` on `canvas`       | #F91880 on #000000 | 5.47  | 3.0   | ok    |
| `vertexActive` on `canvas`    | #F91880 on #000000 | 5.47  | 3.0   | ok    |
| `snapIndicator` on `canvas`   | #FFD400 on #000000 | 14.67 | 3.0   | ok    |
| `guide` on `canvas`           | #9B7BFF on #000000 | 6.67  | 3.0   | ok    |
| `error` on `surface`          | #F87171 on #000000 | 7.59  | 3.0   | ok    |
| `error` on `hover`            | #F87171 on #FF7ABF | 1.16  | 3.0   | BELOW |
| `accent` on `hover`           | #1D9BF0 on #FF7ABF | 1.26  | 3.0   | BELOW |
| `warning` on `surface`        | #FFD400 on #000000 | 14.67 | 3.0   | ok    |
| `warning` on `hover`          | #FFD400 on #FF7ABF | 1.67  | 3.0   | BELOW |
| `border` on `canvas`          | #2F3336 on #000000 | 1.65  | 3.0   | BELOW |

## `survey-paper`

| Pair                          | Colours            | Ratio | Floor |       |
| ----------------------------- | ------------------ | ----- | ----- | ----- |
| `text` on `surface`           | #111827 on #FBFAF7 | 17.00 | 4.5   | ok    |
| `text` on `hover`             | #111827 on #FF6BB3 | 6.76  | 4.5   | ok    |
| `textMuted` on `surface`      | #5B5B52 on #FBFAF7 | 6.57  | 4.5   | ok    |
| `textMuted` on `surfaceMuted` | #5B5B52 on #EFECE5 | 5.81  | 4.5   | ok    |
| `onAccent` on `accentStrong`  | #FFFFFF on #1F2933 | 14.76 | 4.5   | ok    |
| `onAccent` on `hover`         | #FFFFFF on #FF6BB3 | 2.62  | 4.5   | BELOW |
| `surface` on `snapIndicator`  | #FBFAF7 on #C2410C | 4.96  | 4.5   | ok    |
| `text` on `labelHalo`         | #111827 on #FBFAF7 | 17.00 | 4.5   | ok    |
| `accent` on `canvas`          | #1F2933 on #FBFAF7 | 14.14 | 3.0   | ok    |
| `accent` on `surface`         | #1F2933 on #FBFAF7 | 14.14 | 3.0   | ok    |
| `selection` on `canvas`       | #D6006F on #FBFAF7 | 4.92  | 3.0   | ok    |
| `vertexActive` on `canvas`    | #D6006F on #FBFAF7 | 4.92  | 3.0   | ok    |
| `snapIndicator` on `canvas`   | #C2410C on #FBFAF7 | 4.96  | 3.0   | ok    |
| `guide` on `canvas`           | #6941E0 on #FBFAF7 | 5.86  | 3.0   | ok    |
| `error` on `surface`          | #C4162B on #FBFAF7 | 5.75  | 3.0   | ok    |
| `error` on `hover`            | #C4162B on #FF6BB3 | 2.29  | 3.0   | BELOW |
| `accent` on `hover`           | #1F2933 on #FF6BB3 | 5.63  | 3.0   | ok    |
| `warning` on `surface`        | #856404 on #FBFAF7 | 5.26  | 3.0   | ok    |
| `warning` on `hover`          | #856404 on #FF6BB3 | 2.09  | 3.0   | BELOW |
| `border` on `canvas`          | #D6D1C6 on #FBFAF7 | 1.46  | 3.0   | BELOW |

## `high-contrast`

| Pair                          | Colours            | Ratio | Floor |       |
| ----------------------------- | ------------------ | ----- | ----- | ----- |
| `text` on `surface`           | #000000 on #FFFFFF | 21.00 | 4.5   | ok    |
| `text` on `hover`             | #000000 on #D1008A | 4.08  | 4.5   | BELOW |
| `textMuted` on `surface`      | #3A3A3A on #FFFFFF | 11.37 | 4.5   | ok    |
| `textMuted` on `surfaceMuted` | #3A3A3A on #F0F0F0 | 9.98  | 4.5   | ok    |
| `onAccent` on `accentStrong`  | #FFFFFF on #0B3D91 | 10.04 | 4.5   | ok    |
| `onAccent` on `hover`         | #FFFFFF on #D1008A | 5.15  | 4.5   | ok    |
| `surface` on `snapIndicator`  | #FFFFFF on #8A3A00 | 7.82  | 4.5   | ok    |
| `text` on `labelHalo`         | #000000 on #FFFFFF | 21.00 | 4.5   | ok    |
| `accent` on `canvas`          | #0B3D91 on #FFFFFF | 10.04 | 3.0   | ok    |
| `accent` on `surface`         | #0B3D91 on #FFFFFF | 10.04 | 3.0   | ok    |
| `selection` on `canvas`       | #A6006B on #FFFFFF | 7.41  | 3.0   | ok    |
| `vertexActive` on `canvas`    | #A6006B on #FFFFFF | 7.41  | 3.0   | ok    |
| `snapIndicator` on `canvas`   | #8A3A00 on #FFFFFF | 7.82  | 3.0   | ok    |
| `guide` on `canvas`           | #4B0FA8 on #FFFFFF | 10.86 | 3.0   | ok    |
| `error` on `surface`          | #8B0F1D on #FFFFFF | 9.62  | 3.0   | ok    |
| `error` on `hover`            | #8B0F1D on #D1008A | 1.87  | 3.0   | BELOW |
| `accent` on `hover`           | #0B3D91 on #D1008A | 1.95  | 3.0   | BELOW |
| `warning` on `surface`        | #5C4200 on #FFFFFF | 9.40  | 3.0   | ok    |
| `warning` on `hover`          | #5C4200 on #D1008A | 1.83  | 3.0   | BELOW |
| `border` on `canvas`          | #000000 on #FFFFFF | 21.00 | 3.0   | ok    |

## `imagery-dark`

| Pair                          | Colours            | Ratio | Floor |       |
| ----------------------------- | ------------------ | ----- | ----- | ----- |
| `text` on `surface`           | #E6EDF3 on #10161D | 15.39 | 4.5   | ok    |
| `text` on `hover`             | #E6EDF3 on #FF7ABF | 2.02  | 4.5   | BELOW |
| `textMuted` on `surface`      | #9BA9B4 on #10161D | 7.56  | 4.5   | ok    |
| `textMuted` on `surfaceMuted` | #9BA9B4 on #18202A | 6.82  | 4.5   | ok    |
| `onAccent` on `accentStrong`  | #041014 on #00D8F0 | 11.09 | 4.5   | ok    |
| `onAccent` on `hover`         | #041014 on #FF7ABF | 8.07  | 4.5   | ok    |
| `surface` on `snapIndicator`  | #10161D on #FFD400 | 12.71 | 4.5   | ok    |
| `text` on `labelHalo`         | #E6EDF3 on #000000 | 17.77 | 4.5   | ok    |
| `accent` on `canvas`          | #00D8F0 on #0B0F14 | 11.06 | 3.0   | ok    |
| `accent` on `surface`         | #00D8F0 on #10161D | 10.46 | 3.0   | ok    |
| `selection` on `canvas`       | #FF2D95 on #0B0F14 | 5.55  | 3.0   | ok    |
| `vertexActive` on `canvas`    | #FF2D95 on #0B0F14 | 5.55  | 3.0   | ok    |
| `snapIndicator` on `canvas`   | #FFD400 on #0B0F14 | 13.43 | 3.0   | ok    |
| `guide` on `canvas`           | #9B7BFF on #0B0F14 | 6.11  | 3.0   | ok    |
| `error` on `surface`          | #FF5A65 on #10161D | 5.98  | 3.0   | ok    |
| `error` on `hover`            | #FF5A65 on #FF7ABF | 1.27  | 3.0   | BELOW |
| `accent` on `hover`           | #00D8F0 on #FF7ABF | 1.37  | 3.0   | BELOW |
| `warning` on `surface`        | #FFD400 on #10161D | 12.71 | 3.0   | ok    |
| `warning` on `hover`          | #FFD400 on #FF7ABF | 1.67  | 3.0   | BELOW |
| `border` on `canvas`          | #2A3542 on #0B0F14 | 1.54  | 3.0   | BELOW |

## Below the floor

Grouped by rule, because these do not scatter — a pair that fails tends to fail in most
themes at once, and that is the signal. A rule failing everywhere is one token doing a
job it was not chosen for, not seven separate mistakes.

### `text` on `hover` — needs 4.5:1

plugin-ui/src/styles.ts:99,224 — the button and issue-row hover fill; the label keeps `color: inherit`

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `twitter-dim`   | #F7F9F9 on #FF7ABF | 2.26  |
| `twitter-black` | #E7E9EA on #FF7ABF | 1.96  |
| `high-contrast` | #000000 on #D1008A | 4.08  |
| `imagery-dark`  | #E6EDF3 on #FF7ABF | 2.02  |

### `textMuted` on `surfaceMuted` — needs 4.5:1

plugin-ui/src/styles.ts:158-160 — the attribution, at 11 px

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #64748b on #f1f5f9 | 4.34  |

### `onAccent` on `hover` — needs 4.5:1

plugin-ui/src/styles.ts:99 over :108-111 — a hovered pressed toggle. `:hover:not(:disabled)` is specificity (0,4,0) and `[aria-pressed='true']` is (0,3,0), so the hover fill wins the background while the pressed rule still supplies `color: onAccent`

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #ffffff on #60a5fa | 2.54  |
| `twitter-light` | #FFFFFF on #F91880 | 3.84  |
| `twitter-dim`   | #FFFFFF on #FF7ABF | 2.39  |
| `twitter-black` | #FFFFFF on #FF7ABF | 2.39  |
| `survey-paper`  | #FFFFFF on #FF6BB3 | 2.62  |

### `error` on `hover` — needs 3.0:1

plugin-ui/src/styles.ts:224-225 — the same stripe, on a hovered row

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #dc2626 on #60a5fa | 1.90  |
| `twitter-light` | #D91F2C on #F91880 | 1.31  |
| `twitter-dim`   | #F87171 on #FF7ABF | 1.16  |
| `twitter-black` | #F87171 on #FF7ABF | 1.16  |
| `survey-paper`  | #C4162B on #FF6BB3 | 2.29  |
| `high-contrast` | #8B0F1D on #D1008A | 1.87  |
| `imagery-dark`  | #FF5A65 on #FF7ABF | 1.27  |

### `accent` on `hover` — needs 3.0:1

plugin-ui/src/styles.ts:224,227 — the info severity stripe on a hovered row, exactly as error and warning above

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #2563eb on #60a5fa | 2.03  |
| `twitter-light` | #1D9BF0 on #F91880 | 1.28  |
| `twitter-dim`   | #1D9BF0 on #FF7ABF | 1.26  |
| `twitter-black` | #1D9BF0 on #FF7ABF | 1.26  |
| `high-contrast` | #0B3D91 on #D1008A | 1.95  |
| `imagery-dark`  | #00D8F0 on #FF7ABF | 1.37  |

### `warning` on `hover` — needs 3.0:1

plugin-ui/src/styles.ts:224,226 — the same stripe, on a hovered row

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #d97706 on #60a5fa | 1.25  |
| `twitter-light` | #A16207 on #F91880 | 1.28  |
| `twitter-dim`   | #FFD400 on #FF7ABF | 1.67  |
| `twitter-black` | #FFD400 on #FF7ABF | 1.67  |
| `survey-paper`  | #856404 on #FF6BB3 | 2.09  |
| `high-contrast` | #5C4200 on #D1008A | 1.83  |
| `imagery-dark`  | #FFD400 on #FF7ABF | 1.67  |

### `border` on `canvas` — needs 3.0:1

plugin-ui/src/styles.ts:143 and :240 — the only boundary of the scale bar and of the status line. Neither carries `.bl-ui-control` (ScaleBar.ts:34, plugin.ts:160), so neither gets its box-shadow, and both sit over the map

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #cbd5e1 on #fafbfc | 1.43  |
| `twitter-light` | #CFD9DE on #FFFFFF | 1.44  |
| `twitter-dim`   | #38444D on #15202B | 1.65  |
| `twitter-black` | #2F3336 on #000000 | 1.65  |
| `survey-paper`  | #D6D1C6 on #FBFAF7 | 1.46  |
| `imagery-dark`  | #2A3542 on #0B0F14 | 1.54  |

These are recorded, not waived. `contrast.test.ts` pins every one of them to the exact
ratio printed above, and the pin is an equality: any movement at all, in either
direction, fails until the row is updated or deleted. It also asserts that this list and
the set of pairs actually below their floor are the same set — so a pair cannot begin
failing without being written down here, and a fixed one cannot stay written down.

## Measured but not gated

A pair with no rule is a pair nobody has thought about; a pair here is one somebody has.

### `vertexActive` on `vertex`

plugin-edit/src/handles.ts:226-229 — a 2 px ring around a white disc.

A handle is perceivable because its ring clears 3:1 against the ground, which is gated above. How much the ring differs from its own fill is a legibility judgement, not a WCAG floor.

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #2563eb on #ffffff | 5.17  |
| `twitter-light` | #E01673 on #FFFFFF | 4.63  |
| `twitter-dim`   | #F91880 on #FFFFFF | 3.84  |
| `twitter-black` | #F91880 on #FFFFFF | 3.84  |
| `survey-paper`  | #D6006F on #FFFFFF | 5.14  |
| `high-contrast` | #A6006B on #FFFFFF | 7.41  |
| `imagery-dark`  | #FF2D95 on #FFFFFF | 3.46  |

### `vertexActive` on `midpoint`

plugin-edit/src/handles.ts:239-242 — a 1 px ring, the thinnest boundary in the system.

Same as above, and worth watching: this is the pair that runs lowest.

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #2563eb on #cbd5e1 | 3.48  |
| `twitter-light` | #E01673 on #8899A6 | 1.58  |
| `twitter-dim`   | #F91880 on #5C6E7E | 1.37  |
| `twitter-black` | #F91880 on #545B62 | 1.79  |
| `survey-paper`  | #D6006F on #B7AE9E | 2.34  |
| `high-contrast` | #A6006B on #595959 | 1.06  |
| `imagery-dark`  | #FF2D95 on #5A6B78 | 1.59  |

### `accent` on `vertex`

plugin-draw/src/preview.ts:39-44, plugin-measure/src/layers.ts:69-74 — the draw and measure vertex stroke.

Same as above.

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #2563eb on #ffffff | 5.17  |
| `twitter-light` | #1D9BF0 on #FFFFFF | 3.00  |
| `twitter-dim`   | #1D9BF0 on #FFFFFF | 3.00  |
| `twitter-black` | #1D9BF0 on #FFFFFF | 3.00  |
| `survey-paper`  | #1F2933 on #FFFFFF | 14.76 |
| `high-contrast` | #0B3D91 on #FFFFFF | 10.04 |
| `imagery-dark`  | #00D8F0 on #FFFFFF | 1.74  |

### `surface` on `canvas`

plugin-ui/src/styles.ts:57 — a panel floating over the map.

Every shipped theme sits a panel within ~1.2:1 of its own ground, deliberately: the chrome is meant to recede. That is precisely why `border` on `canvas` is gated instead.

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #ffffff on #fafbfc | 1.04  |
| `twitter-light` | #FFFFFF on #FFFFFF | 1.00  |
| `twitter-dim`   | #15202B on #15202B | 1.00  |
| `twitter-black` | #000000 on #000000 | 1.00  |
| `survey-paper`  | #FBFAF7 on #FBFAF7 | 1.00  |
| `high-contrast` | #FFFFFF on #FFFFFF | 1.00  |
| `imagery-dark`  | #10161D on #0B0F14 | 1.06  |

### `surfaceMuted` on `canvas`

plugin-ui/src/styles.ts:158 — the attribution, which has neither border nor shadow.

Same, with a sharper edge: the attribution has no boundary at all, so nothing here can carry 3:1. Recorded so the number is on file.

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #f1f5f9 on #fafbfc | 1.06  |
| `twitter-light` | #F7F9F9 on #FFFFFF | 1.06  |
| `twitter-dim`   | #1E2732 on #15202B | 1.09  |
| `twitter-black` | #16181C on #000000 | 1.18  |
| `survey-paper`  | #EFECE5 on #FBFAF7 | 1.13  |
| `high-contrast` | #F0F0F0 on #FFFFFF | 1.14  |
| `imagery-dark`  | #18202A on #0B0F14 | 1.17  |

### `labelHalo` on `canvas`

preset-cadastre/src/layers.ts:51 — the halo behind an on-map label.

A halo does its job by matching the ground, not by contrasting with it. Near 1:1 is correct here, and a high number would be the bug.

| Theme           | Colours            | Ratio |
| --------------- | ------------------ | ----- |
| `blaeu-default` | #ffffff on #fafbfc | 1.04  |
| `twitter-light` | #FFFFFF on #FFFFFF | 1.00  |
| `twitter-dim`   | #15202B on #15202B | 1.00  |
| `twitter-black` | #000000 on #000000 | 1.00  |
| `survey-paper`  | #FBFAF7 on #FBFAF7 | 1.00  |
| `high-contrast` | #FFFFFF on #FFFFFF | 1.00  |
| `imagery-dark`  | #000000 on #0B0F14 | 1.09  |

## Tokens with no rule at all

`accentMuted` and `success` are declared in `ThemeTokens`, given a value by
every theme, mirrored to a CSS custom property — and read by nothing in `packages/*/src`.
There is no call site, so there is no pair, so there is no floor. Several themes carry a
hand-computed ratio in a comment for `success`, which is arithmetic performed for a
consumer that does not exist.

## What this document does not cover

The three preset themes — `preset-cadastre`, `preset-urban`, `preset-game` — are not
audited. They are applied through `theme.set()` rather than registered, and they live in
packages `@blaeu/core` may not import, so gating them needs a test inside each of those
packages. Nothing checks their contrast today.

Opacity is not modelled either. Several of the gated marks are painted with a fill
opacity — the selection fill at 0.25, the parcel fill at 0.08 — and the ratios here are
for the token at full strength, which is what the accompanying line or outline is drawn
at. A composited fill over an unknown basemap has no single ratio to compute.

One unmodelled opacity does land on a _text_ pair, with no full-strength companion:
`plugin-ui/src/styles.ts:100` composites a disabled button — label included — at 0.45. The
`text` on `surface` row below is therefore optimistic for every disabled toolbar and
history button, by an amount nothing here computes.
