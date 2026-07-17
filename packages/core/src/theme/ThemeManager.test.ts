import { describe, expect, it, vi } from 'vitest'
import { BlaeuThemeManager } from './ThemeManager.js'
import { defaultTheme } from './defaultTheme.js'
import { twitterLight } from './themes/index.js'

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

describe('BlaeuThemeManager', () => {
  it('writes every token into the container as a CSS custom property', () => {
    const { element, vars } = stubContainer()
    new BlaeuThemeManager(element)

    // The single source of truth: the same number the map reads through token() is
    // the one the chrome reads through var().
    expect(vars.get('--bl-color-accent')).toBe(defaultTheme.tokens.color.accent)
    expect(vars.get('--bl-color-snap-indicator')).toBe(defaultTheme.tokens.color.snapIndicator)
    expect(vars.get('--bl-size-vertex-radius')).toBe('5px')
    expect(vars.get('--bl-font-size')).toBe('13px')
    // Stacking order is unitless; a `z-index: 30px` is simply ignored by CSS.
    expect(vars.get('--bl-z-indicator')).toBe('30')
  })

  it('deep-merges a partial theme and leaves untouched tokens alone', () => {
    const { element, vars } = stubContainer()
    const theme = new BlaeuThemeManager(element)

    theme.set({ id: 'cadastre', tokens: { color: { accent: '#b91c1c' } } })

    expect(theme.current.id).toBe('cadastre')
    expect(theme.token('color').accent).toBe('#b91c1c')
    expect(theme.token('color').snapIndicator).toBe(defaultTheme.tokens.color.snapIndicator)
    expect(theme.token('size').vertexRadius).toBe(defaultTheme.tokens.size.vertexRadius)
    expect(vars.get('--bl-color-accent')).toBe('#b91c1c')
  })

  it('hands plugins raw numbers, not CSS strings', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)

    // A MapLibre paint expression wants 5, not '5px'.
    expect(theme.token('size').vertexRadius).toBe(5)
  })

  it('notifies subscribers on set, and stops when disposed', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)
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
    const theme = new BlaeuThemeManager(element)
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

    const theme = new BlaeuThemeManager(element)
    expect(vars.size).toBeGreaterThan(1)

    theme.dispose()

    expect([...vars.keys()]).toEqual(['--app-owned'])
  })

  it('does not touch the DOM when the container has none', () => {
    const bare = {} as unknown as HTMLElement

    expect(() => {
      const theme = new BlaeuThemeManager(bare)
      theme.set({ css: '.bl-toolbar { color: red }' })
      theme.dispose()
    }).not.toThrow()
  })
})

describe('BlaeuThemeManager — registry', () => {
  it('pre-registers the built-in themes, so use() works with no setup', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)

    const ids = theme.list().map((t) => t.id)
    expect(ids).toContain('twitter-light')
    expect(ids).toContain('twitter-dim')
    expect(theme.has('twitter-dim')).toBe(true)

    theme.use('twitter-dim')
    expect(theme.current.id).toBe('twitter-dim')
    expect(theme.scheme).toBe('dark')
  })

  it('throws on use() of an unknown id, listing what is registered', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)
    expect(() => theme.use('mardi-gras')).toThrow(/no theme with that id/)
    // A silent no-op would be a blank map nobody can explain; the id list is the clue.
    expect(() => theme.use('mardi-gras')).toThrow(/twitter-dim/)
  })

  it('registers a custom theme and activates it by id', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)

    theme.register({
      ...defaultTheme,
      id: 'brand',
      scheme: 'light',
      tokens: {
        ...defaultTheme.tokens,
        color: { ...defaultTheme.tokens.color, accent: '#ff0000' },
      },
    })
    theme.use('brand')
    expect(theme.token('color').accent).toBe('#ff0000')
  })
})

describe('BlaeuThemeManager — light/dark policy', () => {
  it('follow("dark") pins the registered dark default', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)
    theme.setSchemeDefaults({ light: 'twitter-light', dark: 'twitter-dim' })

    theme.follow('dark')
    expect(theme.current.id).toBe('twitter-dim')

    theme.follow('light')
    expect(theme.current.id).toBe('twitter-light')
  })

  it('an explicit use() wins over a following scheme', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)
    theme.follow('dark')
    expect(theme.scheme).toBe('dark')

    theme.use('survey-paper')
    // The manual pin sticks — a later scheme default does not silently reclaim it.
    expect(theme.current.id).toBe('survey-paper')
    expect(theme.scheme).toBe('light')
  })

  it('setSchemeDefaults rejects an unregistered id', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)
    expect(() => theme.setSchemeDefaults({ light: 'nope', dark: 'twitter-dim' })).toThrow(
      /not registered/,
    )
  })
})

describe('BlaeuThemeManager — basemap/css merge', () => {
  it('null clears a previous theme basemap; undefined leaves it', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)

    theme.set({ basemap: { version: 8, sources: {}, layers: [] } })
    expect(theme.current.basemap).toBeDefined()

    // A sparse patch that says nothing about the basemap inherits it.
    theme.set({ tokens: { color: { accent: '#123456' } } })
    expect(theme.current.basemap).toBeDefined()

    // An explicit null clears it — the case a dark→no-basemap switch depends on.
    theme.set({ basemap: null })
    expect(theme.current.basemap).toBeUndefined()
  })

  it('use() replaces css and basemap rather than inheriting the previous theme', () => {
    const { element } = stubContainer()
    const theme = new BlaeuThemeManager(element)

    theme.use('survey-paper') // ships scoped css and a flat basemap
    expect(theme.current.css).toBeTruthy()
    expect(theme.current.basemap).toBeDefined()

    theme.use('twitter-light') // ships neither css of its own
    // Authoritative activation: the omitted css is CLEARED, not left over from
    // survey-paper — otherwise a light theme would carry the last theme's rules.
    expect(theme.current.css).toBeUndefined()
    expect(theme.current.basemap).toBe(twitterLight.basemap)
  })

  it('writes color-scheme onto the container so native controls flip', () => {
    const { element } = stubContainer()
    const seen = new Map<string, string>()
    const el = {
      style: {
        setProperty: (n: string, v: string) => seen.set(n, v),
        removeProperty: (n: string) => seen.delete(n),
      },
      setAttribute: () => {},
      removeAttribute: () => {},
    } as unknown as HTMLElement
    void element

    const theme = new BlaeuThemeManager(el)
    theme.use('twitter-dim')
    expect(seen.get('color-scheme')).toBe('dark')
    theme.use('twitter-light')
    expect(seen.get('color-scheme')).toBe('light')
  })
})
