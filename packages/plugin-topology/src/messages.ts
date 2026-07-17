import type { Messages } from '@blaeu/core'

/**
 * The rule messages, in the two locales BlaeuMap ships.
 *
 * Exported so a preset that composes the rules **without** installing the plugin
 * still gets the strings: the rules go through `ctx.t()` for every word they say,
 * and `t()` falls back to the raw key when a bundle is missing — which renders as
 * `topology.overlap` in a surveyor's issue list. Registering these is not optional
 * for anyone using the rules.
 *
 * A caveat, and it is a real one: `ValidationContext` gives a rule `t()` and
 * nothing else — no `I18n` instance, so no `i18n.area()` and no `i18n.number()`.
 * The rules therefore pre-format their numbers with `toFixed` and pass them as
 * strings, which means a Turkish user sees `2.310` rather than `2,310`. Fixing
 * that properly means widening `ValidationContext` in the core.
 */

export const en: Messages = {
  'topology.selfIntersection': 'The boundary of {feature} crosses itself.',
  'topology.invalidGeometry': '{feature} is not a valid polygon: {detail}.',
  'topology.overlap': '{feature} overlaps {neighbour} by {area} m².',
  'topology.gap': 'There is a {area} m² gap between {feature} and {neighbour}.',
  'topology.minArea': '{feature} is {area} m², below the {minimum} m² minimum.',
  'topology.unclosedRing':
    'A ring of {feature} is not closed. Its last vertex must repeat its first.',
  'topology.shortRing': 'A ring of {feature} has fewer than three distinct vertices.',
  'topology.duplicateVertex':
    '{feature} has {count} duplicate vertex/vertices ({tolerance} m apart or less).',
  'topology.sliver': '{feature} is a sliver: its perimeter²/area ratio is {ratio} (limit {limit}).',

  'topology.fix.applied': 'Repaired {feature} ({rule}).',
  'topology.fix.unavailable':
    'No automatic repair exists for {rule}. This one is a decision, not a defect — a surveyor has to make it.',
}

export const tr: Messages = {
  'topology.selfIntersection': '{feature} sınırı kendisiyle kesişiyor.',
  'topology.invalidGeometry': '{feature} geçerli bir poligon değil: {detail}.',
  'topology.overlap': '{feature}, {neighbour} ile {area} m² çakışıyor.',
  'topology.gap': '{feature} ile {neighbour} arasında {area} m² boşluk var.',
  'topology.minArea': '{feature} {area} m², {minimum} m² asgari sınırının altında.',
  'topology.unclosedRing': '{feature} halkası kapalı değil. Son köşe ilk köşeyle aynı olmalı.',
  'topology.shortRing': '{feature} halkasında üçten az farklı köşe var.',
  'topology.duplicateVertex':
    '{feature} içinde {count} mükerrer köşe var ({tolerance} m veya daha yakın).',
  'topology.sliver': '{feature} bir kıymık: çevre²/alan oranı {ratio} (sınır {limit}).',

  'topology.fix.applied': '{feature} onarıldı ({rule}).',
  'topology.fix.unavailable':
    '{rule} için otomatik onarım yok. Bu bir kusur değil, bir karar — kararı harita mühendisi verir.',
}

/** Both bundles, keyed by locale. A preset spreads this into its own `i18n` block. */
export const topologyMessages: Readonly<Record<string, Messages>> = { en, tr }
