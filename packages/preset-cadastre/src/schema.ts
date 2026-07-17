import type {
  CollectionId,
  BlaeuFeature,
  Geometry,
  LngLat,
  Severity,
  ValidationIssue,
  ValidationRule,
} from '@blaeu/core'

/**
 * The parcel form's fields, as data.
 *
 * `ada` and `parsel` are not "some properties a parcel happens to have" — together
 * with `pafta` they *are* the parcel's identity in the Turkish land registry, the
 * way an IBAN is a bank account. Modelling them as free-form key/value would mean
 * a typo in a property name silently produces a parcel with no legal identifier,
 * and nothing would ever tell you.
 *
 * One schema drives both the form UI (labels, order, which inputs are read-only)
 * and the validation rule below. Two sources of truth for "which fields does a
 * parcel have" is how a form and a validator drift apart.
 */
export type AttributeType = 'string' | 'number'

export interface AttributeField {
  /** The key in `feature.properties`. ASCII, because it travels through shapefiles and CSVs. */
  readonly name: string
  readonly type: AttributeType
  /** i18n key for the label — never a literal, or the form is English forever. */
  readonly labelKey: string
  readonly required?: boolean
  /**
   * Computed by the software, never typed by a human.
   *
   * A derived field is rendered read-only and is not required on input: the commit
   * pipeline fills it. `yuzolcumu` is the whole reason this flag exists — a
   * hand-entered area that disagrees with the boundary it came from is the classic
   * cadastral dispute, and the fix is to make the number un-typeable.
   */
  readonly derived?: boolean
  /** Unit, for display. `'m2'` on the area. */
  readonly unit?: string
  /** Decimals shown for a number field. */
  readonly decimals?: number
  readonly maxLength?: number
  /** Source of a `RegExp`, not a `RegExp` — a preset must stay JSON-serialisable. */
  readonly pattern?: string
}

export interface AttributeSchema {
  readonly id: string
  readonly fields: readonly AttributeField[]
}

/**
 * The Turkish parcel record.
 *
 * `ada`/`parsel` are strings, not numbers, and that is a decision worth defending:
 * they are *identifiers*. They carry leading zeros in some registries, they are
 * compared for equality and never summed, and the day one of them arrives as
 * `102/3-A` a numeric column throws away the `-A`.
 */
export const parcelSchema: AttributeSchema = {
  id: 'cadastre.parcel',
  fields: [
    { name: 'ada', type: 'string', labelKey: 'cadastre.attr.ada', required: true, maxLength: 16 },
    {
      name: 'parsel',
      type: 'string',
      labelKey: 'cadastre.attr.parsel',
      required: true,
      maxLength: 16,
    },
    { name: 'pafta', type: 'string', labelKey: 'cadastre.attr.pafta', maxLength: 32 },
    { name: 'malik', type: 'string', labelKey: 'cadastre.attr.malik', maxLength: 255 },
    { name: 'nitelik', type: 'string', labelKey: 'cadastre.attr.nitelik', maxLength: 128 },
    { name: 'mevkii', type: 'string', labelKey: 'cadastre.attr.mevkii', maxLength: 128 },
    {
      name: 'yuzolcumu',
      type: 'number',
      labelKey: 'cadastre.attr.yuzolcumu',
      derived: true,
      unit: 'm2',
      decimals: 2,
    },
  ],
}

/** The derived area field's name, shared by the schema, the middleware and the labels. */
export const AREA_PROPERTY = 'yuzolcumu'

export const ATTRIBUTE_RULE_ID = 'cadastre.attributes'

export interface AttributeRuleOptions {
  readonly severity?: Severity
  /** Only features in this collection are parcels. Buildings have no ada/parsel. */
  readonly collection?: CollectionId
}

/**
 * "This parcel has no ada/parsel yet" — and, when one is typed, "that is not what
 * this field can hold".
 *
 * Severity is the preset's call, not this rule's: at the drawing board a missing
 * ada is a `warning` (the geometry comes first, the deed follows), and at a
 * submission boundary it is an `error`. Same rule, different judgement.
 */
export function parcelAttributesRule(
  schema: AttributeSchema,
  options: AttributeRuleOptions = {},
): ValidationRule {
  const severity: Severity = options.severity ?? 'warning'
  const collection = options.collection

  return {
    id: ATTRIBUTE_RULE_ID,
    severity,

    appliesTo(feature) {
      return collection === undefined || feature.meta.collection === collection
    },

    check(feature: BlaeuFeature, ctx): readonly ValidationIssue[] {
      const issues: ValidationIssue[] = []
      const at = firstPosition(feature.geometry)

      for (const field of schema.fields) {
        const value = feature.properties[field.name]

        if (value === undefined || value === null || value === '') {
          // A derived field being empty is our bug, not the surveyor's — the commit
          // middleware is supposed to have filled it — so it is never reported here.
          if (field.required === true && field.derived !== true) {
            issues.push({
              rule: ATTRIBUTE_RULE_ID,
              severity,
              message: ctx.t('cadastre.attr.missing', {
                feature: feature.id,
                field: ctx.t(field.labelKey),
              }),
              feature: feature.id,
              ...(at !== undefined ? { at } : {}),
              data: { field: field.name },
            })
          }
          continue
        }

        const actual =
          typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : 'other'
        if (actual !== field.type) {
          issues.push({
            rule: ATTRIBUTE_RULE_ID,
            severity,
            message: ctx.t('cadastre.attr.type', {
              feature: feature.id,
              field: ctx.t(field.labelKey),
              expected: field.type,
            }),
            feature: feature.id,
            ...(at !== undefined ? { at } : {}),
            data: { field: field.name, expected: field.type, actual },
          })
          continue
        }

        if (typeof value === 'string' && field.pattern !== undefined) {
          // Built here rather than held on the schema: a `RegExp` on the schema would
          // stop the preset being JSON-serialisable, and shipping a preset as config
          // over the wire is a thing this library promises.
          if (!new RegExp(field.pattern, 'u').test(value)) {
            issues.push({
              rule: ATTRIBUTE_RULE_ID,
              severity,
              message: ctx.t('cadastre.attr.pattern', {
                feature: feature.id,
                field: ctx.t(field.labelKey),
                value,
              }),
              feature: feature.id,
              ...(at !== undefined ? { at } : {}),
              data: { field: field.name, value },
            })
          }
        }

        if (
          typeof value === 'string' &&
          field.maxLength !== undefined &&
          value.length > field.maxLength
        ) {
          issues.push({
            rule: ATTRIBUTE_RULE_ID,
            severity,
            message: ctx.t('cadastre.attr.tooLong', {
              feature: feature.id,
              field: ctx.t(field.labelKey),
              max: field.maxLength,
            }),
            feature: feature.id,
            ...(at !== undefined ? { at } : {}),
            data: { field: field.name, max: field.maxLength },
          })
        }
      }

      return issues
    },
  }
}

/** Somewhere on the feature, so an issue list can offer "zoom to it". */
function firstPosition(geometry: Geometry): LngLat | undefined {
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) {
      const found = firstPosition(child)
      if (found !== undefined) return found
    }
    return undefined
  }

  let cursor: unknown = geometry.coordinates
  while (Array.isArray(cursor) && Array.isArray(cursor[0])) cursor = cursor[0]

  if (!Array.isArray(cursor)) return undefined
  const lng = cursor[0]
  const lat = cursor[1]
  if (typeof lng !== 'number' || typeof lat !== 'number') return undefined
  return [lng, lat]
}
