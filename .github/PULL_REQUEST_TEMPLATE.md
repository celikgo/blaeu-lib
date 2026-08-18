## What this changes, and why

<!-- The reason is the part that matters — the bug it prevents, the constraint that forced it. -->

## Gates

- [ ] `npm run verify` **and** `npm run format:check` pass locally. CI runs them as two steps, and `verify` does not include the formatter — `prettier` covers `.md`, `.yml` and `.json`, which `eslint` never sees, so `verify` alone can be green while CI is red.
- [ ] A changeset is included (`npm run changeset`), or this touches nothing publishable.
- [ ] An ADR is included, or none of the [ADR triggers](https://github.com/celikgo/blaeu-lib/blob/main/CONTRIBUTING.md#when-a-change-needs-an-adr) apply — contracts, extension points, `composePresets` merge semantics, a load-bearing dependency swap, or a new package entry point.
- [ ] `npm run lint:boundaries` passes if this crosses a package boundary — plugins peer-depend on `@blaeu/core` and never import each other.
