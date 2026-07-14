/**
 * The stylesheet, scoped to one map.
 *
 * Every colour, radius, font and stacking order is a `var(--fx-*)` written by the
 * core's ThemeManager. Nothing here hardcodes a palette, and no element in this
 * package carries an inline style for anything themeable — which is what
 * guarantees that the selected row in the issue panel is the same blue as the
 * selection halo on the map. Two files that "happen to agree today" drift, and
 * nobody notices who caused it.
 *
 * The only inline styles this package ever sets are `--fx-ui-x` / `--fx-ui-y` on
 * the snap indicator: those are the cursor's coordinates, which are data, not
 * design.
 *
 * Scoping is by attribute selector rather than by Shadow DOM. Shadow DOM would
 * isolate more completely, but it also walls the UI off from the host app's own
 * stylesheet — and a product team's first request is always "make the toolbar
 * look like the rest of our app".
 */
export function stylesheet(scope: string): string {
  const s = `[data-fx-ui="${scope}"]`

  return `
${s} {
  position: absolute;
  inset: 0;
  /* The chrome must not eat the map's pointer events; each control opts back in. */
  pointer-events: none;
  font-family: var(--fx-font-family, system-ui, sans-serif);
  font-size: var(--fx-font-size, 13px);
  color: var(--fx-color-text, #111);
  z-index: var(--fx-z-overlay, 10);
}

${s} .fx-ui-corner {
  position: absolute;
  display: flex;
  gap: 8px;
  padding: 8px;
  max-width: calc(100% - 16px);
  max-height: calc(100% - 16px);
}
${s} .fx-ui-corner-top-left { top: 0; left: 0; flex-direction: column; align-items: flex-start; }
${s} .fx-ui-corner-top-right { top: 0; right: 0; flex-direction: column; align-items: flex-end; }
${s} .fx-ui-corner-bottom-left { bottom: 0; left: 0; flex-direction: column; align-items: flex-start; }
${s} .fx-ui-corner-bottom-right { bottom: 0; right: 0; flex-direction: column; align-items: flex-end; }

${s} .fx-ui-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: var(--fx-z-indicator, 40);
}

${s} .fx-ui-control {
  pointer-events: auto;
  background: var(--fx-color-surface, #fff);
  border: 1px solid var(--fx-color-border, #d0d4da);
  border-radius: var(--fx-size-radius, 4px);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
}

/* One focus ring, everywhere, and it is always visible. A clerk who works this
   map by keyboard for eight hours must never have to guess where they are. */
${s} :focus-visible {
  outline: 2px solid var(--fx-color-accent, #2563eb);
  outline-offset: 1px;
}

/* ---------------------------------------------------------------- toolbar */

${s} .fx-ui-toolbar {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  padding: 2px;
  gap: 2px;
}

${s} .fx-ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: var(--fx-size-control-height, 32px);
  padding: 0 10px;
  border: 0;
  border-radius: var(--fx-size-radius, 4px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
${s} .fx-ui-button:hover:not(:disabled) { background: var(--fx-color-hover, #eef2f7); }
${s} .fx-ui-button:disabled { opacity: 0.45; cursor: default; }

/* The pressed state is driven by aria-pressed, not by a class. If the two can
   disagree, they will, and the screen-reader user is the one who finds out. */
${s} .fx-ui-button[aria-pressed='true'] {
  background: var(--fx-color-accent, #2563eb);
  color: var(--fx-color-surface, #fff);
}

${s} .fx-ui-button-icon { font-size: var(--fx-font-size, 13px); line-height: 1; }

/* ------------------------------------------------------------- readouts */

${s} .fx-ui-readout {
  pointer-events: auto;
  padding: 4px 8px;
  background: var(--fx-color-surface, #fff);
  border: 1px solid var(--fx-color-border, #d0d4da);
  border-radius: var(--fx-size-radius, 4px);
  /* Coordinates are compared column-by-column; a proportional font makes that
     needlessly hard, and a surveyor does it hundreds of times a day. */
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  white-space: nowrap;
}
${s} .fx-ui-readout-empty { color: var(--fx-color-text-muted, #6b7280); }

${s} .fx-ui-measure { font-weight: 600; }
${s} .fx-ui-measure[hidden] { display: none; }

/* -------------------------------------------------------------- scale bar */

${s} .fx-ui-scale {
  pointer-events: auto;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 2px 6px;
  background: var(--fx-color-surface, #fff);
  border: 1px solid var(--fx-color-border, #d0d4da);
  border-radius: var(--fx-size-radius, 4px);
  font-size: var(--fx-font-size-small, 11px);
}
${s} .fx-ui-scale-bar {
  height: 6px;
  border: 1px solid var(--fx-color-text, #111);
  border-top: 0;
}

/* ------------------------------------------------------------ attribution */

${s} .fx-ui-attribution {
  pointer-events: auto;
  padding: 2px 6px;
  background: var(--fx-color-surface-muted, #f3f4f6);
  border-radius: var(--fx-size-radius, 4px);
  color: var(--fx-color-text-muted, #6b7280);
  font-size: var(--fx-font-size-small, 11px);
}

/* ---------------------------------------------------------- snap indicator */

${s} .fx-ui-snap {
  position: absolute;
  /* The cursor's position, in pixels, fed by the interaction pipeline. */
  left: var(--fx-ui-x, 0px);
  top: var(--fx-ui-y, 0px);
  /* Offset so the tooltip never sits under the cursor it is describing. */
  transform: translate(14px, 14px);
  padding: 1px 6px;
  background: var(--fx-color-snap-indicator, #f59e0b);
  border-radius: var(--fx-size-radius, 4px);
  color: var(--fx-color-surface, #fff);
  font-size: var(--fx-font-size-small, 11px);
  white-space: nowrap;
}
${s} .fx-ui-snap[hidden] { display: none; }

/* ------------------------------------------------------------- issue panel */

${s} .fx-ui-issues {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  min-width: 220px;
  max-width: 320px;
  max-height: 240px;
  background: var(--fx-color-surface, #fff);
  border: 1px solid var(--fx-color-border, #d0d4da);
  border-radius: var(--fx-size-radius, 4px);
}
${s} .fx-ui-issues[hidden] { display: none; }
${s} .fx-ui-issues-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--fx-color-border, #d0d4da);
  font-weight: 600;
}
${s} .fx-ui-issues-list {
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
${s} .fx-ui-issue {
  display: flex;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-left: 3px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
${s} .fx-ui-issue:hover { background: var(--fx-color-hover, #eef2f7); }
${s} .fx-ui-issue-error { border-left-color: var(--fx-color-error, #dc2626); }
${s} .fx-ui-issue-warning { border-left-color: var(--fx-color-warning, #d97706); }
${s} .fx-ui-issue-info { border-left-color: var(--fx-color-accent, #2563eb); }

/* ------------------------------------------------------------- status line */

${s} .fx-ui-status {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
  padding: 3px 10px;
  background: var(--fx-color-surface, #fff);
  border: 1px solid var(--fx-color-border, #d0d4da);
  border-radius: var(--fx-size-radius, 4px);
  color: var(--fx-color-text-muted, #6b7280);
  pointer-events: none;
}
${s} .fx-ui-status:empty { display: none; }
`
}
