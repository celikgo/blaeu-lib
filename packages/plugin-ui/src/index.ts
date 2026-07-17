/**
 * `@blaeu/plugin-ui` — framework-free map chrome.
 *
 * ```ts
 * const map = await createBlaeuMap({
 *   container: '#map',
 *   plugins: [drawPlugin(), uiPlugin({ attributions: ['© OpenStreetMap'] })],
 * })
 *
 * map.plugin('ui').status.set('hint', 'Click to place the first vertex')
 * ```
 */

export { uiPlugin } from './plugin.js'

export type {
  UiApi,
  UiOptions,
  ResolvedUiOptions,
  Control,
  ControlContext,
  ControlPosition,
  ControlSpec,
  MountSlot,
  ToolbarButton,
  ToolbarModel,
  PointerFeed,
  PointerSample,
  SnapSample,
} from './types.js'

export {
  toolbarControl,
  coordinateReadoutControl,
  snapIndicatorControl,
  historyButtonsControl,
  issuePanelControl,
  measureReadoutControl,
  scaleBarControl,
  attributionControl,
} from './controls/index.js'
export type { ScaleBarOptions, AttributionOptions } from './controls/index.js'

/** The plugin's own message bundles, so a preset can extend them rather than restate them. */
export { en as uiMessagesEn, tr as uiMessagesTr } from './messages.js'

import type { UiApi } from './types.js'

/**
 * The typed registry entry.
 *
 * This is what makes `map.plugin('ui')` resolve to `UiApi` with no cast, no
 * generic parameter and no import of an internal type — and what makes a typo in
 * the id a compile error rather than a runtime `undefined`.
 *
 * Note what is *not* here: an augmentation of `BlaeuEventMap`. This plugin emits
 * no events. It is a consumer of them, and a plugin that invents an event it never
 * fires has widened the global event map for nobody's benefit.
 */
declare module '@blaeu/core' {
  interface BlaeuPluginRegistry {
    ui: UiApi
  }
}
