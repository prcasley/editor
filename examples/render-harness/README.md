# Render harness

Renders a Pascal build file (`{ nodes, rootNodeIds, collections, materials }`) from named
cameras with this repository's own viewer (`@pascal-app/viewer` and the `pascal:core`
node definitions, bundled straight from source), in headless Chromium. It can also save
Pascal's own GLB export of the scene, the same `exportSceneToGlb` the editor's Export
button runs.

```bash
bun install --filter './packages/*'          # apps/editor's plugin deps are not needed
node examples/render-harness/build.mjs        # bundles src/main.tsx -> dist/main.js

# Playwright and a Chromium build must be reachable; point at them if not on the path.
PLAYWRIGHT_PATH=$(npm root -g)/playwright CHROMIUM_PATH=/path/to/chrome \
node examples/render-harness/render.mjs <scene.json> <cameras.json> <out-dir> \
  [--theme twilight] [--size 1600x900] [--only hero,front] [--postfx] [--glb out.glb]
```

`cameras.json` maps a name to `{ "position": [x, y, z], "target": [x, y, z], "fov": 45 }`
(metres, Pascal world axes), with an optional per-camera `"theme"` (any scene theme id:
`verdant`, `sunset`, `twilight`, `overcast`, `studio`, ...).

How it works offline:

- **Library finishes.** Catalog materials reference `_512.ktx2` maps on the assets CDN.
  The same finishes ship in `apps/editor/public/material/` as `.webp`; the render script
  maps each catalog map to its local file and the page swaps the URLs before the scene
  loads. Maps with no local copy are dropped, so that finish falls back to its colour.
- **KTX2 transcoder.** Requests for the basis transcoder are answered from
  `node_modules/three/examples/jsm/libs/basis/`.
- **Other network requests are blocked** and listed at the end of the run.
- **No GPU.** Without a WebGPU adapter the viewer runs its WebGL2 fallback on SwiftShader;
  expect one to three minutes per frame. `--postfx` turns on the SSGI/AO pipeline, which
  is much slower in software.

Renders are screenshots of the viewer canvas, not retouched.

## Drawing sets

`--sheets spec.json --sheets-out set.pdf` also writes a multi-sheet PDF through the
editor's own sheet writer (`exportSheetsToPdf`). Plan pages run Pascal's floor-plan
pipeline (`collectSheetGeometry`) for one level, so walls, openings, opening marks, stairs
and dimension strings are exactly what the 2D editor draws; room names and areas are
added from each zone. Image pages place renders (for example near-orthographic
elevations, shot with a narrow field of view from far away) at a stated scale, with level
datum lines. Every page gets a border and title block. See `src/sheets.ts` for the spec
format and `examples/red-mountain/drawings/` for a full set.

The sheet writer pipes into `blob-stream`, which needs Node streams; `src/blob-stream-shim.js`
stands in for it in the browser.
