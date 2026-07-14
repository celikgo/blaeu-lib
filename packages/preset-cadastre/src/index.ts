/**
 * `@fleximap/preset-cadastre` — the kernel, aimed at a land registry.
 *
 * ```ts
 * const map = await createFlexiMap({
 *   container: '#map',
 *   preset: cadastrePreset({ crs: 'EPSG:5254', locale: 'tr' }),
 * })
 * ```
 *
 * The preset is plain data. Everything it decides — CRS, precision, snap
 * tolerance, rule severities, layer styling, the parcel form's fields — is an
 * option or an exported value you can compose over. Nothing in here needs a fork;
 * see the README's "Overriding without forking".
 */

export { cadastrePreset } from './preset.js'

export type { CadastreOptions, ResolvedCadastreOptions } from './options.js'
export {
  resolveCadastreOptions,
  DEFAULT_CADASTRE_CRS,
  DEFAULT_SNAP_TOLERANCE_PX,
  DEFAULT_SNAP_PROVIDERS,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_HANDLE_SIZE_PX,
  DEFAULT_AREA_DECIMALS,
  DEFAULT_PRECISION,
  PARCELS_COLLECTION,
  BUILDINGS_COLLECTION,
} from './options.js'

/** The parcel form's fields, as data: one schema drives the form *and* the rule. */
export type {
  AttributeField,
  AttributeSchema,
  AttributeType,
  AttributeRuleOptions,
} from './schema.js'
export { parcelSchema, parcelAttributesRule, AREA_PROPERTY, ATTRIBUTE_RULE_ID } from './schema.js'

/** The severities — the preset's real contribution. Reuse them, or replace them. */
export { cadastreValidation, inCollection } from './validation.js'

export { cadastreLayers, PARCEL_LAYER, BUILDING_LAYER, PARCEL_LABEL_LAYER } from './layers.js'
export type { CadastreLayerOptions } from './layers.js'

export { cadastreTheme, paleRasterBasemap, CADASTRE_COLORS } from './theme.js'
export type { PaleBasemapOptions } from './theme.js'

export { cadastreMessages, tr, en } from './messages.js'

export { deriveAreaMiddleware, DERIVE_AREA_ID, DERIVE_AREA_PRIORITY } from './derive.js'
export type { DeriveAreaOptions } from './derive.js'
