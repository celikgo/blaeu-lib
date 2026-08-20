# @blaeu/plugin-ui

## 0.1.2

### Patch Changes

- 0828de1: Rename the toolbar's DOM hooks from `data-fx-id` / `data-fx-key` to `data-bl-id` / `data-bl-key`.

  These attributes are a public contract, not decoration: they are how a consumer's CSS or test
  finds one button without matching a translated label, and `@blaeu/plugin-ui`'s README documents
  them as such. They were the last surviving `fx` prefix from the project's former name, and the
  only one that lived in a shipped artefact rather than in prose.

  If you select on `[data-fx-id]` or `[data-fx-key]`, update the selector. Nothing else about the
  toolbar changed — same elements, same order, same `aria-pressed` behaviour.

  Every package README was also rewritten in this release. They ship inside the published tarballs
  (`files` includes `README.md`), so they are what npm renders on each package page.

- @blaeu/core@0.1.2

## 0.1.1

### Patch Changes

- eca6342: Close the ingest gate, fix four lifecycle seams, and make the packages installable.

  This is the **first release**. Nothing in the `@blaeu` scope has been published before, so none
  of the changes below can break anyone — they are stated as changes against the repository's own
  `0.1.0`, not against a released artefact.

  ### The store can no longer hold a geometry it cannot describe

  An unrecognised geometry type — a `{"type":"Circle"}` from Leaflet.Draw, a lower-cased
  `"polygon"` from a hand-rolled converter — used to be written as a feature with **no geometry**:
  absent from the spatial index, still counted by `collection.size`, exported with no geometry
  member. It is refused at ingest now, and a rejected write leaves the store exactly as it was.
  `restore()` measures every feature before clearing anything, so a snapshot it cannot restore no
  longer empties the store mid-rollback.

  ### A GeometryCollection can no longer switch validation off

  A parcel whose rings arrived wrapped in a `GeometryCollection` — which ArcGIS and several DXF
  converters produce — was skipped by every topology rule, _and_ was invisible **as a neighbour**,
  so it exempted the honest parcels around it too. Two parcels overlapping by 1 199 m² both
  committed clean. The topology rules now flatten a collection to its polygonal content, and
  `@blaeu/preset-cadastre` refuses one as a parcel with a message naming the type. Flatten to a
  `MultiPolygon` at your import boundary; `parcelGeometryTypeRule` is exported if you want to
  rebuild the rule list without it.

  ### Editing gestures end when they are told to
  - Dragging a corner onto its neighbour no longer moves a _different_ corner: a transient preview
    now preserves the ring's vertex count as well as its order.
  - `plugins.disable('edit')` actually disables editing, so a read-only viewer mode built on it is
    read-only.
  - `DrawApi.cancel()` no longer commits the shape it just cancelled on the pending pointer
    release.
  - An interrupted touch gesture ends where the finger was, instead of committing a rectangle
    stretched to the top-left corner of the map.

  ### The keyboard reaches tools

  `Renderer` gained an optional `onKey`, so Escape to cancel a drawing and Backspace to remove the
  last vertex work through the real interaction pipeline. Three package READMEs documented this
  behaviour; no renderer produced it. Custom draw tools now implement `abort()` so a cancel can
  reach the tool's own gesture anchor — a no-op if your tool keeps no state of its own.

  ### Packaging

  **ESM only.** The CommonJS build is gone: it could not load on the Node version these packages
  declare (`>=20`), because two dependencies are ESM-only and `require()` of the CJS entry threw
  `ERR_REQUIRE_ESM`. It appeared to work on Node 22.12+ only because `require(esm)` landed there.

  `maplibre-gl` 6 is supported — the peer range is `>=4.7.0 <7`, type-checked in CI against the
  floor and the ceiling. Licence text, a README and repository metadata now ship inside every
  package, and a CI job installs the built tarballs into a throwaway project and imports them.

- Updated dependencies [eca6342]
  - @blaeu/core@0.1.1
