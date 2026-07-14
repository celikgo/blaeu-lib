import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CAMERA, DEFAULT_CRS, DEFAULT_INTERACTION, resolveConfig } from './config.js'
import type { FlexiMapOptions } from './types/config.js'
import type { Preset } from './types/preset.js'
import type { Logger } from './types/common.js'

/** `resolveConfig` never touches the container, so it need not be a real element. */
const container = {} as HTMLElement

const options = (extra: Partial<FlexiMapOptions> = {}): FlexiMapOptions => ({
  container,
  ...extra,
})

const preset = (extra: Partial<Preset> = {}): Preset => ({ id: 'test', ...extra })

const fakeLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
})

const withNodeEnv = (value: string | undefined, fn: () => void): void => {
  const previous = process.env['NODE_ENV']
  if (value === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = previous
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveConfig', () => {
  describe('defaults', () => {
    it('fills every field when given nothing but a container', () => {
      const config = resolveConfig(options())

      expect(config.crs).toEqual(DEFAULT_CRS)
      expect(config.interaction).toEqual(DEFAULT_INTERACTION)
      expect(config.camera).toEqual(DEFAULT_CAMERA)
      expect(config.locale).toBe('en')
      expect(config.logger).toBeDefined()
      expect(typeof config.strict).toBe('boolean')
    })

    it('leaves no optional holes — ResolvedConfig has none', () => {
      const config = resolveConfig(options())

      for (const value of Object.values(config)) expect(value).toBeDefined()
      for (const value of Object.values(config.crs)) expect(value).toBeDefined()
      for (const value of Object.values(config.interaction)) expect(value).toBeDefined()
      for (const value of Object.values(config.camera)) expect(value).toBeDefined()
    })

    it('ignores the non-config fields of FlexiMapOptions', () => {
      const config = resolveConfig(
        options({ plugins: [], layers: [], theme: {}, preset: preset() }),
      )

      expect(config).not.toHaveProperty('container')
      expect(config).not.toHaveProperty('plugins')
      expect(config).not.toHaveProperty('preset')
      expect(config).not.toHaveProperty('renderer')
    })

    it('hands out a fresh object each call, so one map cannot poison another', () => {
      const a = resolveConfig(options())
      const b = resolveConfig(options())

      expect(a.crs).not.toBe(b.crs)
      expect(a.crs).toEqual(b.crs)
    })
  })

  describe('precedence: defaults < preset < options', () => {
    it('lets a preset override a default', () => {
      const config = resolveConfig(
        options(),
        preset({ config: { crs: { working: 'EPSG:5254', display: 'projected' } } }),
      )

      expect(config.crs.working).toBe('EPSG:5254')
      expect(config.crs.display).toBe('projected')
      // Untouched by the preset, so still the default.
      expect(config.crs.precision).toBe(DEFAULT_CRS.precision)
    })

    it('lets options override a preset', () => {
      const config = resolveConfig(
        options({ crs: { working: 'EPSG:5255' } }),
        preset({ config: { crs: { working: 'EPSG:5254', precision: 4 } } }),
      )

      expect(config.crs.working).toBe('EPSG:5255')
      // The preset's other opinions survive — this is the "municipality tweaks one
      // number in a national preset without forking it" case.
      expect(config.crs.precision).toBe(4)
    })

    it('merges each nested block field by field rather than replacing it', () => {
      const config = resolveConfig(
        options({ interaction: { dragThreshold: 8 } }),
        preset({ config: { interaction: { doubleClickZoom: false, scrollZoom: false } } }),
      )

      expect(config.interaction).toEqual({
        doubleClickZoom: false, // preset
        scrollZoom: false, // preset
        dragThreshold: 8, // options
        dragPan: true, // default
        keyboard: true, // default
      })
    })

    it('replaces the camera centre wholesale — there is no half a coordinate', () => {
      const config = resolveConfig(
        options({ camera: { center: [32.85, 39.93] } }),
        preset({ config: { camera: { center: [0, 0], zoom: 16 } } }),
      )

      expect(config.camera.center).toEqual([32.85, 39.93])
      expect(config.camera.zoom).toBe(16)
      expect(config.camera.bearing).toBe(DEFAULT_CAMERA.bearing)
      expect(config.camera.pitch).toBe(DEFAULT_CAMERA.pitch)
    })

    it('treats an explicit `false` as a value, not as absent', () => {
      const config = resolveConfig(
        options({ interaction: { doubleClickZoom: false }, strict: false }),
        preset({ config: { interaction: { doubleClickZoom: true }, strict: true } }),
      )

      expect(config.interaction.doubleClickZoom).toBe(false)
      expect(config.strict).toBe(false)
    })

    it('treats an explicit zero as a value, not as absent', () => {
      const config = resolveConfig(
        options({ crs: { precision: 0 }, camera: { zoom: 0 } }),
        preset({ config: { crs: { precision: 3 }, camera: { zoom: 12 } } }),
      )

      expect(config.crs.precision).toBe(0)
      expect(config.camera.zoom).toBe(0)
    })

    it('ignores an explicit `undefined` rather than letting it erase a preset', () => {
      const config = resolveConfig(
        // exactOptionalPropertyTypes forbids writing this in TypeScript, which is
        // the point: the shape arrives from a JS caller or from `{...spread}` of a
        // partially-filled options object, and resolveConfig must survive it.
        options({ crs: { working: undefined } } as unknown as Partial<FlexiMapOptions>),
        preset({ config: { crs: { working: 'EPSG:5254' } } }),
      )

      expect(config.crs.working).toBe('EPSG:5254')
    })
  })

  describe('locale', () => {
    it('defaults to en', () => {
      expect(resolveConfig(options()).locale).toBe('en')
    })

    it("reads the preset's top-level locale, which is where presets declare it", () => {
      expect(resolveConfig(options(), preset({ locale: 'tr' })).locale).toBe('tr')
    })

    it("prefers the preset's config.locale over its top-level locale", () => {
      const config = resolveConfig(options(), preset({ locale: 'tr', config: { locale: 'de' } }))

      expect(config.locale).toBe('de')
    })

    it('lets the host app override any preset locale', () => {
      const config = resolveConfig(
        options({ locale: 'en' }),
        preset({ locale: 'tr', config: { locale: 'de' } }),
      )

      expect(config.locale).toBe('en')
    })
  })

  describe('strict', () => {
    it('defaults to on outside production', () => {
      withNodeEnv('development', () => {
        expect(resolveConfig(options()).strict).toBe(true)
      })
    })

    it('defaults to off in production', () => {
      withNodeEnv('production', () => {
        expect(resolveConfig(options()).strict).toBe(false)
      })
    })

    it('defaults to on when NODE_ENV is not set at all — a browser bundle', () => {
      withNodeEnv(undefined, () => {
        expect(resolveConfig(options()).strict).toBe(true)
      })
    })

    it('lets a preset and then the host app override the environment', () => {
      withNodeEnv('production', () => {
        expect(resolveConfig(options(), preset({ config: { strict: true } })).strict).toBe(true)
        expect(resolveConfig(options({ strict: true })).strict).toBe(true)
      })
      withNodeEnv('development', () => {
        expect(resolveConfig(options({ strict: false })).strict).toBe(false)
      })
    })
  })

  describe('logger', () => {
    it('supplies a console logger when nobody else does', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      resolveConfig(options()).logger.warn('careful')

      expect(warn).toHaveBeenCalledWith('[fleximap] careful')
    })

    it('replaces the logger wholesale rather than merging halves of two', () => {
      const fromOptions = fakeLogger()
      const fromPreset = fakeLogger()
      const config = resolveConfig(
        options({ logger: fromOptions }),
        preset({ config: { logger: fromPreset } }),
      )

      expect(config.logger).toBe(fromOptions)
    })

    it("falls back to the preset's logger", () => {
      const fromPreset = fakeLogger()
      const config = resolveConfig(options(), preset({ config: { logger: fromPreset } }))

      expect(config.logger).toBe(fromPreset)
    })

    it('gates debug on strict, so the pointer path pays nothing in production', () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})

      resolveConfig(options({ strict: false })).logger.debug('noisy')
      expect(debug).not.toHaveBeenCalled()

      resolveConfig(options({ strict: true })).logger.debug('noisy')
      expect(debug).toHaveBeenCalledWith('[fleximap] noisy')
    })
  })

  describe('a realistic preset', () => {
    it('resolves the cadastre-then-municipality layering', () => {
      const cadastre = preset({
        id: 'cadastre',
        locale: 'tr',
        config: {
          crs: { working: 'EPSG:5254', display: 'projected', precision: 3 },
          interaction: { doubleClickZoom: false }, // double-click closes a ring
        },
      })

      const config = resolveConfig(
        options({ crs: { precision: 4 }, camera: { center: [32.85, 39.93], zoom: 18 } }),
        cadastre,
      )

      expect(config).toEqual({
        crs: { working: 'EPSG:5254', display: 'projected', precision: 4 },
        interaction: {
          doubleClickZoom: false,
          dragPan: true,
          scrollZoom: true,
          keyboard: true,
          dragThreshold: 3,
        },
        locale: 'tr',
        camera: { center: [32.85, 39.93], zoom: 18, bearing: 0, pitch: 0 },
        logger: config.logger,
        strict: config.strict,
      })
    })
  })
})
