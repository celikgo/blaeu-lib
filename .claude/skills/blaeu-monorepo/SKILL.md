---
name: blaeu-monorepo
description: How the BlaeuMap monorepo is wired — npm workspaces, tsup builds, package boundaries, the dependency rules CI enforces, and how to add a new package. Use when adding a package, fixing a build/type-resolution error, or when an import "works in dev but fails on build".
---

# The monorepo

npm workspaces (no pnpm/turbo — Node 25's npm handles this natively, and one less
tool is one less thing to explain to a contributor).

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
"peerDependencies": { "@blaeu/core": "^0.1.0" },
"devDependencies":  { "@blaeu/core": "^0.1.0" }   // for building/testing
```

npm workspaces link a package into `node_modules` by its name whenever the
installed version satisfies the range, so a plain `^0.1.0` resolves to the local
copy in dev and to the published one for a consumer. (The `workspace:` protocol is
a pnpm/yarn thing — npm does not understand it, and a manifest that uses it is
uninstallable.)

If you see "my listener never fires" in an issue, check for a duplicate core
before anything else. It's this, more often than not.

## Builds

Each package builds with `tsup` to ESM + CJS + `.d.ts`. The root orchestrates:

```bash
npm run build          # topological: core first, then plugins, then presets
npm run typecheck      # project references — fast, incremental
npm run test           # vitest workspace, all packages
npm run dev            # tsup --watch across packages + example dev server
```

**During development, packages resolve to source, not to `dist`.** That's what the
`development` condition in each package's `exports` does, and it's why you can
edit `core/src` and see it in an example without rebuilding. It also means a type
error in core surfaces in the example immediately — which you want.

If you get _"Cannot find module '@blaeu/core' or its corresponding type
declarations"_, the cause is almost always one of three things, in this order:

1. You never ran `npm install` at the **root** (workspaces link on install).
2. The new package isn't in the root `workspaces` array.
3. `tsconfig.base.json` `paths` doesn't map the new package to its `src`.

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
4. Register the package in the root `workspaces`, in `tsconfig.base.json` `paths`,
   and in the `resolve.alias` blocks of `vitest.config.ts` and each `examples/*`.

Keep the `refs` in the array honest — a preset that depends on `plugin-topology` and
does not list it will typecheck in dev (the `paths` resolve to source) but fail
`tsc --build`, and the scaffold will silently drop the reference on the next run.
The script does both, but check the diff.

## `exports` is the API boundary

```jsonc
"exports": {
  ".":         { "types": "./dist/index.d.ts", "import": "./dist/index.js",  "require": "./dist/index.cjs" },
  "./testing": { "types": "./dist/testing.d.ts", "import": "./dist/testing.js" },
  "./package.json": "./package.json"
}
```

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
