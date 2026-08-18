---
name: blaeu-monorepo
description: How the Blaeu monorepo is wired — npm workspaces, ESM-only tsup builds, package boundaries, the dependency rules CI enforces, the changesets release traps, and how to add a new package. Use when adding a package, fixing a build/type-resolution error, cutting a release, or when an import "works in dev but fails on build".
---

# The monorepo

npm workspaces (no pnpm/turbo — npm has handled workspaces natively since npm 7,
and one less tool is one less thing to explain to a contributor). The declared
floor is `engines.node >= 20`; CI runs 22, and the `pack-and-consume` job
deliberately runs 20, because Node 22.12's `require(esm)` papers over exactly the
class of dependency-format bug that job exists to catch.

```
packages/
  core/                 @blaeu/core        ← depends on NOTHING in this repo
  plugin-*/             @blaeu/plugin-*    ← peer-depends on core only
  preset-*/             @blaeu/preset-*    ← depends on core + plugins
examples/               ← depends on presets; never published
```

The arrows only ever point left. CI enforces it:

```bash
npm run lint:boundaries
```

which fails on a core→plugin import, a plugin→plugin import, or a plugin that
lists `@blaeu/core` as a `dependency` instead of a `peerDependency`.

## Why core must be a peerDependency of every plugin

Two copies of `@blaeu/core` in a user's `node_modules` means **two event
buses, two command buses, two stores**. Nothing throws. The plugin just silently
never receives an event, and the user spends a day on it.

```jsonc
// packages/plugin-draw/package.json
"peerDependencies": { "@blaeu/core": "^<current core version>" },
"devDependencies":  { "@blaeu/core": "^<current core version>" }   // for building/testing
```

Never hand-write that range. `scripts/scaffold-packages.mjs` derives it from the
`version` in `packages/core/package.json`, which is what keeps `changeset version`
and `npm run scaffold:check` in agreement — a hardcoded literal drifts on the first
Version Packages PR and fails the check.

npm workspaces link a package into `node_modules` by its name whenever the
installed version satisfies the range, so a plain caret range resolves to the
local copy in dev and to the published one for a consumer. (The `workspace:`
protocol is a pnpm/yarn thing — npm does not understand it, and a manifest that
uses it is uninstallable.)

If you see "my listener never fires" in an issue, check for a duplicate core
before anything else. It's this, more often than not.

## Builds

Each package builds with `tsup` to **ESM + `.d.ts`. There is no CJS build** —
rbush@4 and jsts@2.12 are ESM-only, so a `require()` of a CJS entry throws
`ERR_REQUIRE_ESM` on the declared engine floor (`node >= 20`). That is also why
no manifest declares `main`, and why CI audits the tarballs with attw under
`--profile esm-only`. Adding a CJS format back is a decision, not a fix — see the
note at `scripts/scaffold-packages.mjs`. The root orchestrates:

```bash
npm run build          # topological: core first, then plugins, then presets
npm run typecheck      # project references — fast, incremental
npm run test           # vitest workspace, all packages
npm run dev            # tsup --watch across packages + example dev server
```

**In the repo, `@blaeu/*` resolves to source, not to `dist`** — which is why you
can edit `core/src` and see it in an example without rebuilding, and why a type
error in core surfaces in the example immediately. That is done by the `paths` in
`tsconfig.base.json` and by the `resolve.alias` blocks in `vitest.config.ts`,
`vitest.browser.config.ts` and each `examples/*/vite.config.ts` — **not** by an
export condition. There is deliberately no `development` condition in `exports`:
published, it would resolve a consumer to `./src`, which `files` never ships.

If you get _"Cannot find module '@blaeu/core' or its corresponding type
declarations"_, the cause is almost always one of three things, in this order:

1. You never ran `npm install` at the **root** (workspaces link on install).
2. `tsconfig.base.json` `paths` doesn't map the new package to its `src`.
3. The alias blocks above don't list it, so the tests or the example resolve it
   to a `dist` that was never built.

## Adding a package

The per-package `package.json` / `tsconfig.json` / `tsup.config.ts` are **generated**
from one place — `scripts/scaffold-packages.mjs` — so the `exports` map, the peer-dep
rule, the tsup config and the tsc output dir stay identical across the monorepo. To
add a package:

1. Add an entry to the `packages` array in `scripts/scaffold-packages.mjs` — its
   `name`, `desc`, `deps`, `peers`, and `refs` (the packages it project-references).
2. `npm run scaffold` — regenerates every package's config files from that array.
   It rewrites the three config files and nothing else; your `src/` is never touched.
3. Write `src/index.ts` (and the three tests from `blaeu-testing`: degradation,
   teardown, undo round-trip).
4. Add the package to `tsconfig.base.json` `paths`, and to the `resolve.alias`
   blocks of `vitest.config.ts`, `vitest.browser.config.ts`, and each
   `examples/*/vite.config.ts` that uses it. (The root `workspaces` array is a
   `packages/*` glob — there is nothing to add there. `vitest.browser.config.ts`
   is the one people forget, and the symptom is a browser suite that cannot
   resolve a package the node suite resolves fine.)

Keep the `refs` in the array honest — a preset that depends on `plugin-topology` and
does not list it will typecheck in dev (the `paths` resolve to source) but fail
`tsc --build`, and the scaffold will silently drop the reference on the next run.
The script does both, but check the diff.

## `exports` is the API boundary

```jsonc
"exports": {
  ".":              { "types": "./dist/index.d.ts",   "default": "./dist/index.js" },
  "./package.json": "./package.json",
  // core only
  "./testing":      { "types": "./dist/testing.d.ts", "default": "./dist/testing.js" }
}
```

One condition only, never an `import`/`require` split: a second condition is a
second way for a consumer to resolve a second copy of the kernel, which is the
duplicate-core failure above wearing a different hat. `./testing` exists on
`@blaeu/core` alone.

No wildcard subpath. If something isn't in `exports`, users cannot deep-import it,
which means we can refactor internals in a patch release without breaking anyone.
This is the mechanism behind core invariant 6 — it's not a convention we ask
people to respect, it's a resolution error if they don't.

Adding a new entry point is a deliberate act with a versioning consequence.
Adding a file is not. Keep it that way.

## Release

Changesets. `npx changeset` on every user-visible change, and the bot handles the
version bumps and the changelog. Core is versioned strictly: a change to a public
interface in `packages/core/src/types/` is a **major**, no matter how small it
looks, because every plugin in every downstream product implements against it.

Four things about this repository's changesets setup are measured traps rather
than preferences, and each one has already cost a commit:

- **All twelve packages are a `fixed` group.** `.changeset/config.json` declares
  `fixed: [["@blaeu/*"]]`, so they move in lockstep and a consumer never has to
  reason about which plugin version pairs with which core.
- **Keep releases `patch` while the API is still moving.** On a 0.x `fixed` group,
  a `minor` changeset does not yield 0.2.0 — it yields **1.0.0**. The first
  `minor` here is a 1.0 declaration whether or not anyone meant it.
- **`private: true` does not stop versioning.** It stopped nothing: one Version
  Packages PR bumped all four example apps and gave each a CHANGELOG. The example
  apps stay in the `ignore` list for that reason, and a new one must be added to
  it.
- **The core peer range is derived, never written.** `scripts/scaffold-packages.mjs`
  reads the version from `packages/core/package.json`, so `npm run scaffold:check`
  fails on the first Version Packages PR if anyone hardcodes it again.

`npm run release` is `verify && changeset publish` — the full gate runs before
anything reaches the registry — and the Release workflow publishes with
`NPM_CONFIG_PROVENANCE` so every tarball carries an attestation back to the commit
that built it.
