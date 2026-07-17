import type { LngLat, Severity, ValidationIssue } from '@blaeu/core'
import { button, el } from '../dom.js'
import type { Control, ControlContext } from '../types.js'

/**
 * The list of things wrong with the data.
 *
 * Sources, in order of how much this control knows about them:
 *
 * - `validation:failed` — a core event. Always available; the commit pipeline
 *   emits it when a rule blocks a write.
 * - `topology:*` — the topology plugin's events, read **structurally**. An
 *   optional dependency: with no topology plugin the panel simply never fills from
 *   that source, and no listener anywhere is left dangling.
 *
 * Clicking an issue flies the camera to `issue.at`. That single affordance is what
 * turns a validation error from an accusation into a fix: a surveyor with an
 * overlapping parcel needs to be *at* the overlap, not told that one exists.
 */
export function issuePanelControl(): Control {
  return {
    id: 'issues',

    render(ctx: ControlContext): HTMLElement {
      let issues: readonly ValidationIssue[] = []

      const element = el('div', {
        class: 'bl-ui-control bl-ui-issues',
        attrs: { role: 'region', 'aria-label': ctx.i18n.t('ui.issues') },
      })
      element.hidden = true

      const title = el('span', { text: ctx.i18n.t('ui.issues') })
      const dismiss = button('bl-ui-button', ctx.i18n.t('ui.issues.dismiss'))
      dismiss.appendChild(
        el('span', { class: 'bl-ui-button-icon', text: '×', attrs: { 'aria-hidden': 'true' } }),
      )

      const head = el('div', { class: 'bl-ui-issues-head', children: [title, dismiss] })
      const list = el('ul', { class: 'bl-ui-issues-list', attrs: { 'aria-live': 'polite' } })
      element.append(head, list)

      const render = (): void => {
        title.textContent =
          issues.length === 0
            ? ctx.i18n.t('ui.issues')
            : ctx.i18n.t('ui.issues.count', { count: issues.length })
        dismiss.setAttribute('aria-label', ctx.i18n.t('ui.issues.dismiss'))

        list.replaceChildren()
        element.hidden = issues.length === 0
        for (const issue of issues) list.appendChild(renderIssue(ctx, issue))
      }

      const set = (next: readonly ValidationIssue[]): void => {
        issues = next
        render()
      }

      dismiss.addEventListener('click', () => set([]))

      ctx.disposables.add(ctx.events.on('validation:failed', (event) => set(event.payload.issues)))

      // Anything the topology plugin says about issues, without importing it. A
      // payload we cannot read is ignored rather than treated as "no issues" — a
      // panel that clears itself on an event it did not understand hides the very
      // errors it exists to show.
      ctx.disposables.add(
        ctx.events.onAny('topology:*', (event) => {
          const found = readIssues(event.payload)
          if (found) set(found)
        }),
      )

      // Fixing the geometry is what clears the panel: a re-validated write that
      // succeeds means the issues no longer hold.
      ctx.disposables.add(ctx.events.on('feature:updated', () => set([])))
      ctx.disposables.add(ctx.i18n.onChange(render))

      render()
      return element
    },
  }
}

function renderIssue(ctx: ControlContext, issue: ValidationIssue): HTMLElement {
  const severity: Severity = issue.severity
  const node = button(`bl-ui-issue bl-ui-issue-${severity}`, issue.message)
  node.appendChild(el('span', { text: issue.message }))

  const at = issue.at
  if (at === undefined) {
    // Nothing to fly to. Keep it in the list — the message is still the point — but
    // do not offer an affordance that does nothing.
    node.disabled = true
    return node
  }

  node.setAttribute('aria-label', `${issue.message} — ${ctx.i18n.t('ui.issues.zoomTo')}`)
  node.addEventListener('click', () => flyTo(ctx, at))
  return node
}

function flyTo(ctx: ControlContext, at: LngLat): void {
  // Through the renderer, not through MapLibre: a product on the Three.js renderer
  // (or the test harness's fake one) must fly to an issue exactly the same way.
  ctx.renderer.setCamera({ center: at, duration: 400 })
}

/**
 * Pull validation issues out of an unknown payload.
 *
 * Structural on purpose — see `optional.ts`. Returns `undefined` when the payload
 * is not an issue list, which is different from an empty list.
 */
function readIssues(payload: unknown): readonly ValidationIssue[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined

  const value = (payload as Record<string, unknown>)['issues']
  if (!Array.isArray(value)) return undefined

  const issues = value.filter(isIssue)
  // A partially-readable payload is a bug somewhere upstream, but silently showing
  // half of it is worse than showing none: the user would trust the count.
  return issues.length === value.length ? issues : undefined
}

function isIssue(value: unknown): value is ValidationIssue {
  if (typeof value !== 'object' || value === null) return false
  const issue = value as Record<string, unknown>
  return (
    typeof issue['message'] === 'string' &&
    typeof issue['rule'] === 'string' &&
    (issue['severity'] === 'error' ||
      issue['severity'] === 'warning' ||
      issue['severity'] === 'info')
  )
}
