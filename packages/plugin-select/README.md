# @blaeu/plugin-select

Selection for BlaeuMap: single click, multi-select, box drag, freehand lasso.

```bash
npm install @blaeu/plugin-select
```

## Usage

```ts
import { createBlaeuMap } from '@blaeu/core'
import { selectPlugin } from '@blaeu/plugin-select'

const map = await createBlaeuMap({
  container: '#map',
  plugins: [selectPlugin({ collections: ['parcels'], multiKey: 'shift' })],
  layers: [{ id: 'parcels', type: 'vector', source: 'parcels' }],
})

map.tools.activate('select:box')

const select = map.plugin('select') // → SelectApi, no cast
map.events.on('select:changed', (e) => {
  console.log(e.payload.added, e.payload.removed, e.payload.selected.size)
})

select.selectByFilter((f) => f.properties.ada === '1234')
console.log(map.crs.area(select.features[0]!.geometry))
```

## What it registers

| Kind  | Id                 | Notes                                                             |
| ----- | ------------------ | ----------------------------------------------------------------- |
| Tool  | `select:single`    | Click. Multi-key toggles; a plain click on empty space clears     |
| Tool  | `select:box`       | Drag a marquee. A press that never moves is treated as a click    |
| Tool  | `select:lasso`     | Freehand ring; selects features whose **centroid** is inside      |
| Layer | `select:highlight` | The selection halo, painted with `theme.token('color').selection` |
| Layer | `select:preview`   | The marquee / lasso trace while the gesture is in flight          |

Both layers are hoisted above every declared layer on `map:ready`, so the halo is
never painted over by the features it highlights.

## What it depends on

Nothing. No plugin dependencies, optional or otherwise — selection is what every
other plugin wants to build on, so it has to work on a bare kernel. `@blaeu/core`
is a peer dependency; `@turf/boolean-point-in-polygon` and `@turf/helpers` are the
only runtime dependencies.

## Events

| Event            | Payload                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `select:changed` | `{ selected: ReadonlySet<FeatureId>; added: readonly FeatureId[]; removed: readonly FeatureId[] }` |

The **deltas** are in the payload deliberately. A UI that only got `selected` would
have to diff it against its own copy to know which table row to un-highlight, and
would get it wrong the first time two selections changed within one frame.

## Options

| Option         | Default   | Meaning                                                             |
| -------------- | --------- | ------------------------------------------------------------------- |
| `collections`  | all       | Restrict what is selectable. `[]` freezes selection entirely        |
| `multiKey`     | `'shift'` | The modifier that adds rather than replaces (`shift`/`ctrl`/`meta`) |
| `selectLocked` | `false`   | Allow `meta.locked` features to be selected                         |

`alt` always subtracts, in every tool. That is not an option because it is not a
preference — every selection UI the user has already met behaves this way.

Hidden features (`meta.hidden`) are **never** selectable, whatever the options say:
you cannot select what is not on the map. Locked features are a policy, and
`selectLocked` is the switch.

## API

```ts
interface SelectApi {
  select(
    ids: FeatureId | readonly FeatureId[],
    mode?: 'replace' | 'add' | 'toggle' | 'subtract',
  ): void
  clear(): void
  readonly selected: ReadonlySet<FeatureId>
  readonly features: readonly BlaeuFeature[]
  selectByFilter(fn: (f: BlaeuFeature) => boolean): void
  onChange(handler: (ids: ReadonlySet<FeatureId>) => void): Disposable
}
```

`select()` drops ids that are not selectable, or that the store has never heard of.
`subtract` is exempt: a feature locked _after_ it was selected must still be
removable, or the user cannot clear it.

## Selection is not on the undo stack, and that is on purpose

This plugin dispatches **no commands** and writes **nothing** to the store. It is the
clearest example in the library of the transient/committed split.

Core invariant 2 says every change to the _document_ is a `Command`, so that undo has
a record of it. A selection is not the document — it is what the user is currently
pointing at. If it were undoable, a Ctrl-Z after deleting three parcels would first
restore the fact that they had been selected, twice, before restoring the parcels; and
every user would read that as broken.

So the highlight lives in a renderer source, not a store collection. Nothing validates
it, nothing exports it, `store.snapshot()` does not contain it, and undo has nothing to
say about it.

## Performance

The lasso does a bbox pre-filter through the store's R-tree (`collection.query(bbox)`)
before it runs point-in-polygon on anything. That is not a micro-optimisation: it is
the difference between a usable tool and a frozen tab on a 50 000-parcel layer.
