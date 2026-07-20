import { describe, expect, it, vi } from 'vitest'
import { BlaeuEventBus } from '../events/EventBus.js'
import { AsyncCommitPipeline } from '../pipeline/Pipeline.js'
import { BlaeuI18n } from '../i18n/I18n.js'
import { BlaeuValidationRegistry } from './ValidationRegistry.js'
import type { CrsService } from '../types/crs.js'
import type { BlaeuFeature } from '../types/feature.js'
import type { CommitContext } from '../types/pipeline.js'
import type { FeatureStore } from '../types/store.js'
import type { ValidationIssue, ValidationRule } from '../types/validation.js'

/**
 * The registry only ever hands the store and the CRS *through* to rules, so a stub
 * is honest here: a real store would test the store, not this.
 */
const store = {} as unknown as FeatureStore
const crs = {} as unknown as CrsService

function makeRegistry(): BlaeuValidationRegistry {
  return new BlaeuValidationRegistry(store, crs, new BlaeuI18n('en'))
}

function feature(id: string): BlaeuFeature {
  return {
    id,
    geometry: { type: 'Point', coordinates: [32.85, 39.93] },
    properties: {},
    meta: { collection: 'parcels', version: 1, createdAt: 0, updatedAt: 0 },
  }
}

function issue(rule: string, severity: ValidationIssue['severity'], id: string): ValidationIssue {
  return { rule, severity, message: `${rule} says no`, feature: id }
}

function commitContext(
  features: BlaeuFeature[],
  operation: CommitContext['operation'] = 'add',
): CommitContext {
  let rejected = false
  let rejectReason: string | undefined

  return {
    operation,
    features,
    previous: [],
    // Unused by the validation middleware under test (it reads its own CRS from the registry).
    crs: undefined as unknown as CommitContext['crs'],
    command: undefined,
    reject(reason: string) {
      rejected = true
      rejectReason = reason
    },
    get rejected() {
      return rejected
    },
    get rejectReason() {
      return rejectReason
    },
  }
}

describe('BlaeuValidationRegistry', () => {
  describe('the registry', () => {
    it('lists what was added and removes what was disposed', () => {
      const registry = makeRegistry()
      const rule: ValidationRule = { id: 'a', severity: 'error', check: () => [] }

      const sub = registry.add(rule)
      expect(registry.list()).toEqual([rule])

      sub.dispose()
      expect(registry.list()).toEqual([])
    })

    it('lets a later rule with the same id replace the earlier one', () => {
      const registry = makeRegistry()
      const first: ValidationRule = { id: 'parcel.minArea', severity: 'warning', check: () => [] }
      const second: ValidationRule = { id: 'parcel.minArea', severity: 'error', check: () => [] }

      const firstSub = registry.add(first)
      registry.add(second)

      expect(registry.list()).toEqual([second])

      // Disposing the *replaced* rule must not take the replacement with it.
      firstSub.dispose()
      expect(registry.list()).toEqual([second])
    })
  })

  describe('run', () => {
    it('uses appliesTo as a pre-filter and never calls check for a feature it excludes', async () => {
      const registry = makeRegistry()
      const check = vi.fn((_feature: BlaeuFeature): ValidationIssue[] => [])

      registry.add({
        id: 'parcels.only',
        severity: 'error',
        appliesTo: (f) => f.meta.collection === 'parcels',
        check,
      })

      const other: BlaeuFeature = {
        ...feature('b'),
        meta: { ...feature('b').meta, collection: 'buildings' },
      }
      await registry.run([feature('a'), other])

      expect(check).toHaveBeenCalledTimes(1)
      expect(check.mock.calls[0]?.[0]).toMatchObject({ id: 'a' })
    })

    it('turns a throwing rule into an error issue and still runs the others', async () => {
      const registry = makeRegistry()

      registry.add({
        id: 'explodes',
        severity: 'warning', // declared a warning, but a crash is never a warning
        check: () => {
          throw new Error('proj4 blew up')
        },
      })
      registry.add({
        id: 'still.runs',
        severity: 'warning',
        check: (f) => [issue('still.runs', 'warning', f.id)],
      })

      const issues = await registry.run([feature('a')])

      const thrown = issues.find((i) => i.rule === 'explodes')
      expect(thrown).toBeDefined()
      expect(thrown?.severity).toBe('error')
      expect(thrown?.message).toContain('explodes')
      expect(thrown?.message).toContain('proj4 blew up')

      // Failing closed must not mean failing *silently* on everything else.
      expect(issues.map((i) => i.rule)).toContain('still.runs')
    })

    it('catches a rule whose promise rejects, not just one that throws synchronously', async () => {
      const registry = makeRegistry()
      registry.add({
        id: 'server.down',
        severity: 'error',
        check: () => Promise.reject(new Error('registry unreachable')),
      })

      const issues = await registry.run([feature('a')])

      expect(issues).toHaveLength(1)
      expect(issues[0]?.severity).toBe('error')
      expect(issues[0]?.message).toContain('registry unreachable')
    })

    it('catches a throwing appliesTo as well', async () => {
      const registry = makeRegistry()
      const check = vi.fn((_feature: BlaeuFeature): ValidationIssue[] => [])

      registry.add({
        id: 'bad.filter',
        severity: 'error',
        appliesTo: () => {
          throw new Error('bad predicate')
        },
        check,
      })

      const issues = await registry.run([feature('a')])

      expect(issues).toHaveLength(1)
      expect(issues[0]?.severity).toBe('error')
      expect(check).not.toHaveBeenCalled()
    })
  })

  describe('asCommitMiddleware', () => {
    /** Registers validation plus a downstream spy, so a test can see whether next() ran. */
    function wire(registry: BlaeuValidationRegistry) {
      const events = new BlaeuEventBus()
      const commit = new AsyncCommitPipeline()
      const downstream = vi.fn(async (_ctx: CommitContext, next: () => Promise<void>) => {
        await next()
      })
      const failures: ValidationIssue[][] = []

      events.on('validation:failed', (e) => failures.push([...e.payload.issues]))
      const sub = registry.asCommitMiddleware(commit, events)
      // Below validation's own priority, so it only runs if validation called next().
      commit.use(downstream, { id: 'test:downstream', priority: -1000 })

      return { commit, events, downstream, failures, sub }
    }

    it('registers below the middleware that rewrites geometry, so it sees the final state', () => {
      const registry = makeRegistry()
      const { commit, sub } = wire(registry)

      const validation = commit.list().find((m) => m.id === 'core:validation')
      expect(validation).toBeDefined()
      expect(validation?.priority).toBeLessThan(0)

      // Invariant 5: everything that registers hands back a Disposable that really removes.
      sub.dispose()
      expect(commit.list().some((m) => m.id === 'core:validation')).toBe(false)
    })

    it('rejects the commit when a rule reports an error', async () => {
      const registry = makeRegistry()
      registry.add({
        id: 'geometry.valid',
        severity: 'error',
        check: (f) => [issue('geometry.valid', 'error', f.id)],
      })
      const { commit, downstream, failures } = wire(registry)

      const ctx = await commit.run(commitContext([feature('a')]))

      expect(ctx.rejected).toBe(true)
      expect(ctx.rejectReason).toContain('geometry.valid')
      expect(ctx.rejectReason).toContain('geometry.valid says no')
      // The write is vetoed, so nothing downstream of validation may run.
      expect(downstream).not.toHaveBeenCalled()
      expect(failures[0]?.map((i) => i.rule)).toEqual(['geometry.valid'])
    })

    it('lets a warning through, and still reports it', async () => {
      const registry = makeRegistry()
      registry.add({
        id: 'parcel.sliver',
        severity: 'warning',
        check: (f) => [issue('parcel.sliver', 'warning', f.id)],
      })
      const { commit, downstream, failures } = wire(registry)

      const ctx = await commit.run(commitContext([feature('a')]))

      expect(ctx.rejected).toBe(false)
      expect(downstream).toHaveBeenCalledTimes(1)
      // A UI wants to show the sliver even though the write succeeded.
      expect(failures[0]?.map((i) => i.severity)).toEqual(['warning'])
    })

    it('emits errors and warnings together when both are present', async () => {
      const registry = makeRegistry()
      registry.add({
        id: 'parcel.overlap',
        severity: 'error',
        check: (f) => [issue('parcel.overlap', 'error', f.id)],
      })
      registry.add({
        id: 'parcel.sliver',
        severity: 'warning',
        check: (f) => [issue('parcel.sliver', 'warning', f.id)],
      })
      const { commit, failures } = wire(registry)

      const ctx = await commit.run(commitContext([feature('a')]))

      expect(ctx.rejected).toBe(true)
      expect(failures[0]?.map((i) => i.rule).sort()).toEqual(['parcel.overlap', 'parcel.sliver'])
    })

    it('rejects when a rule throws, rather than letting the write through', async () => {
      const registry = makeRegistry()
      registry.add({
        id: 'explodes',
        severity: 'warning',
        check: () => {
          throw new Error('boom')
        },
      })
      const { commit, downstream } = wire(registry)

      const ctx = await commit.run(commitContext([feature('a')]))

      expect(ctx.rejected).toBe(true)
      expect(downstream).not.toHaveBeenCalled()
    })

    it('does not validate a removal — an invalid parcel must still be deletable', async () => {
      const registry = makeRegistry()
      const check = vi.fn((f: BlaeuFeature) => [issue('geometry.valid', 'error', f.id)])
      registry.add({ id: 'geometry.valid', severity: 'error', check })
      const { commit, downstream } = wire(registry)

      const ctx = await commit.run(commitContext([feature('a')], 'remove'))

      expect(ctx.rejected).toBe(false)
      expect(check).not.toHaveBeenCalled()
      expect(downstream).toHaveBeenCalledTimes(1)
    })

    it('is a no-op cost when no rules are registered', async () => {
      const registry = makeRegistry()
      const { commit, downstream, failures } = wire(registry)

      const ctx = await commit.run(commitContext([feature('a')]))

      expect(ctx.rejected).toBe(false)
      expect(downstream).toHaveBeenCalledTimes(1)
      expect(failures).toHaveLength(0)
    })

    it('localises the rejection message through i18n', async () => {
      const i18n = new BlaeuI18n('tr')
      const registry = new BlaeuValidationRegistry(store, crs, i18n)
      registry.add({
        id: 'geometry.valid',
        severity: 'error',
        check: (f) => [
          {
            rule: 'geometry.valid',
            severity: 'error',
            message: i18n.t('error.invalidGeometry'),
            feature: f.id,
          },
        ],
      })
      const { commit } = wire(registry)

      const ctx = await commit.run(commitContext([feature('a')]))

      expect(ctx.rejectReason).toContain('Geometri geçerli değil.')
      expect(ctx.rejectReason).toContain('1 doğrulama hatası')
    })
  })
})
