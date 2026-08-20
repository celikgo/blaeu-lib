# Publishing `@blaeu/*` to npm

Nothing here is published yet. This is the checklist that closes that, written after the
packaging itself was verified rather than assumed — everything under
[What is already done](#what-is-already-done) was run, and its output is quoted.

What remains needs credentials, and only credentials: an npm account that owns the `@blaeu`
scope. There is no code change left — `release.yml` is already wired for
[trusted publishing](#2-publish-once-by-hand-then-hand-the-keys-to-oidc), so the repository
holds **no publish token at all** and none needs to be created for the steady state.

## What is already done

**All twelve packages pack cleanly.** `npm run build && npm pack --workspaces` produces
twelve tarballs, each carrying `dist/` (ESM + `.d.ts` + sourcemaps), `README.md`, `LICENSE`
and `package.json`:

| Package                  | Tarball | Entries |
| ------------------------ | ------- | ------- |
| `@blaeu/core`            | 304 KB  | 12      |
| `@blaeu/plugin-edit`     | 74 KB   | 6       |
| `@blaeu/preset-game`     | 58 KB   | 6       |
| `@blaeu/plugin-ui`       | 47 KB   | 6       |
| `@blaeu/preset-cadastre` | 44 KB   | 6       |
| `@blaeu/plugin-snap`     | 42 KB   | 6       |
| `@blaeu/plugin-topology` | 42 KB   | 6       |
| `@blaeu/plugin-measure`  | 37 KB   | 6       |
| `@blaeu/preset-urban`    | 37 KB   | 6       |
| `@blaeu/plugin-draw`     | 34 KB   | 6       |
| `@blaeu/plugin-select`   | 22 KB   | 6       |
| `@blaeu/plugin-history`  | 16 KB   | 6       |

`@blaeu/core` is larger and carries twelve entries because it ships a second entry point,
`@blaeu/core/testing` (the fake renderer and the headless harness), plus a shared chunk.

The four apps under `examples/` are `private: true` and are additionally listed in
`.changeset/config.json`'s `ignore` array, so they are neither versioned nor published.
`npm pack --workspaces` still writes tarballs for them; `changeset publish` does not.

**Manifests are complete and generated.** `main` / `module` / `types` / `exports` / `files` /
`repository.directory` / `publishConfig.access` are set on every package, and
`npm run scaffold:check` fails CI if one drifts (ADR 0017). Every plugin declares
`@blaeu/core` as a `peerDependency`, never a dependency — two kernels in one `node_modules`
means two event buses, and the failure is silent.

**The release workflow exists, and authenticates without a secret.**
[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs `npm run verify` and
then `changesets/action@v2`, which either opens the "Version Packages" PR or — when that PR
has just merged — publishes. It sets `NPM_CONFIG_PROVENANCE: true`, requests
`id-token: write`, and deliberately sets **no** `NODE_AUTH_TOKEN`: npm exchanges the OIDC
token GitHub mints for this repository and this workflow file for a short-lived credential
scoped to exactly that. Tarballs carry a signed provenance attestation either way.

Two details in there are load-bearing and easy to undo by accident. The job upgrades npm to
11 before publishing, because trusted publishing landed in npm 11.5.1 and Node 22 still
bundles 10.9 — the default npm fails with a plain authentication error that never mentions
OIDC. And `NODE_AUTH_TOKEN` must be _absent_, not empty: writing
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` with no such secret expands to an empty string,
which npm finds, believes, and fails on with a 401 instead of falling back to OIDC.

**Versions are aligned.** All twelve are at the same version, enforced by
`fixed: [["@blaeu/*"]]`. There is never a partial release where a preset depends on a plugin
version that does not exist.

## What remains

### 1. Reserve the scope

```bash
npm login                 # interactive; needs your OTP
npm org create blaeu      # or publish under a user scope you already own
```

If `@blaeu` is taken by the time you get there, the name has to change in twelve manifests,
every README, and the declaration-merging examples. `npm run scaffold` regenerates the
manifests; the prose is manual. Check availability before anything else:

```bash
npm view @blaeu/core          # E404 today — that is what we want to stop being true
```

### 2. Publish once by hand, then hand the keys to OIDC

**A trusted publisher is configured on a package that already exists.** That is the one
awkward fact in this plan and there is no way around it: npm has nothing to attach a trust
policy to until the name is on the registry, so the _first_ version of each of the twelve
cannot be published by `release.yml` as it stands. Every version after the first can.

So the first release is a local one:

```bash
npm login                 # interactive; needs your OTP
npm run verify            # scaffold, boundaries, typecheck, lint, docs, tests, build
npx changeset version     # bumps all twelve in lockstep, writes CHANGELOGs
npx changeset publish     # publishes and creates the git tags
git push --follow-tags
```

Those tarballs will have **no provenance attestation** — provenance is a statement about a
CI run, and this one is a laptop. That is the price of the bootstrap and it applies to 0.1.2
only.

Then, once for each of the twelve packages, on npmjs.com → the package → _Settings_ →
_Trusted Publisher_:

| Field         | Value           |
| ------------- | --------------- |
| Publisher     | GitHub Actions  |
| Organization  | `celikgo`       |
| Repository    | `blaeu-lib`     |
| Workflow file | `release.yml`   |
| Environment   | _(leave empty)_ |

Trusted publisher configurations created after 20 May 2026 require you to explicitly tick at
least one allowed action; `npm publish` is the one this workflow needs.

Twelve is tedious and it is also the last of it. From 0.1.3 onward the only thing that
publishes is a merge of the Version Packages PR, with no credential anywhere in the
repository to leak, expire, or forget to rotate.

### 3. Do not add an NPM_TOKEN secret

Worth stating as its own step, because it is the natural thing to reach for when a publish
fails and it will actively break this setup. `release.yml` authenticates by _not_ having a
token; a secret named `NPM_TOKEN` would only take effect if someone also re-added
`NODE_AUTH_TOKEN` to the publish step, and at that point the OIDC path is dead and the
provenance attestation is attesting to a token-authenticated publish.

If a publish fails, the cause is almost always one of three things, in order of likelihood:
the trusted publisher is not configured for _that_ package (all twelve need it), the workflow
filename in the trusted publisher config does not match `release.yml`, or npm on the runner is
older than 11.5.1.

### 4. Undo the honesty

Once `npm view @blaeu/core version` resolves, the caveats have to come out — otherwise the
docs are wrong in the other direction:

- `README.md`: the run-from-source fence near the top becomes `npm install @blaeu/core maplibre-gl`
  again, the `> **Not on npm yet.**` blockquote goes, the **Not yet on npm** paragraph under
  `## Packages` goes, and the table column reverts from `Install (once published)` to `Install`.
- All twelve `packages/*/README.md`: delete the
  `> Not on npm yet — see [the root README]…` line. These ship inside the tarballs, so they
  are what npm renders on each package page.
- Set the repository `homepage` to `https://www.npmjs.com/package/@blaeu/core`.

```bash
grep -rn 'Not on npm yet\|once published' README.md packages/*/README.md   # should print nothing
```

## The version trap

`.changeset/config.json` documents this at length and it is worth repeating, because it is
the kind of thing discovered at the worst moment:

**With a `fixed` group, a `minor` changeset on `0.x` packages does not give `0.2.0` — it gives
`1.0.0`.** Changesets cannot keep a group aligned across a `0.x` minor, so it escalates. This
was measured, not inferred.

So while the API is still moving, keep every changeset `patch`. Take `1.0.0` deliberately —
when hit testing is verified on a GPU runner and the mutation score is respectable — rather
than by accident on the way past.

The packages currently sit at **0.1.1**, and one `patch` changeset is pending
(`.changeset/olive-donkeys-shake.md`, the `data-fx-*` → `data-bl-*` rename in
`@blaeu/plugin-ui`), so the first publish will be **0.1.2**.
