import type { Theme } from '../../types/theme.js'
import { twitterLight, twitterDim, twitterBlack } from './twitter.js'
import { surveyPaper, highContrast, imageryDark } from './professional.js'

export { buildTheme, flatBasemap } from './build.js'
export type { ThemeDraft } from './build.js'
export { twitterLight, twitterDim, twitterBlack } from './twitter.js'
export { surveyPaper, highContrast, imageryDark } from './professional.js'

/**
 * Every theme the kernel ships, registered on each map so `map.theme.use(id)` and a
 * theme picker work with no setup. They are *available*, not *active* — the active
 * theme stays whatever the preset (or the app) set, until something calls `use()`
 * or `follow('auto')`.
 */
export const builtinThemes: readonly Theme[] = [
  twitterLight,
  twitterDim,
  twitterBlack,
  surveyPaper,
  highContrast,
  imageryDark,
]

/** The light/dark pair `follow('auto')` chooses between by default. */
export const DEFAULT_SCHEME_THEMES = { light: 'twitter-light', dark: 'twitter-dim' } as const
