/**
 * The three DOM primitives the whole package is built from.
 *
 * There is no framework here, and that is a decision rather than an omission: a
 * library that picks React halves its addressable audience on the day it ships,
 * and the UI surface of a map is a dozen elements — not a reason to take a
 * runtime dependency on someone else's rendering model.
 */

/** Create an element. `text` is set as `textContent` — this package never touches `innerHTML`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    readonly class?: string
    readonly text?: string
    readonly attrs?: Readonly<Record<string, string>>
    readonly children?: readonly HTMLElement[]
  } = {},
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (options.class !== undefined) element.className = options.class
  if (options.text !== undefined) element.textContent = options.text
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    element.setAttribute(name, value)
  }
  for (const child of options.children ?? []) element.appendChild(child)
  return element
}

/** A `<button type="button">`. `type` matters: inside a host app's `<form>`, the default submits it. */
export function button(className: string, label: string): HTMLButtonElement {
  const element = el('button', {
    class: className,
    attrs: { type: 'button', 'aria-label': label, title: label },
  })
  return element
}

/** Add a DOM listener and hand back a `Disposable`, so it can go straight into a store. */
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): { dispose(): void } {
  target.addEventListener(type, handler as EventListener)
  return {
    dispose: () => target.removeEventListener(type, handler as EventListener),
  }
}
