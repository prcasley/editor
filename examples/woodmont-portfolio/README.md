# Woodmont portfolio: public facts in, editable Pascal buildings out

Three properties developed by Woodmont Properties (Fairfield, NJ), each rebuilt as an
editable Pascal scene from public photos, press coverage, leasing sheets and
OpenStreetMap. Every scene is built only through the Pascal MCP server's tools
(`create_room`, `create_story_shell`, `add_door`, `add_window`, `create_stair`,
`create_roof`, `add_column`, `set_zone`, `apply_patch`, ...), the same contracts an
agent drives over stdio, so the result is a scene graph a person can keep editing,
not a picture.

| Property | Type | Scenes | Why it is here |
|---|---|---|---|
| [Woodmont Way](woodmont-way/facts.md), West Windsor NJ | 443-unit garden-style rental community, 13 buildings | `site-detailed.json`, `site-massing.json`, `typical-building.json` | The flagship: mapped footprints for every building, published unit and building counts, amenity list and photos |
| [111 Main Street](111-main-street/facts.md), South Amboy NJ | 152,100 SF rear-load warehouse on 22 acres | `site-massing.json` | The leasing sheet publishes enough to derive the plan: a 195 ft deep space, a 60 ft speed bay and 56'6" x 45' column bays give 780 x 195 ft |
| [Alpha 78 Logistics Center](alpha-78/facts.md), Alpha NJ | 450,457 SF cross-dock warehouse on 33.67 acres | `site-massing.json` | A different industrial type with a complete public count set: 118 docks, 4 drive-ins, 130 ft truck court, 89 trailer and 230 car spaces |

Each property folder has its `facts.json` (every number with its source, its
derivation, or its reason as an estimate), a generated `facts.md`, the scene files and
`renders/`.

## What each scene contains

- **Woodmont Way, detailed site** (`site-detailed.json`, built by
  `woodmont-way/build-detailed.ts`): every mapped structure on its OpenStreetMap
  footprint with the facade vocabulary read from the public renderings and photos.
  Residential buildings get lap siding in white, tan, light gray or sage (Pascal's
  `siding-lap-*` library finishes), a red-brick ground floor on every second building,
  white trim bands between floors, paired windows in 7.6 m bays on every facade,
  sliding doors to stacked balconies with railings on white square columns (patios at
  grade), entry doors on the end walls, a stair per storey, and hip roofs in grey
  asphalt shingles with cross-gables and gable dormers. Also the two-story clubhouse
  (hip wings and a centre gable), the detached garages with garage doors, the
  maintenance building, the tiled pool with its deck and cabana, the published
  pickleball and bocce courts and bark park (positions estimated), streets, drives,
  parking, building walks, lawn, and street trees made from one procedural tree design
  (`tree-design.json`). Render viewpoints are in `cameras-detailed.json`.
- **Woodmont Way, site massing**: all 16 mapped structures on their OpenStreetMap
  footprints (12 apartment buildings at 4 stories, the 2-story clubhouse, 2 detached
  garages, the maintenance building), each a Pascal building with one story shell per
  floor and a hip or gable roof, carrying its OSM way id as `provenance`; the pool
  (recessed), its deck and the cabana; public streets and internal drives from OSM
  centrelines, and parking stall strips wherever they clear the buildings.
- **Woodmont Way, typical building** (OSM way 1518661329, 68.4 x 24.4 m): four floors
  of 10 units on a double-loaded corridor, two stair halls with a switchback flight per
  storey, a sliding door to a balcony for every unit (patios at grade), double-hung
  window rhythm on every facade, entry doors at both corridor ends, and a hip roof.
  `verify_scene` reports no issues on it.
- **111 Main Street**: the warehouse on a dock-high floor, split into the published
  55,250 SF available space and the leased remainder by a demising wall; 25 dock doors
  and 2 drive-ins on the south wall (8 + 1 in the available space, as its brochure
  lists); 39 columns on the published bay grid; flat roof; truck court, a row of 26
  trailer stalls and an estimated car field on grade.
- **Alpha 78**: the cross-dock warehouse with 59 docks and 2 drive-ins on each long
  wall, a 3,000 SF spec office, flat roof, two 130 ft truck courts, 89 trailer stalls
  and 230 car stalls on grade.

## Open a scene

The `.json` files are Pascal build files (`{ nodes, rootNodeIds, collections }`), the
format the MCP server's `export_json` writes and the editor's own save uses.

- **In the editor**: open the Settings panel, then *Save and load* > *Load build*, and
  pick the file. The build script runs the same `validateBuildJson` check that dialog
  runs, and every file passes it.
- **Through MCP**: start the server with the scene loaded, for example
  `node packages/mcp/dist/bin/pascal-mcp.js --stdio --scene examples/woodmont-portfolio/woodmont-way/typical-building.json`
  (or `bunx @pascal-app/mcp --stdio --scene <file>`), then use `get_level_summary`,
  `find_nodes { sourceIdPrefix: "way/" }`, `describe_node` and the editing tools on it.

Coordinates are Pascal's: metres, x east, z south, y up. The site-massing scenes keep
true north as plan up; the typical building is drawn in its own axes.

## Rebuild everything from the facts

```bash
bun install
bun run --cwd packages/mcp build                          # the MCP server and core
bun examples/woodmont-portfolio/build.ts                  # every property
bun examples/woodmont-portfolio/build.ts woodmont-way     # one property (the detailed site takes several minutes)
```

The script opens an in-process MCP client and server per scene, starts from
`clear_scene`, builds the scene with tool calls only, runs `validate_scene`,
`verify_scene` and the editor's `validateBuildJson`, writes the scene file, and
regenerates `facts.md` from `facts.json` and the results. Loading `facts.json` refuses
any fact that has neither a source quote, a derivation, nor an estimate reason, so an
unlabelled number cannot reach a scene. Change a fact (say, Woodmont Way's stories, or
Alpha 78's estimated depth) and rerun to get the corrected scene. Node ids are freshly
generated on each run; the geometry is identical.

## What is real and what is estimated

Real (quoted from a public source, or derived from quoted numbers and shown how):
building counts and areas, unit count, site acreage, clear heights, dock, drive-in,
trailer and car counts, truck court depth (Alpha 78), column bays (111 Main), the
two-story clubhouse, 9-foot ceilings, a patio or balcony for every Woodmont Way home,
and every Woodmont Way footprint, pool and road centreline (OpenStreetMap). 111 Main
Street's 780 x 195 ft plan is derived: its leasing sheet gives a 283'-4" x 195' space
and 152,100 SF / 195 ft = 780 ft exactly, and its bays add up to the 195 ft depth.

Estimated, and labelled as such in every `facts.md`:

- **Woodmont Way story counts** (4 on every apartment building) are the largest
  uncertainty. Photos and the aerial rendering show four floors on most buildings, but 4
  stories over the mapped footprints implies about 1,820 gross SF per unit, high for
  garden apartments, so some buildings are probably 3 stories.
- **Woodmont Way facades** in the detailed site: the siding colours, brick bases,
  trim, window bays, balconies, cross-gables and dormers follow what an earlier session
  read from the public renderings and photos, but which building has which colour or a
  brick base, the bay count on each facade and every amenity position are estimates.
- **Interior layouts** of the typical building: units per floor, corridor, stair halls,
  balcony size, window rhythm.
- **Industrial site layouts**: neither parcel geometry nor aerial imagery was reachable
  from the build environment, so each site is a rectangle of the published acreage with
  the building centred, docks facing plan south. Areas and counts are right; positions
  and orientation are schematic.
- **Alpha 78's 400 ft depth** (its length follows from the published area), wall
  heights, dock-high floors, door sizes and dock spacing, the 111 Main car count
  (scaled from the brochure's 30 spaces per 55,250 SF), and Woodmont Way's road widths,
  parking stalls (about 870, no public count) and site outline (14 acres against the
  published 23).

Conflicts between sources (433 vs 443 units, 22 vs 25 docks, 6,000 vs 3,000 SF office,
three different Woodmont Way addresses) are listed in each `facts.md` with the value
used and why.

## Renders

`renders/` holds views of the scenes drawn by this repository's own viewer
(`@pascal-app/viewer` and the `pascal:core` node definitions, built from source) in
headless Chromium. No WebGPU adapter is available in that environment, so the viewer
ran on its WebGL2 fallback backend; some material textures were not available offline
and fell back to flat colours. The renders show the scene files exactly as built; they
are not retouched.

Renders present: `woodmont-way/renders/site-massing-aerial.png`,
`woodmont-way/renders/typical-building-north.png`,
`111-main-street/renders/site-massing-aerial.png`, `alpha-78/renders/site-massing-aerial.png`.
A plan view of the Woodmont Way site and a south view of the typical building were
attempted but the headless renderer crashed before writing them; they are not included.

## Sources and rights

Public sources only: woodmontproperties.com, the properties' leasing sites (CBRE,
111mainsamboy.com), Real Estate NJ, ROI-NJ, NJBIZ, JLL, Planet Princeton, Community News,
Multi-Housing News, and OpenStreetMap. Each `facts.md` lists them with dates and links.
Photos and renderings belong to Woodmont Properties and their publishers; they are
referenced by URL in `facts.md` and are not stored in this repository.
`woodmont-way/osm-extract.json` is OpenStreetMap data, (c) OpenStreetMap contributors,
available under the Open Database License (ODbL) 1.0.

The brief for this portfolio pointed at woodmont.com; that domain belongs to an
unrelated company (The Woodmont Company, Fort Worth, Texas). Woodmont Properties is
woodmontproperties.com.
