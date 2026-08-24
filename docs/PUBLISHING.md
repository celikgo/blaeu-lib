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

### 1. Create the `blaeu` organisation — in a browser, because there is no other way

`@blaeu` is an **organisation scope**, not a user scope. `celikgo` is the username, so
nothing here can be published until an org called `blaeu` exists, and creating one is a
web-only action: <https://www.npmjs.com/org/create>. Free for public packages.

There is no CLI or token path for this, and it is worth stating because the obvious guess
fails silently in the wrong direction — an earlier version of this document said
`npm org create blaeu`, which is not a command. `npm org` only does `set`, `rm` and `ls`,
all of which operate on an org that already exists:

```console
$ npm org --help
npm org set orgname username [developer | admin | owner]
npm org rm orgname username
npm org ls orgname [<username>]
```

So no amount of authentication substitutes for this step. A token that authenticates
perfectly well as `celikgo` still cannot publish `@blaeu/core`, because the scope it names
does not exist:

```console
$ curl -s https://registry.npmjs.org/-/org/blaeu/package
{"error":"Scope not found"}
```

Check availability before anything else — if `@blaeu` is taken by the time you get there, the
name has to change in twelve manifests, every README, and the declaration-merging examples.
`npm run scaffold` regenerates the manifests; the prose is manual.

```bash
npm view @blaeu/core          # E404 today — that is what we want to stop being true
```

Once the org exists, `npm login` (interactive, needs your OTP) is the authentication the next
step uses.

### 2. Publish once by hand, then hand the keys to OIDC

**A trusted publisher is configured on a package that already exists.** That is the one
awkward fact in this plan and there is no way around it: npm has nothing to attach a trust
policy to until the name is on the registry, so the _first_ version of each of the twelve
cannot be published by `release.yml` as it stands. Every version after the first can.

The order below matters, and it is not the obvious one. It also is not the order this
repository took: the Version Packages PR (#7) was merged first, on 2026-08-20, so `main`
moved to **0.1.2**, CI ran `changeset publish`, and the run failed exactly as predicted —
[run 32352688689](https://github.com/celikgo/blaeu-lib/actions/runs/32352688689):

```console
Some packages failed to publish:
@blaeu/core@0.1.2
└ E404: Not Found - PUT https://registry.npmjs.org/@blaeu%2fcore
```

That is not a defect in `release.yml`. Reaching a `PUT` proves `npm ci`, `npm run verify`
and the action's dispatch all worked; the 404 is the registry saying the `@blaeu` scope does
not exist, which is step 1 above. The workflow is correct and cannot bootstrap itself, and
it says so in its own comments.

So the state today is: twelve manifests at 0.1.2, nothing on the registry, and
`.changeset/` empty — the pending changeset was consumed by that PR. Publish 0.1.2 by hand:

```bash
npm login                 # interactive; needs your OTP
git checkout main && git pull
npm run release           # = npm run verify && changeset publish
```

`npm run release` is exactly the recipe and already exists in `package.json`. No
`changeset version` in there and no changeset to consume: `changeset publish` publishes
whatever is in the manifests and not yet on the registry, which today is all twelve at
0.1.2.

Those twelve 0.1.2 tarballs will carry **no provenance attestation** — provenance is a
statement about a CI run, and this one is a laptop. That is the whole price of the
bootstrap, it is paid once, and 0.1.3 onwards gets provenance because CI publishes them.

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

Twelve is tedious and it is also the last of it.

### Then prove it, which now takes a deliberate step

The original plan ended here, because there was an unmerged Version Packages PR waiting to
supply the next version and prove the trust policies. There is not any more, and that
changes what a green Release run means:

> **A green Release run is not evidence that trusted publishing works.** With no changesets
> and every manifest version already on the registry, `changesets/action@v2` takes its
> "no changesets found, attempt to publish" branch, `changeset publish` finds nothing
> unpublished, and the job exits 0 having published nothing at all.

Only a version npm does not yet have exercises the OIDC exchange. So after the hand-publish
and the twelve trust policies, write a changeset and merge the release PR it produces:

```bash
npm run changeset         # patch, on all twelve — see the version trap below
git add .changeset && git commit -m 'release: prove trusted publishing on 0.1.3'
git push
```

That opens a Version Packages PR for **0.1.3**; merging it is the first release this
repository publishes on its own, and the first with a provenance attestation naming the
commit and the workflow that built it. Every release after it is the same single act — merge
the PR — with no credential anywhere in the repository to leak, expire, or forget to rotate.

A useful property of doing it in this order: nothing about the release pipeline is taken on
faith. If the trusted publishers are wrong, the 0.1.3 run says so, and the packages are
already on npm at 0.1.2 regardless.

### What has been rehearsed, and what has not

The publish path was run end to end against a local registry (verdaccio 6.10.0) on
2026-08-24, from this working tree. `changeset publish` reported
`Successfully published:` for all twelve at 0.1.2 and created the twelve
`@blaeu/<pkg>@0.1.2` tags (deleted afterwards — the rehearsal left nothing behind).

Then, in an empty directory with nothing but a `package.json`:

```console
$ npm view @blaeu/core version dist.tarball
version = '0.1.2'
dist.tarball = 'http://localhost:4873/@blaeu/core/-/core-0.1.2.tgz'

$ npm install @blaeu/core @blaeu/preset-cadastre maplibre-gl@^5
added 48 packages in 3s

$ npm ls --depth=1
├─┬ @blaeu/preset-cadastre@0.1.2
│ ├── @blaeu/core@0.1.2 deduped
│ ├── @blaeu/plugin-draw@0.1.2
│ …eight plugins, all 0.1.2
```

All thirteen entry points then imported, `@blaeu/core/testing` included. That is more than
CI's `pack-and-consume` job proves: that job installs twelve tarballs by path at once, so
the version ranges are satisfied locally and never resolved. Here `@blaeu/preset-cadastre`
pulled its eight `^0.1.2` plugin ranges from the registry and deduped `@blaeu/core` to a
single copy — which is the `fixed`-group lockstep doing its job, and the failure mode
(two kernels, two event buses) the peer dependency exists to prevent.

It covers neither of the two things that actually failed. A local registry accepts any scope
and any token, so it cannot tell you whether `@blaeu` exists on npmjs.com or whether the
OIDC exchange works. Those two are only ever proven in production, which is what the 0.1.3
run above is for.

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

## The one check that will not go green on its own

The **Version Packages** pull request is opened by `github-actions[bot]`, and GitHub treats a
bot-authored PR as coming from a first-time contributor: its CI runs land in
`action_required` and wait for a human to approve them. Every other pull request in this
repository, Dependabot's included, goes green unattended.

This is not a setting that can be turned off. The repository-level policy accepts only
`first_time_contributors_new_to_github`, `first_time_contributors` or
`all_external_contributors` — there is no "never" — and the loosest of the three was set and
still gated the bot. Approving a run does not promote the bot to contributor, either: the
next release PR gates again. Both were measured here rather than inferred.

Two ways to live with it:

- **Approve it, once per release.** On the PR's checks, or
  `gh api -X POST repos/celikgo/blaeu-lib/actions/runs/<id>/approve`. What that click is
  worth knowing about: it is not the gate protecting the release. `release.yml` runs
  `npm run verify` on `main` after the merge and before `changeset publish`, so a release
  that should not ship is stopped there whether or not the PR's own checks ran.
- **Give it a real identity.** A PAT with `repo` scope stored as `RELEASE_PR_TOKEN` makes
  the PR come from an account rather than the bot, and the gating stops. `release.yml`
  already reads it —
  `github-token: ${{ secrets.RELEASE_PR_TOKEN || secrets.GITHUB_TOKEN }}` — so adding the
  secret is the whole change; there is no code to edit.

## The version trap

`.changeset/config.json` documents this at length and it is worth repeating, because it is
the kind of thing discovered at the worst moment:

**With a `fixed` group, a `minor` changeset on `0.x` packages does not give `0.2.0` — it gives
`1.0.0`.** Changesets cannot keep a group aligned across a `0.x` minor, so it escalates. This
was measured, not inferred.

So while the API is still moving, keep every changeset `patch`. Take `1.0.0` deliberately —
when hit testing is verified on a GPU runner and the mutation score is respectable — rather
than by accident on the way past.

The packages currently sit at **0.1.2** and `.changeset/` is empty — the one pending
changeset (the `data-fx-*` → `data-bl-*` rename in `@blaeu/plugin-ui`) was consumed when
the Version Packages PR merged on 2026-08-20. So the first publish is **0.1.2**, by hand,
and the first CI publish is **0.1.3**, from a changeset that does not exist yet.

One piece of drift that follows from that merge and is _not_ a blocker:
`package-lock.json` still records every workspace at 0.1.1 and the example apps' `@blaeu/*`
ranges at `^0.1.1`, because `changeset version` does not touch the lockfile. Measured
rather than assumed — `npm ci --dry-run` exits 0, since npm satisfies a workspace range by
symlink and not by the recorded version, so `release.yml`'s `npm ci` is safe. It will widen
by one patch at every release until something regenerates it.
