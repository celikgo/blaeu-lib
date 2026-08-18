# ADR 0016 — One lockstep version for the whole kernel

Status: accepted · Amends: — · Amended by: —

## Context

Twelve packages ship from this repository: the core, eight plugins and three presets. They are
not independent. Every plugin declares `@blaeu/core` as a **peer** dependency with a caret range
(ADR 0001's boundary rule: two copies of the core means two event buses, and the symptom is a
listener that silently never fires), and every preset depends on the plugins it composes the
same way.

Version them independently and the matrix opens immediately. `@blaeu/core@0.4.0` with
`@blaeu/plugin-edit@0.2.1` is a pair a caret range permits, that npm will happily install, and
that nobody has ever run — because the only combination anyone here tests is the one in this
repository, at one commit. The failure would land at a consumer, in a plugin nobody changed,
after a core release that looked innocuous.

The second half of the context is a measurement, and it is a trap rather than a preference. It
is written down because the first `minor` release is the only chance to get it right.

## Decision

**All twelve `@blaeu/*` packages move in lockstep, on one version, and releases stay `patch`
until 1.0 is taken deliberately.**

```jsonc
// .changeset/config.json
"fixed": [["@blaeu/*"]],
"ignore": ["@blaeu/example-01-basic", "…-02-cadastre", "…-03-urban-planning", "…-04-game-map"]
```

`npm run release` is `verify && changeset publish`; `.github/workflows/release.yml` opens the
"Version Packages" PR and publishes on merge.

One version for the whole kernel is the only claim we can actually stand behind: the tested
combination is the released combination, and a consumer who installs `@blaeu/core@0.1.7` and
`@blaeu/preset-cadastre@0.1.7` has the pair that ran in CI.

**Releases stay `patch` while the API is moving**, because of a measured escalation. With a
`fixed` (or `linked`) group, a `minor` changeset on 0.x packages does **not** give `0.2.0` — it
gives **1.0.0**. Changesets cannot keep a group aligned across a 0.x minor, so it escalates the
whole group. Drop the grouping and the same changeset gives `0.2.0`. So the first `minor` here
is a 1.0 declaration whether or not anyone meant it, and 1.0 is to be taken when hit testing is
verified on a GPU runner ([ADR 0015](./0015-browser-tests-are-a-fence-gated-on-a-gpu-probe.md))
and the mutation score is respectable — not by accident on the way past.

The consequence for a breaking change pre-1.0 is that the version number cannot carry the
signal, so the changeset description has to. [ADR 0001](./0001-plugin-first-kernel.md) states
that rule where a plugin author will meet it.

**The four example apps are in `ignore`, and that entry was earned.** `private: true` stops a
package being _published_; it does not stop it being _versioned_. The `fixed` glob `@blaeu/*`
matches `@blaeu/example-01-basic` and friends, so the first Version Packages PR bumped all four
and wrote each a CHANGELOG — noise in every release PR for packages that can never reach npm.
Both directions were checked rather than assumed: listing them stops the bumps, and their
`@blaeu/*` dependency ranges are still rewritten to the new version, so npm workspaces keep
resolving them locally.

## Alternatives rejected

**Independent versioning, one changeset per package.** The default, the honest reading of
semver, and what a consumer expects: a plugin that did not change does not get a new version.
Rejected on the matrix above. Independent versions are correct when packages are genuinely
independent, and these are not — a plugin is written against one core's types and tested against
one core's behaviour.

**`linked` instead of `fixed`.** `linked` aligns versions only for packages that actually
changed, which sounds like a middle ground: no version churn on untouched plugins, still no
mismatched pairs among the ones released together. Rejected because it does not solve the
problem — an untouched plugin keeps its old version and is therefore still installable alongside
a newer core — and because it was measured to have the identical 0.x escalation, so it does not
even avoid the trap.

**No grouping at all, and accept the 0.x behaviour.** It is the only option that gives `0.2.0`
for a `minor`, which is what everyone expects. Rejected because it reintroduces the version
matrix in full, which is the thing this decision exists to prevent. The escalation is a cost
worth paying for a single version; it just has to be known about in advance, which is what this
ADR is for.

**Rely on `private: true` to keep the examples out of the release.** Rejected by evidence: it
does not, and PR #2 proved it. The note that used to sit in the config claimed otherwise.

## Consequences

- **A version number means a tested combination**, and nothing else in the release process has
  to be trusted for that to hold.
- **Untouched packages get new versions.** A core-only fix bumps all twelve, and eleven
  changelogs say only that a dependency moved. That is noise, and it is the price of the
  guarantee.
- **The first `minor` is a 1.0 release.** Anyone writing a changeset should read that sentence
  twice. `patch` until the preconditions are met.
- **Adding a thirteenth package needs no config change**, because the group is a glob — but a new
  `@blaeu/*` package that must not be published needs adding to `ignore`, or it will be versioned
  like the examples were.
- **The examples still resolve locally** after a release, because ignoring a package excludes it
  from bumping, not from having its dependency ranges rewritten.
