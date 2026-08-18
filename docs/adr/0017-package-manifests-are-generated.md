# ADR 0017 — Package manifests are generated, and CI regenerates them to check

Status: accepted · Amends: — · Amended by: —

Extends [ADR 0001](./0001-plugin-first-kernel.md), which decided that the package boundary is
mechanically enforced but named only one of the two gates that enforce it.

## Context

Twelve packages ship from this repository, and each carries three files that are nearly the same
file: `package.json`, `tsconfig.json` and `tsup.config.ts`. The differences between them are
small and load-bearing — which runtime dependencies a package actually imports, which project
references its typecheck needs, whether `exports` has a second entry point — and everything else
is repetition that has to stay identical across twelve copies or the build stops meaning
anything.

One rule in particular cannot be allowed to drift, because [ADR 0001](./0001-plugin-first-kernel.md)
rests on it: `@blaeu/core` is a **peerDependency** of every plugin, never a dependency. Two
copies of the core means two event buses, and the symptom is a listener that silently never
fires. That is a one-word difference in a manifest, in twelve places, that nothing at build time
has any reason to notice.

We wrote the generator first and left the check for later, and the gap between the two is the
incident this ADR exists to record. The generator drifted from the tree in both directions at
once. It had silently lost `plugin-select`'s two `@turf/*` runtime dependencies — both genuinely
imported, at the top of `SelectionController.ts` — and it had grown an `rbush` that `plugin-snap`
never imported, a dependency a consumer downloads and never runs. Neither showed up in
`typecheck`, `test` or `build`, because **npm hoists workspace dependencies to the root
regardless**: the import resolves in this repository whether or not the package that needs it
declares it. In the generator's own words, "only a published tarball would have broken, at the
consumer, with `ERR_MODULE_NOT_FOUND`".

There was one visible signal, and the obvious response to it destroyed it. `format:check` failed
on the regenerated files, because the generator wrote raw `JSON.stringify` output while the
committed manifests were prettier-formatted. Running `npm run format` tidied the complaint away
and left the dependency deletions exactly where they were.

## Decision

**One generator owns every generated manifest, and `npm run scaffold:check` fails the build on
any difference between what it would write and what is committed.**

```bash
npm run scaffold         # writes packages/*/{package.json,tsconfig.json,tsup.config.ts}
npm run scaffold:check   # regenerates in memory, diffs against the tree, exits 1 on a difference
```

- **`scaffold:check` is the first step of `npm run verify`**, ahead of `npm run lint:boundaries`.
  The order is the point: the boundary check reads the manifests, so it is only as trustworthy as
  the claim that the manifests say what the repository means them to say. Checking the boundary
  first would be checking a file nobody had verified.
- **`--check` creates nothing.** It reports drift; it does not quietly fix it, and it does not
  make directories. A gate that repairs the thing it is measuring has no failure state.
- **The generator formats its own output with the repo's prettier config**, so generated and
  committed are byte-identical and a real difference is the only thing `--check` can report. It
  formats by `filepath` rather than by an explicit parser, because prettier picks the
  `json-stringify` parser for a file literally named `package.json` and `json` for every other
  `.json` file. Forcing `json` made all twelve manifests disagree with `npm run format`, and a
  check that always fails is a check everyone learns to skip.
- **The version and the derived core peer range are read, not written.** `VERSION` comes from
  `packages/core/package.json` and `CORE_PEER` is derived from it. A literal here would be a
  thirteenth copy of the version number, and the one thing guaranteed to touch the other twelve
  is `changeset version` ([ADR 0016](./0016-one-lockstep-version-for-the-whole-kernel.md)).
- **A per-package divergence lives in the generator, with its reason.** `plugin-snap` has no
  `deps` entry and a comment saying why; `plugin-select`'s `@turf/*` entries carry the note that
  they are real and were once deleted. The manifest is the output; the argument is in the source.

## Alternatives rejected

**Hand-written manifests, kept in line by review.** That is what we had. It is the option with no
tooling, no generator to learn and no indirection between the file you read and the file npm
reads. Rejected because it failed in the specific way that matters: a wrong manifest is invisible
to every gate in `verify` — npm's hoisting sees to that — so review is not the last line of
defence, it is the only one, twelve times over, on files that look identical to each other.

**A lint rule over the manifests instead of a generator.** Assert the invariants — core is always
a peer, `type` is always `module`, `files` always lists `LICENSE` — and leave the files
hand-written. Genuinely attractive, because it keeps each manifest a real file you can edit.
Rejected because the rules would have to be written down for every field worth protecting, and
the fields nobody thought to protect are exactly where the drift lands. The `@turf/*` deletion
would have passed a lint rule that checked peers and entry points; the only assertion that would
have caught it is "the dependencies are the ones the generator says", which is this decision.

**syncpack.** The off-the-shelf answer, and it solves the part of the problem that is about
version ranges agreeing across a workspace. Rejected because that is the smaller half. It
reconciles fields that already exist; it does not own the manifest, so it cannot notice a
dependency that should exist and does not, and it has nothing to say about `tsconfig.json`
references or `tsup.config.ts`. Adding a tool that covers a third of the surface leaves the other
two thirds looking covered.

## Consequences

- **Hand-editing a generated manifest fails CI.** That is the intended experience, and the
  failure says so: it names the files that differ and tells you to run `npm run scaffold` and
  commit the result — or, if the committed file is the right one, to fix the template. Changing
  the template is the supported way to change a manifest.
- **`changeset version` cannot desync the check.** Because `VERSION` and `CORE_PEER` are read
  from the core manifest, a release that bumps all twelve packages leaves the generator in
  agreement with the tree. This was not free: `CORE_PEER` was a hardcoded `^0.1.0` that survived
  the change making `VERSION` read from the manifest, and `scaffold:check` duly failed on the
  very first Version Packages PR. Commit 077314c is that fix.
- **Prettier's config is now load-bearing for a gate.** Changing `.prettierrc.json` changes what
  the generator emits, so the manifests must be regenerated with it. That coupling is deliberate:
  the alternative is the formatting difference coming back as permanent noise in `--check`.
- **Adding a package is one entry in the generator's `packages` array** — name, description,
  keywords, dependencies, peers and project references — and everything else is inherited.
  Forgetting the entry is not a silent omission; the package simply has no manifest.
- **A generated file is not the place to record anything.** Any comment written into
  `packages/*/package.json` is deleted on the next regeneration, and any reasoning worth keeping
  belongs in `scripts/scaffold-packages.mjs` beside the value it explains.
