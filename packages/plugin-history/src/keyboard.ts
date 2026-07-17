import type { Disposable } from '@blaeu/core'
import type { HistoryApi } from './HistoryStack.js'

/**
 * The bit of `EventTarget` we need.
 *
 * Structural rather than `HTMLElement` so the binding can be pointed at anything
 * that dispatches keydowns — including, in the tests, a plain object. `HTMLElement`
 * satisfies it.
 */
export interface KeyboardTarget {
  addEventListener(type: string, handler: (event: Event) => void): void
  removeEventListener(type: string, handler: (event: Event) => void): void
}

/**
 * Ctrl/Cmd+Z and Ctrl+Shift+Z / Ctrl+Y, bound on `target`.
 *
 * **On the map container, never on `window`.** Two maps on one page with a
 * window-level binding both undo on one Ctrl+Z, and the user's edit disappears
 * from a map they were not even looking at.
 */
export function bindKeyboard(
  target: KeyboardTarget,
  history: HistoryApi,
  isMac: boolean = detectMac(),
): Disposable {
  const handler = (event: Event): void => {
    // Registered for 'keydown' only, so this is a KeyboardEvent — but the target is
    // structural, so the type system cannot know that.
    const key = event as KeyboardEvent

    // Cmd on macOS, Ctrl everywhere else. Getting this wrong is not a cosmetic
    // failure: Ctrl+Z on a Mac is bound to nothing, so undo simply appears broken.
    const primary = isMac ? key.metaKey : key.ctrlKey
    if (!primary || key.altKey) return

    // The user is typing in the attribute panel. Their editor's own undo — the one
    // that puts back the character they just deleted — must win; stealing Ctrl+Z
    // here would undo a *map edit* while their cursor is in a text field, which is
    // the most alarming thing a map can do.
    if (isTypingTarget(key.target)) return

    const name = typeof key.key === 'string' ? key.key.toLowerCase() : ''

    if (name === 'z') {
      if (key.shiftKey) history.redo()
      else history.undo()
    } else if (name === 'y' && !isMac && !key.shiftKey) {
      // Windows' second redo chord. Cmd+Y is not redo on macOS, so it stays free.
      history.redo()
    } else {
      return
    }

    // Claim the chord even when the stack was empty. Otherwise Ctrl+Z at the bottom
    // of the history falls through to the browser, which — inside a contenteditable
    // host page — will happily undo something else entirely.
    key.preventDefault()
  }

  target.addEventListener('keydown', handler)
  return { dispose: () => target.removeEventListener('keydown', handler) }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null) return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  if (element.isContentEditable === true) return true
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * `navigator.platform` is deprecated but is still the only thing that answers this
 * question in every browser we support; `userAgentData` is Chromium-only. Both are
 * absent under Node, where the answer is irrelevant because there is no keyboard.
 */
export function detectMac(): boolean {
  const nav = (globalThis as { navigator?: Navigator & { userAgentData?: { platform?: string } } })
    .navigator
  if (nav === undefined) return false
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}
