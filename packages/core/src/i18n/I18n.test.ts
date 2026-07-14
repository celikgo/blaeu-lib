import { describe, expect, it, vi } from 'vitest'
import { FlexiI18n } from './I18n.js'

describe('FlexiI18n', () => {
  describe('the fallback chain', () => {
    it('prefers the requested locale', () => {
      const i18n = new FlexiI18n('tr')
      i18n.register('tr', { 'draw.polygon': 'Poligon çiz' })
      i18n.register('en', { 'draw.polygon': 'Draw polygon' })

      expect(i18n.t('draw.polygon')).toBe('Poligon çiz')
    })

    it('falls back to en when the locale is missing the key', () => {
      const i18n = new FlexiI18n('tr')
      i18n.register('en', { 'draw.polygon': 'Draw polygon' })

      expect(i18n.t('draw.polygon')).toBe('Draw polygon')
    })

    it('falls back from a regional tag to its base language', () => {
      const i18n = new FlexiI18n('tr-TR')
      i18n.register('tr', { 'draw.polygon': 'Poligon çiz' })

      expect(i18n.t('draw.polygon')).toBe('Poligon çiz')
    })

    it('returns the key itself rather than throwing when nothing has it', () => {
      const i18n = new FlexiI18n('tr')

      // Ugly, not fatal — and the raw key names the string somebody has to add.
      expect(i18n.t('nobody.translated.this')).toBe('nobody.translated.this')
    })

    it('follows the locale after setLocale', () => {
      const i18n = new FlexiI18n('en')
      i18n.register('tr', { 'draw.polygon': 'Poligon çiz' })
      i18n.register('en', { 'draw.polygon': 'Draw polygon' })

      expect(i18n.t('draw.polygon')).toBe('Draw polygon')
      i18n.setLocale('tr')
      expect(i18n.t('draw.polygon')).toBe('Poligon çiz')
    })
  })

  describe('interpolation', () => {
    it('substitutes named params', () => {
      const i18n = new FlexiI18n('en')
      i18n.register('en', { 'draw.vertices': '{n} vertices' })

      expect(i18n.t('draw.vertices', { n: 3 })).toBe('3 vertices')
    })

    it('leaves an unsupplied placeholder standing rather than printing undefined', () => {
      const i18n = new FlexiI18n('en')
      i18n.register('en', { 'draw.vertices': '{n} vertices' })

      expect(i18n.t('draw.vertices', { wrong: 3 })).toBe('{n} vertices')
    })
  })

  describe('register', () => {
    it('lets a later registration win — this is how a preset overrides a plugin', () => {
      const i18n = new FlexiI18n('tr')
      i18n.register('tr', { 'draw.polygon': 'Poligon çiz' }) // the draw plugin
      i18n.register('tr', { 'draw.polygon': 'Parsel çiz' }) // the cadastre preset

      expect(i18n.t('draw.polygon')).toBe('Parsel çiz')
    })

    it('restores the key it shadowed when the overriding bundle is disposed', () => {
      const i18n = new FlexiI18n('tr')
      i18n.register('tr', { 'draw.polygon': 'Poligon çiz', 'draw.line': 'Çizgi çiz' })
      const preset = i18n.register('tr', { 'draw.polygon': 'Parsel çiz' })

      expect(i18n.t('draw.polygon')).toBe('Parsel çiz')

      preset.dispose()

      // Not deleted — *unshadowed*. Anything less than this and removing a preset at
      // runtime leaves the toolbar with blank labels.
      expect(i18n.t('draw.polygon')).toBe('Poligon çiz')
      expect(i18n.t('draw.line')).toBe('Çizgi çiz')
    })

    it('disposing one bundle does not disturb another that shadowed the same key', () => {
      const i18n = new FlexiI18n('en')
      const plugin = i18n.register('en', { 'draw.polygon': 'Draw polygon' })
      i18n.register('en', { 'draw.polygon': 'Draw parcel' })

      plugin.dispose()

      expect(i18n.t('draw.polygon')).toBe('Draw parcel')
    })

    it('cannot be mutated through the caller-supplied bundle', () => {
      const i18n = new FlexiI18n('en')
      const bundle = { 'draw.polygon': 'Draw polygon' }
      i18n.register('en', bundle)

      bundle['draw.polygon'] = 'Mutated'

      expect(i18n.t('draw.polygon')).toBe('Draw polygon')
    })

    it('does not let a plugin bundle override core silently in reverse', () => {
      const i18n = new FlexiI18n('en')
      // Core's own bundle is registered first, so a plugin bundle wins over it.
      i18n.register('en', { 'validation.severity.error': 'Blocked' })

      expect(i18n.t('validation.severity.error')).toBe('Blocked')
    })
  })

  describe('number and area formatting', () => {
    it('formats Turkish numbers with . for thousands and , for decimals', () => {
      const i18n = new FlexiI18n('tr')

      expect(i18n.number(1234.56, { minimumFractionDigits: 2 })).toBe('1.234,56')
      expect(i18n.area(1234.56)).toBe('1.234,56 m²')
    })

    it('formats English numbers the other way round', () => {
      const i18n = new FlexiI18n('en')

      expect(i18n.area(1234.56)).toBe('1,234.56 m²')
    })

    it('follows setLocale', () => {
      const i18n = new FlexiI18n('en')
      expect(i18n.area(1000)).toBe('1,000.00 m²')

      i18n.setLocale('tr')
      expect(i18n.area(1000)).toBe('1.000,00 m²')
    })

    it('takes the unit from the message bundle, so a preset can change it', () => {
      const i18n = new FlexiI18n('en')
      i18n.register('en', { 'units.squareMetre': 'm2' })

      expect(i18n.area(1)).toBe('1.00 m2')
    })

    it('falls back instead of throwing on a malformed BCP-47 tag', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // 'tr_TR' with an underscore is what a server-side locale string looks like,
      // and Intl throws a RangeError on it. A map must not go blank over that.
      const i18n = new FlexiI18n('tr_TR')

      expect(() => i18n.area(1234.56)).not.toThrow()
      expect(i18n.area(1234.56)).toBe('1,234.56 m²')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('onChange', () => {
    it('fires on setLocale and stops when disposed', () => {
      const i18n = new FlexiI18n('en')
      const seen: string[] = []
      const sub = i18n.onChange((locale) => seen.push(locale))

      i18n.setLocale('tr')
      i18n.setLocale('tr') // no-op: same locale
      sub.dispose()
      i18n.setLocale('en')

      expect(seen).toEqual(['tr'])
    })

    it('survives a handler that throws', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const i18n = new FlexiI18n('en')
      const seen: string[] = []

      i18n.onChange(() => {
        throw new Error('boom')
      })
      i18n.onChange((locale) => seen.push(locale))

      i18n.setLocale('tr')

      expect(seen).toEqual(['tr'])
      error.mockRestore()
    })
  })
})
