# Publishing `@blaeu/*` to npm

Nothing here is published yet. This is the checklist that closes that, written after the
packaging itself was verified rather than assumed — everything under
[What is already done](#what-is-already-done) was run, and its output is quoted.

The two things that remain need credentials, and only those: an npm account that owns the
`@blaeu` scope, and a token in the repository's secrets. No code change is required.

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

**The release workflow exists.** [`.github/workflows/release.yml`](../.github/workflows/release.yml)
runs `npm run verify` and then `changesets/action`, which either opens the "Version Packages"
PR or — when that PR has just merged — publishes. It already sets `NPM_CONFIG_PROVENANCE: true`
and requests `id-token: write`, so tarballs are published with a signed provenance attestation.

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

### 2. Add the token

Create a **granular access token** (not a classic one), scoped to the `@blaeu` packages,
with read-and-write permission, then:

```bash
gh secret set NPM_TOKEN --repo celikgo/blaeu-lib
```

The repository has **no secrets set today**, which is why the release job would fail at the
publish step if it ran now. Provenance additionally requires the workflow to publish from a
public repository on a GitHub-hosted runner — both already true.

### 3. Publish

With a changeset pending, push to `main`. The workflow opens the Version Packages PR; merging
it triggers the publish. To do the first one by hand instead:

```bash
npm run verify            # scaffold, boundaries, typecheck, lint, docs, tests, build
npx changeset version     # bumps all twelve in lockstep, writes CHANGELOGs
npx changeset publish     # publishes and creates the git tags
git push --follow-tags
```

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
