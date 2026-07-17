# ADR 0004 — Two pipelines: synchronous interaction, asynchronous commit

Status: accepted

## Context

BlaeuMap has two places where third-party code needs to intercept and modify what the kernel
is doing:

1. **Interaction** — a pointer event on its way to a tool. Snapping rewrites its position;
   a grid lock quantises it; an ortho constraint projects it onto an axis.
2. **Commit** — a mutation on its way into the store. Validation may veto it; a middleware
   may fill in attribute defaults, reduce coordinate precision, or stamp an audit record.

They look like the same problem — a chain of middleware around a mutable context — and the
first design had one pipeline serving both. That design does not survive contact with the
two workloads, because their requirements are opposite.

A `pointermove` on a 120 Hz display fires up to 120 times a second. The budget for the entire
chain is single-digit milliseconds. An `async` middleware in that chain means (a) at least
one microtask, so the tool sees the position at least one frame late, and (b) — much worse —
**reordering under load**: two pointer events in flight, the first awaiting something, the
second overtaking it, and the vertex lands where the cursor was two frames ago. Users do not
report this as a bug. They report that "the snapping feels laggy" and stop trusting the tool.

Meanwhile, a genuine cadastral topology check is a network call. The parcel registry is
authoritative and it is on a server. A synchronous commit path cannot ask it anything, and
the fallback — validate optimistically on the client, then apologise — means invalid geometry
existed in the store, and something always exports it.

## Decision

**Two pipelines, with the difference enforced by the type system.**

```ts
type InteractionMiddleware = (ctx: InteractionContext, next: () => void) => void
type CommitMiddleware = (ctx: CommitContext, next: () => Promise<void>) => Promise<void>
```

`InteractionMiddleware` returns `void`, not `Promise<void>`. A middleware author cannot make
it async by accident; `await` in there is a compile error, not a latency regression found in
production. This is core invariant 4, and the type is the enforcement.

Middleware that genuinely needs async work does it **speculatively, off the pipeline, and
caches**. The snap engine is the reference: it rebuilds its spatial index on `camera:idle`,
never on `pointermove`, so the hot path only ever reads a warm structure.

`CommitMiddleware` is async, because the caller already `await`s the write, so the cost
lands where it is visible. The pipeline short-circuits the instant anything calls
`ctx.reject()` — which is why priority ordering puts cheap local rules ahead of expensive
server ones — and a middleware that _throws_ rejects the write rather than letting it
through. Failing closed is the only defensible default when the thing being guarded is a
land registry.

Validation is a commit middleware at priority −100, so it runs **last**: the middleware that
fills in defaults, quantises coordinates and rewinds ring winding all sit above zero, and a
rule that judged the pre-quantised ring while the store keeps the quantised one is a bug you
find in production.

## Alternatives rejected

**One async pipeline for both.** Uniform, one concept to learn. Rejected on the 120 Hz
argument above: every pointer event would pay a microtask, and under load events would
reorder. There is no way to get sync behaviour out of an async contract, but there _is_ a way
to get async behaviour out of a sync one (do the work speculatively and cache it), so the
sync contract is the strictly more capable choice for the hot path.

**One sync pipeline for both.** Then a topology check cannot call a server, and validation
is restricted to what can be computed locally in a frame. For a cadastre product that is a
non-starter: the authoritative answer to "does this parcel overlap its neighbour" lives on
the registry's server.

**A single pipeline with a `sync: true` flag per middleware.** Rejected because it makes the
contract a runtime property rather than a type. One middleware author who forgets the flag
degrades the pointer path for everyone, and the failure is invisible in code review.

**Debouncing / throttling interaction middleware to make async safe.** Throwing away pointer
events to hide latency, which trades one perceptible problem (lag) for another (dropped
vertices). And it does not fix reordering, only its frequency.

**Web Workers for the interaction path.** The snap engine needs `project`/`unproject` (which
depend on the live camera) and the store's spatial index. Shipping both across a worker
boundary on every pointer move costs more than the work it offloads.

## Consequences

- **Good.** The pointer path is bounded and predictable. Snapping at 120 Hz with 50 000
  parcels loaded is an index query, not a scan and not an await.
- **Good.** The commit path can do genuinely expensive things — a server round trip, a WASM
  GEOS overlay — because the caller is already awaiting and the UI can show a spinner.
- **Good.** The two contexts differ, and correctly so: `InteractionContext` has a mutable
  `lngLat`; `CommitContext` has a mutable `features` array and a `reject(reason)`. Neither
  pretends to be the other.
- **Bad.** Two mechanisms to learn, and a plugin author must know which one their concern
  belongs to. "Modify the pointer" and "veto the write" are different verbs, which helps.
- **Bad.** Two mechanisms to learn, and a plugin author must know which one their concern
  belongs to. "Modify the pointer" and "veto the write" are different verbs, which helps.
- **Resolved, and it was worse than this ADR admitted.** This section used to describe
  `dispatch()` not running the commit pipeline as "the sharpest edge in the library" and
  propose an eventual `dispatchAsync()`. The reality was harsher: **the kernel never ran the
  commit pipeline at all.** It was constructed, middleware was registered into it, the
  validation registry installed itself into it, and nothing called `run()`. The library had
  no validation. `preset-game`'s `EntitySession.place()` was not "the reference pattern" — it
  was one plugin author working around a kernel hole in their own corner, and the workaround
  is why the hole survived review.

  The resolution landed as `commands.commit()`. See [ADR 0009](./0009-commit-commands.md).
