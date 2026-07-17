import type { LayerSpec, LayerStyle } from '@blaeu/core'
import type { AttributeField, AttributeSchema, AttributeSchemas, ZoningCategory } from './types.js'

/**
 * The default legend: the five categories every Turkish imar planı has, in the
 * colours the legend of every Turkish imar planı uses.
 *
 * The colours are not a design choice. A planner reads a plan by colour before they
 * read a single label — yellow is where people live, red is commerce, purple is
 * industry, green is protected, blue is public. Re-theming those to fit a brand
 * palette produces a map that is *pretty and unreadable*, which is why they are
 * defaults with real values rather than a `TODO: pick colours`.
 *
 * The caps are plausible district-plan values, not law. Every plan sets its own, and
 * that is precisely why they are data on the category rather than constants in a
 * validator: a municipality passes its own `zoningCategories` and the attribute
 * forms, the fill expression and the area report all follow.
 */
export const DEFAULT_ZONING_CATEGORIES: readonly ZoningCategory[] = Object.freeze([
  {
    code: 'K',
    label: 'Konut Alanı',
    color: '#f6c244',
    maxFar: 1.5,
    maxCoverage: 0.4,
    maxHeight: 15.5,
  },
  {
    code: 'T',
    label: 'Ticaret Alanı',
    color: '#e4572e',
    maxFar: 2.0,
    maxCoverage: 0.5,
    maxHeight: 18.5,
  },
  {
    code: 'S',
    label: 'Sanayi Alanı',
    color: '#8e5ba6',
    maxFar: 1.0,
    maxCoverage: 0.6,
    maxHeight: 12.5,
  },
  // Yeşil alan carries no caps on purpose: what is buildable in a park is set case
  // by case (a büfe, a kır kahvesi), and inventing a KAKS for it here would put a
  // number a plan never wrote into a form a planner will believe.
  { code: 'YA', label: 'Yeşil Alan', color: '#4c9f70' },
  {
    code: 'D',
    label: 'Donatı Alanı',
    color: '#4a7fc1',
    maxFar: 1.5,
    maxCoverage: 0.4,
    maxHeight: 15.5,
  },
])

/** Colour for a polygon whose zoning code is missing or not in the legend. Deliberately drab. */
export const UNZONED_COLOR = '#b8b8b8'

/**
 * The `match` expression that colours **N categories in one layer**.
 *
 * This is the idiomatic answer to "how do I style a legend?", and it is worth
 * spelling out, because the obvious alternative — one layer per category, each with
 * a filter — is what most codebases do and it is a trap:
 *
 * ```
 * ['match', ['get', 'zoning'], 'K', '#f6c244', 'T', '#e4572e', …, '#b8b8b8']
 * ```
 *
 * One layer means one source read, one draw call, one z-order, and one place to
 * change the opacity. Ten layers means ten of each, a z-fight between two categories
 * that happen to touch, and — the real cost — a *new layer to register every time
 * the legend grows*, which puts the legend back in code. Here the legend stays data:
 * `zoningCategories` in, expression out.
 *
 * The trailing fallback is mandatory in MapLibre's `match`, and it earns its keep:
 * a polygon drawn before its category existed, or imported from a plan with a code
 * we don't know, renders grey rather than not at all.
 */
export function zoningFillColour(
  categories: readonly ZoningCategory[],
  property: string,
  fallback: string = UNZONED_COLOR,
): unknown[] {
  const expression: unknown[] = ['match', ['get', property]]
  for (const category of categories) {
    expression.push(category.code, category.color)
  }
  expression.push(fallback)
  return expression
}

/** Layer ids the preset owns. Exported so a host app can `map.layers.get(...)` them by name. */
export const ZONING_FILL_LAYER = 'zoning-fill'
export const ZONING_OUTLINE_LAYER = 'zoning-outline'

export interface ZoningLayerOptions {
  readonly categories: readonly ZoningCategory[]
  readonly collection: string
  readonly property: string
  readonly fillOpacity: number
  readonly schema: AttributeSchemas
}

/**
 * The zoning fill + its outline, over one collection and one source.
 *
 * Two layers, not one, because MapLibre draws a polygon's fill and its stroke as
 * separate layers and a shared boundary drawn once per polygon is drawn twice —
 * which at 55 % opacity is visibly darker than a boundary drawn once. Both point at
 * the same collection, and the layer manager ref-counts the source, so this costs
 * one upload, not two.
 */
export function zoningLayers(options: ZoningLayerOptions): readonly LayerSpec[] {
  const fill: LayerStyle = {
    fill: {
      color: zoningFillColour(options.categories, options.property),
      opacity: options.fillOpacity,
    },
  }

  const outline: LayerStyle = {
    line: {
      // Darker than the fill it belongs to, so the boundary reads at any zoom, and
      // derived from the same expression so a new category needs no second edit.
      color: zoningFillColour(options.categories, options.property),
      width: 1.5,
      opacity: 0.9,
    },
  }

  return [
    {
      id: ZONING_FILL_LAYER,
      type: 'vector',
      source: options.collection,
      style: fill,
      // `Preset` has no `attributes` field, and it should not grow one for a single
      // domain. `LayerSpec.config` is the sanctioned per-layer bag, and putting the
      // forms here keeps them *inside the preset value* — a host app reads
      // `preset.layers[0].config.attributes` and renders a form without ever
      // constructing a map. That is what "a preset is data" buys.
      config: { attributes: options.schema, categories: options.categories },
    },
    {
      id: ZONING_OUTLINE_LAYER,
      type: 'vector',
      source: options.collection,
      style: outline,
    },
  ]
}

/* ------------------------------------------------------------------ *
 * Attribute forms
 * ------------------------------------------------------------------ */

/** Property names the preset writes. A host app's form binds to these. */
export const FIELD = {
  zoning: 'zoning',
  far: 'kaks',
  coverage: 'taks',
  height: 'gabari',
  note: 'planNotu',
} as const

/**
 * One form per category, derived from the legend.
 *
 * Derived rather than hand-written because the two must not drift: a category whose
 * plan caps KAKS at 1.5 and a form that lets a planner type 2.0 disagree about what
 * the plan says, and the form is the one the planner believes. So the caps flow one
 * way — category → field `max` → the number a UI can enforce — and a new category
 * arrives with a correct form already attached.
 */
export function zoningAttributeSchema(
  categories: readonly ZoningCategory[],
  property: string = FIELD.zoning,
): AttributeSchemas {
  const categoryOptions = categories.map((category) => ({
    value: category.code,
    labelKey: `urban.zoning.${category.code}`,
  }))

  const schemas: Record<string, AttributeSchema> = {}
  for (const category of categories) {
    const fields: AttributeField[] = [
      {
        name: property,
        labelKey: 'urban.field.zoning',
        type: 'select',
        required: true,
        options: categoryOptions,
      },
      numberField(FIELD.far, 'urban.field.kaks', 0.01, category.maxFar),
      numberField(FIELD.coverage, 'urban.field.taks', 0.01, category.maxCoverage),
      numberField(FIELD.height, 'urban.field.gabari', 0.5, category.maxHeight, 'm'),
      { name: FIELD.note, labelKey: 'urban.field.planNotu', type: 'text' },
    ]
    schemas[category.code] = { category: category.code, fields }
  }
  return Object.freeze(schemas)
}

/**
 * `exactOptionalPropertyTypes` is on, so `{ max: undefined }` is not the same type
 * as `{}` — and it is not the same *meaning* either: an absent `max` is "the plan
 * sets no cap here", which is exactly the case for yeşil alan.
 */
function numberField(
  name: string,
  labelKey: string,
  step: number,
  max: number | undefined,
  unit?: string,
): AttributeField {
  return {
    name,
    labelKey,
    type: 'number',
    min: 0,
    step,
    ...(max !== undefined ? { max } : {}),
    ...(unit !== undefined ? { unit } : {}),
  }
}
