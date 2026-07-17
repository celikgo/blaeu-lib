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
"peerDependencies": { "@blaeu/core": "workspace:^" },
"devDependencies":  { "@blaeu/core": "workspace:*" }   // for building/testing
```

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

```bash
node scripts/new-package.mjs plugin-elevation
```

It scaffolds `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`, a
README skeleton, and — importantly — the three tests from `blaeu-testing`,
already wired and failing. A new package that starts with three failing tests
gets them passing; one that starts with zero tests ships with zero tests.

Then register it in the root `workspaces` and in `tsconfig.base.json` `paths`.
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
