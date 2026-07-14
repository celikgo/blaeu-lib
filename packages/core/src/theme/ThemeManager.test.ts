import { describe, expect, it, vi } from 'vitest'
import { FlexiThemeManager } from './ThemeManager.js'
import { defaultTheme } from './defaultTheme.js'

/**
 * The suite runs in node, with no `document` — which is the point. The kernel must
 * be constructible against a container stub, or every store and command test would
 * need jsdom.
 */
function stubContainer(): { element: HTMLElement; vars: Map<string, string> } {
  const vars = new Map<string, string>()
  const element = {
    style: {
      setProperty: (name: string, value: string) => vars.set(name, value),
      removeProperty: (name: string) => vars.delete(name),
    },
    setAttribute: () => {},
    removeAttribute: () => {},
  } as unknown as HTMLElement

  return { element, vars }
}

describe('FlexiThemeManager', () => {
  it('writes every token into the container as a CSS custom property', () => {
    const { element, vars } = stubContainer()
    new FlexiThemeManager(element)

    // The single source of truth: the same number the map reads through token() is
    // the one the chrome reads through var().
    expect(vars.get('--fx-color-accent')).toBe(defaultTheme.tokens.color.accent)
    expect(vars.get('--fx-color-snap-indicator')).toBe(defaultTheme.tokens.color.snapIndicator)
    expect(vars.get('--fx-size-vertex-radius')).toBe('5px')
    expect(vars.get('--fx-font-size')).toBe('13px')
    // Stacking order is unitless; a `z-index: 30px` is simply ignored by CSS.
    expect(vars.get('--fx-z-indicator')).toBe('30')
  })

  it('deep-merges a partial theme and leaves untouched tokens alone', () => {
    const { element, vars } = stubContainer()
    const theme = new FlexiThemeManager(element)

    theme.set({ id: 'cadastre', tokens: { color: { accent: '#b91c1c' } } })

    expect(theme.current.id).toBe('cadastre')
    expect(theme.token('color').accent).toBe('#b91c1c')
    expect(theme.token('color').snapIndicator).toBe(defaultTheme.tokens.color.snapIndicator)
    expect(theme.token('size').vertexRadius).toBe(defaultTheme.tokens.size.vertexRadius)
    expect(vars.get('--fx-color-accent')).toBe('#b91c1c')
  })

  it('hands plugins raw numbers, not CSS strings', () => {
    const { element } = stubContainer()
    const theme = new FlexiThemeManager(element)

    // A MapLibre paint expression wants 5, not '5px'.
    expect(theme.token('size').vertexRadius).toBe(5)
  })

  it('notifies subscribers on set, and stops when disposed', () => {
    const { element } = stubContainer()
    const theme = new FlexiThemeManager(element)
    const seen: string[] = []

    const sub = theme.onChange((next) => seen.push(next.tokens.color.accent))
    theme.set({ tokens: { color: { accent: '#111111' } } })
    sub.dispose()
    theme.set({ tokens: { color: { accent: '#222222' } } })

    expect(seen).toEqual(['#111111'])
  })

  it('survives a handler that throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { element } = stubContainer()
    const theme = new FlexiThemeManager(element)
    const seen: string[] = []

    theme.onChange(() => {
      throw new Error('boom')
    })
    theme.onChange((next) => seen.push(next.id))

    theme.set({ id: 'urban' })

    expect(seen).toEqual(['urban'])
    error.mockRestore()
  })

  it('removes only the properties it wrote when disposed', () => {
    const { element, vars } = stubContainer()
    vars.set('--app-owned', 'keep me')

    const theme = new FlexiThemeManager(element)
    expect(vars.size).toBeGreaterThan(1)

    theme.dispose()

    expect([...vars.keys()]).toEqual(['--app-owned'])
  })

  it('does not touch the DOM when the container has none', () => {
    const bare = {} as unknown as HTMLElement

    expect(() => {
      const theme = new FlexiThemeManager(bare)
      theme.set({ css: '.fx-toolbar { color: red }' })
      theme.dispose()
    }).not.toThrow()
  })
})
