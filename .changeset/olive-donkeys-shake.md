---
'@blaeu/plugin-ui': patch
---

Rename the toolbar's DOM hooks from `data-fx-id` / `data-fx-key` to `data-bl-id` / `data-bl-key`.

These attributes are a public contract, not decoration: they are how a consumer's CSS or test
finds one button without matching a translated label, and `@blaeu/plugin-ui`'s README documents
them as such. They were the last surviving `fx` prefix from the project's former name, and the
only one that lived in a shipped artefact rather than in prose.

If you select on `[data-fx-id]` or `[data-fx-key]`, update the selector. Nothing else about the
toolbar changed — same elements, same order, same `aria-pressed` behaviour.

Every package README was also rewritten in this release. They ship inside the published tarballs
(`files` includes `README.md`), so they are what npm renders on each package page.
