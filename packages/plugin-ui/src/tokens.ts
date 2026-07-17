import type { ThemeTokens } from '@blaeu/core'

/**
 * Mirror the theme's tokens onto an element as CSS custom properties.
 *
 * The ThemeManager already writes these onto the *map container*, so when the UI
 * root is a child of it (the default) this is a no-op that writes the same values
 * again. It exists for the other case: a product that mounts the toolbar in its
 * own app shell, outside the map container, where inheritance cannot reach. The
 * values still come from the one ThemeManager, so the palette cannot drift — the
 * point of the exercise — but the variables have to be *defined* somewhere the
 * cascade can see them.
 *
 * The naming must match the ThemeManager's (`--bl-color-accent`,
 * `--bl-size-vertex-radius`). If the core ever renames them, this breaks loudly
 * rather than quietly: the UI loses its palette wholesale, not one shade of grey.
 */
export function applyTokens(element: HTMLElement, tokens: ThemeTokens): void {
  const groups = tokens as unknown as Record<string, Record<string, string | number>>

  for (const group of Object.keys(groups)) {
    const values = groups[group]
    if (!values) continue
    for (const key of Object.keys(values)) {
      const value = values[key]
      if (value === undefined) continue
      element.style.setProperty(`--bl-${kebab(group)}-${kebab(key)}`, cssValue(group, value))
    }
  }
}

function cssValue(group: string, value: string | number): string {
  if (typeof value === 'string') return value
  // Stacking order is unitless; every other number in the token set is a CSS pixel
  // length. Same rule the ThemeManager applies — the two must agree exactly, or a
  // z-index arrives as `10px` and the control disappears behind the map.
  return group === 'z' ? String(value) : `${value}px`
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}
