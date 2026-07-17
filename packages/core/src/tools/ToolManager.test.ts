import { describe, expect, it, vi } from 'vitest'
import { BlaeuEventBus } from '../events/EventBus.js'
import { BlaeuToolManager } from './ToolManager.js'
import type { Tool } from '../types/extensions.js'

/** A tool that records its own lifecycle into a shared transcript. */
function makeTool(id: string, log: string[]): Tool {
  return {
    id,
    activate: () => log.push(`${id}:activate`),
    deactivate: () => log.push(`${id}:deactivate`),
  }
}

function setup(): { events: BlaeuEventBus; tools: BlaeuToolManager; log: string[] } {
  const events = new BlaeuEventBus()
  const tools = new BlaeuToolManager(events)
  return { events, tools, log: [] }
}

describe('BlaeuToolManager', () => {
  it('registers, lists, and activates', () => {
    const { tools, log } = setup()
    tools.register('draw:polygon', makeTool('draw:polygon', log))

    expect(tools.list()).toEqual(['draw:polygon'])
    expect(tools.active).toBeNull()
    expect(tools.activeTool).toBeNull()

    tools.activate('draw:polygon')

    expect(tools.active).toBe('draw:polygon')
    expect(tools.activeTool?.id).toBe('draw:polygon')
    expect(log).toEqual(['draw:polygon:activate'])
  })

  it('emits tool:activated with the previous tool, and tool:deactivated for it', () => {
    const { events, tools, log } = setup()
    tools.register('a', makeTool('a', log))
    tools.register('b', makeTool('b', log))

    const activated = vi.fn()
    const deactivated = vi.fn()
    events.on('tool:activated', (e) => activated(e.payload))
    events.on('tool:deactivated', (e) => deactivated(e.payload))

    tools.activate('a')
    tools.activate('b')

    expect(activated).toHaveBeenNthCalledWith(1, { id: 'a', previous: null })
    expect(activated).toHaveBeenNthCalledWith(2, { id: 'b', previous: 'a' })
    expect(deactivated).toHaveBeenCalledWith({ id: 'a' })
  })

  it('deactivates the outgoing tool BEFORE activating the incoming one', () => {
    const { tools, log } = setup()
    tools.register('a', makeTool('a', log))
    tools.register('b', makeTool('b', log))

    tools.activate('a')
    tools.activate('b')

    // The ordering is the whole point: a half-finished polygon must be cleaned up
    // before the next tool starts drawing, or both tools are live at once.
    expect(log).toEqual(['a:activate', 'a:deactivate', 'b:activate'])
  })

  it('lets "before:tool:activate" veto the switch, leaving the current tool untouched', () => {
    const { events, tools, log } = setup()
    tools.register('a', makeTool('a', log))
    tools.register('locked', makeTool('locked', log))

    events.onBefore('before:tool:activate', (e) => {
      if (e.payload.id === 'locked') e.preventDefault('read-only user')
    })
    const activated = vi.fn()
    events.on('tool:activated', activated)

    tools.activate('a')
    log.length = 0
    activated.mockClear()

    tools.activate('locked')

    expect(tools.active).toBe('a')
    expect(log).toEqual([]) // 'a' was never deactivated
    expect(activated).not.toHaveBeenCalled()
  })

  it('fires the veto hook before any deactivation happens', () => {
    const { events, tools, log } = setup()
    tools.register('a', makeTool('a', log))
    tools.register('b', makeTool('b', log))

    // Recorded rather than asserted inline: the event bus swallows listener
    // exceptions by design, so a failing expect() in here would pass silently.
    const seen: (string | null)[] = []
    events.onBefore('before:tool:activate', () => {
      seen.push(tools.active)
    })

    tools.activate('a')
    tools.activate('b')

    // The outgoing tool is still active while the hook runs — a listener that
    // vetoes must see the world exactly as it will remain.
    expect(seen).toEqual([null, 'a'])
    expect(log).toEqual(['a:activate', 'a:deactivate', 'b:activate'])
  })

  it('treats re-activating the active tool as a no-op', () => {
    const { events, tools, log } = setup()
    tools.register('draw', makeTool('draw', log))
    const before = vi.fn()
    events.onBefore('before:tool:activate', before)

    tools.activate('draw')
    tools.activate('draw')

    // Not deactivate+reactivate: clicking the same toolbar button twice must not
    // discard the polygon the user is halfway through.
    expect(log).toEqual(['draw:activate'])
    expect(before).toHaveBeenCalledTimes(1)
  })

  it('deactivate() is idempotent and emits once', () => {
    const { events, tools, log } = setup()
    tools.register('a', makeTool('a', log))
    const deactivated = vi.fn()
    events.on('tool:deactivated', deactivated)

    tools.activate('a')
    tools.deactivate()
    tools.deactivate()

    expect(tools.active).toBeNull()
    expect(tools.activeTool).toBeNull()
    expect(log).toEqual(['a:activate', 'a:deactivate'])
    expect(deactivated).toHaveBeenCalledTimes(1)
  })

  it('unregistering the active tool deactivates it first', () => {
    const { tools, log } = setup()
    const handle = tools.register('a', makeTool('a', log))
    tools.activate('a')

    handle.dispose()

    expect(log).toEqual(['a:activate', 'a:deactivate'])
    expect(tools.active).toBeNull()
    expect(tools.list()).toEqual([])
  })

  it('unregistering an inactive tool leaves the active one alone', () => {
    const { tools, log } = setup()
    tools.register('a', makeTool('a', log))
    const b = tools.register('b', makeTool('b', log))
    tools.activate('a')

    b.dispose()

    expect(tools.active).toBe('a')
    expect(tools.list()).toEqual(['a'])
  })

  it('throws actionably on an unknown tool id, listing what is registered', () => {
    const { tools, log } = setup()
    tools.register('draw:polygon', makeTool('draw:polygon', log))

    expect(() => tools.activate('draw:circle')).toThrow(/no tool registered as "draw:circle"/)
    expect(() => tools.activate('draw:circle')).toThrow(/draw:polygon/)
  })

  it('refuses a duplicate registration', () => {
    const { tools, log } = setup()
    tools.register('a', makeTool('a', log))
    expect(() => tools.register('a', makeTool('a', log))).toThrow(/already registered/)
  })

  it('does not leave a throwing tool marked active', () => {
    const { tools } = setup()
    tools.register('boom', {
      id: 'boom',
      activate: () => {
        throw new Error('no WebGL')
      },
      deactivate: () => undefined,
    })

    expect(() => tools.activate('boom')).toThrow(/threw during activate\(\)/)
    expect(tools.active).toBeNull()
    expect(tools.activeTool).toBeNull()
  })
})
