import { describe, expect, it, vi } from 'vitest'

import { BlaeuPluginManager } from './PluginManager.js'
import { BlaeuEventBus } from '../events/EventBus.js'
import type { PluginContext } from '../types/plugin.js'
import type { BlaeuPlugin } from '../types/plugin.js'

/**
 * The manager under test, with a minimal context factory. These are unit tests: the
 * plugins are trivial, so the only ctx member they ever touch is `disposables` (which
 * `remove()`/`destroyAll()` dispose). A real `PluginContext` is the map's job.
 */
function manager(): BlaeuPluginManager {
  return new BlaeuPluginManager(
    (_plugin, _options, disposables) => ({ disposables }) as unknown as PluginContext<unknown>,
    new BlaeuEventBus(),
  )
}

function plugin(id: string, setup: () => unknown = () => ({})): BlaeuPlugin {
  return { id, setup } as BlaeuPlugin
}

describe('BlaeuPluginManager — duplicate install', () => {
  it('rejects a concurrent duplicate and runs setup exactly once', async () => {
    const mgr = manager()
    const setup = vi.fn(() => ({ ok: true }))
    const p = plugin('dup', setup)

    // The map installs plugins with Promise.all, so a preset that lists the same plugin
    // twice (often from composing two presets that both include it) submits two use()
    // calls that run concurrently. Only one may install.
    const results = await Promise.allSettled([mgr.use(p), mgr.use(p)])

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason)).toMatch(/already installed \(or still installing\)/)

    // The whole point: setup ran once, so listeners and layers were registered once.
    expect(setup).toHaveBeenCalledTimes(1)
    expect(mgr.list()).toHaveLength(1)
  })

  it('rejects a sequential duplicate', async () => {
    const mgr = manager()
    const p = plugin('dup')
    await mgr.use(p)
    await expect(mgr.use(p)).rejects.toThrow(/already installed/)
    expect(mgr.list()).toHaveLength(1)
  })

  it('allows re-install after remove — the in-flight guard must not outlive the install', async () => {
    const mgr = manager()
    const p = plugin('re')
    await mgr.use(p)
    await mgr.remove('re')

    await expect(mgr.use(p)).resolves.toBeDefined()
    expect(mgr.list()).toHaveLength(1)
  })

  it('allows a retry after a failed setup — a failed install clears the in-flight guard', async () => {
    const mgr = manager()
    let attempts = 0
    const p = plugin('flaky', () => {
      if (attempts++ === 0) throw new Error('boom')
      return { ok: true }
    })

    await expect(mgr.use(p)).rejects.toThrow(/failed during setup/)
    await expect(mgr.use(p)).resolves.toBeDefined()
    expect(mgr.list()).toHaveLength(1)
  })

  it('allows a retry after a dependency version check throws inside use()', async () => {
    const mgr = manager()
    await mgr.use({ id: 'dep', version: '1.0.0', setup: () => ({}) } as BlaeuPlugin)

    // A needs dep@^2, but dep@1 is installed — #missingDependencies throws inside use(),
    // *after* the id was announced. The guard must not then brick A forever.
    const a = { id: 'A', dependencies: [{ id: 'dep', range: '^2.0.0' }], setup: () => ({}) }
    await expect(mgr.use(a as BlaeuPlugin)).rejects.toThrow(/requires "dep@\^2\.0\.0"/)

    // Correct the version and retry: A must install, not be rejected as "already installing".
    await mgr.remove('dep')
    await mgr.use({ id: 'dep', version: '2.0.0', setup: () => ({}) } as BlaeuPlugin)
    await expect(mgr.use(a as BlaeuPlugin)).resolves.toBeDefined()
  })

  it('allows a retry after the context factory throws during install', async () => {
    let fail = true
    const mgr = new BlaeuPluginManager((plugin, _options, disposables) => {
      if (plugin.id === 'ctx-fail' && fail) throw new Error('ctx boom')
      return { disposables } as unknown as PluginContext<unknown>
    }, new BlaeuEventBus())

    const p = plugin('ctx-fail')
    await expect(mgr.use(p)).rejects.toThrow(/ctx boom/)
    fail = false
    await expect(mgr.use(p)).resolves.toBeDefined()
    expect(mgr.list()).toHaveLength(1)
  })

  it('rejects a parked plugin whose hard dependency arrives at a bad version, without hanging the drain', async () => {
    const mgr = manager()
    const b = { id: 'B', dependencies: [{ id: 'A', range: '^2.0.0' }], setup: () => ({}) }
    // B parks: A is not present yet. Capture the outcome so its later rejection is handled.
    const bOutcome = mgr.use(b as BlaeuPlugin).then(
      () => 'installed',
      (e: Error) => e.message,
    )

    // A arrives at 1.0.0 — incompatible with B's ^2.0.0. Installing A triggers the drain,
    // which finds B's dep now present-but-mismatched. That must reject B alone: A must
    // still install (the drain must not throw out and reject A's own use()).
    await expect(
      mgr.use({ id: 'A', version: '1.0.0', setup: () => ({}) } as BlaeuPlugin),
    ).resolves.toBeDefined()

    expect(await bOutcome).toMatch(/requires "A@\^2\.0\.0"/)
    expect(mgr.has('A')).toBe(true)
    expect(mgr.list().map((i) => i.id)).toEqual(['A'])
  })
})
