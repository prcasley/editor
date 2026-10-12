# Red Mountain: one photo in, an editable Pascal house out

Hendrickson Construction's "Red Mountain" house in Aspen, Colorado, rebuilt as an editable
Pascal scene from the builder's published dusk photo. The scene is built only through
the Pascal MCP server's tools (`create_story_shell`, `create_room`, `add_window`,
`add_door`, `create_stair`, `create_roof`, `add_wall`, `apply_patch`, ...). The result is a
scene graph you can keep editing (levels, walls, rooms, windows, slabs, rails, roof,
chimneys), not a picture.

This is **not** CCY Architects' concrete house, which is also called Red Mountain. None of
that house's numbers or materials are used here. See [facts.md](facts.md).

## Files

| File | What it is |
|---|---|
| `build.ts` | Rebuilds the scene from scratch through MCP tool calls, checks it, and writes every other generated file |
| `facts.json` | Every dimension, each either read from the hero photo (by an earlier build) or marked as an estimate with its reason |
| `facts.md` | Generated from `facts.json` plus the build results: stats, checks, sources, estimates |
| `red-mountain.json` | The Pascal build file (`{ nodes, rootNodeIds, collections, materials }`) |
| `cameras.json` | Render viewpoints in metres in Pascal's frame: `hero`, `front`, `side`, `back`, `aerial`, `top` |
| `sandstone.jpg` | The light sandstone texture: the library's stone texture recoloured to the photo's tan-cream. It is embedded in the scene file as a scene material |

## What the scene contains

- Three storeys: level 1 (92 x 52 ft plus a 26 x 38 ft one-storey wing at the far left),
  level 2 set back behind a cantilevered balcony, and level 3 set back again. Floor-to-floor
  heights are 12.2, 12.4 and 10.5 ft, with the roof base at 35.1 ft.
- On every facade, floor-to-ceiling glass in dark bronze frames runs between sandstone piers,
  split into panels of about 5.5 ft, with a glass entry door on the front.
- Cantilevered slabs with paver tops, bronze fascias and cedar soffits underneath, and
  frameless glass rails along the front and near side of levels 2 and 3 and the wing deck.
- A flat roof with a cedar soffit, a bronze edge and a charcoal membrane, plus two stone
  chimneys.
- At grade: stone paver terraces along the front and near side, a lawn, and a boulder
  retaining wall at the far left.
- Inside (invented): a stair hall stacked through all three floors with two flights, and a
  few named rooms on each level.

Gross floor area, measured on the model's outer footprints: **11,988 SF (1,114 m²)**.
No floor area is published for this house, so there is nothing to compare it against.

## Orientation

Coordinates are Pascal's: metres, x east, z south, y up. The front facade (the long face in
the hero photo) faces +z (south), and the near-right face in the photo is the +x (east) end.
`cameras.json` uses the same frame. Each camera is `{ position, target, fov }`, with fov the
vertical field of view in degrees.

## Rebuild

```bash
bun install --filter './packages/*'
bun run --cwd packages/mcp build          # the MCP server and core
bun examples/red-mountain/build.ts
```

The script opens an in-process MCP client and server, starts from `clear_scene`, builds the
house, then runs `validate_scene`, `verify_scene` and the editor's `validateBuildJson`.
It writes `red-mountain.json` and `cameras.json` and regenerates `facts.md`. On the current
build all three checks pass with no errors, warnings or issues. Change a number in
`facts.json` (a pier position, a slab depth, the panel width) and rerun to get the corrected
scene.

## Open it

- **In the editor:** Settings > *Save and load* > *Load build*, then pick
  `red-mountain.json`.
- **Through MCP:**
  `node packages/mcp/dist/bin/pascal-mcp.js --stdio --scene examples/red-mountain/red-mountain.json`,
  then use `get_level_summary`, `describe_node` and the editing tools.

## Materials

| Element | Finish |
|---|---|
| Exterior walls, piers, retaining wall, terrace edges, chimneys | `scene:mat_sandstone`: the library `flooring-wallstone1` texture recoloured to light sandstone (the library version renders orange-brown) |
| Interior wall faces | `library:concrete-plaster` |
| Window and door frames, slab fascias, rail caps, roof edge | `library:preset-espresso` (dark bronze) |
| Glazing and glass rails | `library:preset-glass` |
| Balcony and terrace pavers | `library:flooring-tile79` (stone tile) |
| Slab and roof soffits | `library:siding-lap-cedar` |
| Roof membrane | `library:preset-charcoal` |
| Stairs | `library:wood-woodplank48` |
| Lawn | flat `#55703f` (the catalog has no grass finish) |

## Real vs invented

- **Read from the hero photo** (an earlier reading of the builder's dusk photo; the photo is
  referenced by URL only): the storey count, every footprint, slab extent and height, the
  pier positions on the front and near-side facades, the panel width, the soffit and roof
  depths, the chimneys, and the terraces.
- **Estimated:** wall thickness, rail height, the gap between the glass head and the slab,
  the retaining wall's line, and the lawn extent.
- **Invented:** the back and far-left facades (no published photo shows them), all interior
  rooms, the stair positions and the entry door position.
- **Not modelled:** the wall sconces on the piers. The item library has no light fixture,
  and a scripted object needs script compilation, which the in-process build does not
  enable. The roof's low slope is also modelled as flat.

## Sources

- Hendrickson Construction, "Red Mountain" project gallery:
  <https://hendricksoninc.com/our-work/red-mountain/>
- Hero photo (referenced, not stored):
  <https://hendricksoninc.com/wp-content/uploads/2025/06/Red-Mountain-01-Hendrickson-Construction.jpg>

The photos belong to Hendrickson Construction and are not stored in this repository.
