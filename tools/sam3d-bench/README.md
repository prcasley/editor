# sam3d-bench: how accurately does single-image 3D measure?

A benchmark harness for single-image 3D reconstruction, aimed first at Meta's
[SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects). It asks one question: given
one photo and a mask, how close are the reconstruction's dimensions to the real ones?

| Part | Where | Status |
|---|---|---|
| Case format and validator | `sam3d_bench/case_format.py` | Tested here |
| Ground-truth cases from Pascal scenes | `sam3d_bench/pascal_cases.py`, `cases/` | Tested here; 21 cases generated |
| Render script for case images | `sam3d_bench/render_script.py`, `render-cases.sh` | 2 images rendered here as proof; 19 still to render |
| GPU runner (Docker + `run.py`) | `runner/` | **Not built or run.** Only `--dry-run` was run here (no GPU, Hugging Face blocked) |
| Scorer (numpy only) | `sam3d_bench/score.py` | Tested here on synthetic point clouds; never yet on a real SAM 3D output |

Everything runs with Python 3.10+ and numpy. The tests also need pytest.

## Layout

```
tools/sam3d-bench/
  sam3d_bench/        library + CLIs (python -m sam3d_bench.<module>)
  cases/<case_id>/    one folder per case (format below)
  render-cases.sh     generated: renders every Pascal case's image.png, one at a time
  runner/             Dockerfile + run.py for a Linux NVIDIA GPU box
  tests/              pytest
  runs/, results/     outputs (git-ignored)
```

## Case format (`ground-truth.json`, schema `sam3d-bench/case@1`)

A case is a folder holding an image, a mask of the target object and its true size. The same
format serves our own Pascal renders and external datasets, so the runner and scorer do not
care where a case came from.

```
<case_id>/
  ground-truth.json   required
  image.png           RGB input
  mask.png            target mask, same size as the image; white (or alpha) = object
  gt-mesh.obj         optional: true surface as triangles, object frame (used for Chamfer)
  gt-points.ply       optional: true surface samples, object frame (used for Chamfer)
  render-request.json Pascal cases only: how image.png is rendered
```

**Object frame.** Metres. Origin at the centre of the object's bounding box, +Y up, +X along
the longer horizontal side, +Z along the shorter one. `width`, `height` and `depth` are that
box's extents along X, Y and Z. **Camera** is OpenCV (x right, y down, z forward), pixel
centres on integers.

```jsonc
{
  "schema": "sam3d-bench/case@1",
  "case_id": "ikea-billy-80",                 // must equal the folder name; [a-z0-9._-]
  "source": {
    "kind": "external",                       // or "pascal-scene"
    "dataset": "my-shelf-photos",             // external: required
    "url": "https://example.org/photo/123",   // external: required, http(s)
    "license": "CC BY 4.0, photo by J. Doe"   // always required: the image's licence or terms
    // pascal-scene requires scene_path, scene_sha256, node_id (the generator writes them)
  },
  "files": {"image": "image.png", "mask": "mask.png", "gt_mesh": "gt-mesh.obj"},
  "object": {
    "dimensions_m": {"width": 0.80, "height": 2.02, "depth": 0.28},
    "world_from_object": null,                // optional 4x4, when the scene pose is known
    "measurements": [                         // optional extra known lengths
      {"name": "shelf_spacing", "value_m": 0.35, "axis": null, "count": 5,
       "derivation": "manufacturer drawing, 350 mm pitch"}
    ]
  },
  "camera": null,                             // optional: {"convention": "opencv", width, height,
                                              //  fx, fy, cx, cy, "world_from_camera": 4x4}
  "reference_measurement": "width"            // what --scale reference uses by default
}
```

Rules the validator enforces (`load_case` names every problem at once): positive finite
dimensions; every measurement has a derivation; `axis` is `x`, `y`, `z` (the measurement *is*
the bbox extent on that axis, so it can set scale) or `null`; file paths stay inside the
folder; image, mask and camera sizes agree; a licence is always present.

**Adding an external dataset**: one folder per object with the files above. Masks can be any
PNG (gray, RGB, palette or alpha). If the dataset gives a mesh, convert it to OBJ in the object
frame and list it as `gt_mesh`; otherwise Chamfer falls back to the ground-truth box surface
and says so (`chamfer.gt_surface: "bbox"`).

## 1. Ground-truth cases from Pascal scenes

We own these scenes, so the ground truth is exact for the rendered image: the image and the
numbers come from the same scene graph.

```bash
cd tools/sam3d-bench
S=../../../editor-portfolio/examples/woodmont-portfolio   # branch feat/woodmont-portfolio
python3 -m sam3d_bench.pascal_cases --scene $S/woodmont-way/typical-building.json \
    --views oblique,oblique-back --out cases
python3 -m sam3d_bench.pascal_cases --scene $S/woodmont-way/site-massing.json --out cases
python3 -m sam3d_bench.pascal_cases --scene $S/111-main-street/site-massing.json --out cases
python3 -m sam3d_bench.pascal_cases --scene $S/alpha-78/site-massing.json --out cases
python3 -m sam3d_bench.pascal_cases --scene $S/woodmont-way/site-massing.json \
    --building "Detached garage 1" --views oblique-back,aerial --out cases
```

Options: `--building <id or name>` (repeatable), `--views oblique,oblique-back,aerial`,
`--size 1024x768`, `--fov 40`, `--min-visible 0.6`, `--write-depth` (metric `depth-gt.npy`,
git-ignored; an oracle input for the metric-depth hook).

How the numbers are derived, per building:

- **Storeys**: one prism per wall at its stored thickness, from the level's base to its stored
  height (plane-bound walls reach the storey top), corners mitred on the bisector; every slab as
  its own prism, so balconies count. Levels stack by `level` order plus `baseElevation`.
- **Roofs**: the segment's slope frame and visible-top bounds as `@pascal-app/core` computes
  them, and the viewer roof system's layer stack: peak = `wallHeight + rise + deck/cos(pitch) +
  shingle/cos(pitch)`. Hip, gable, shed, flat and conical are supported.
- **Refused, not guessed**: gambrel, mansard and dutch roofs, trimmed segments, wall-hosted
  roofs, explicit wall heights and floor-foundation lifts raise `SceneGeometryError`, and the
  building is skipped with the reason.
- **Measurements**: storey height (with count), wall-top height, footprint length and width
  (wall outer faces), eave height, and every exterior door and window size with its count.
- **Mask**: a z-buffer of every building's massing from the case camera, so neighbours occlude
  the target. Views where less than 60% of the target is visible are skipped
  (`mask_stats.visible_fraction` records the rest). The massing omits window recesses, railings
  and other small detail, so mask edges can differ from the render by a few pixels.

Checks run on the typical Woodmont Way building: height 20.039 m = 4 × 3.05 + 0.35 + 7.316
(30° hip over a 25.342 m span) + 0.1/cos 30° + 0.05/cos 30°; width 69.464 m = roof 69.254 +
2 × (0.08 + 0.05·sin 30°); depth 28.342 m spans the balconies (the walls are 24.742 m).

## 2. Render the images

Rendering uses the Pascal headless harness (`render.mjs`, Playwright + SwiftShader WebGL) and
takes about 3 to 5 minutes per image on a CPU box, so it runs one image at a time:

```bash
python3 -m sam3d_bench.render_script --cases cases --out render-cases.sh
RENDERER=/path/to/harness/render.mjs BASE=http://127.0.0.1:5391/ ./render-cases.sh            # all
RENDERER=... ./render-cases.sh pascal-woodmont-way-site-massing-clubhouse-oblique             # one
```

Each `render-request.json` holds the scene's absolute path on the machine that generated the
case (the harness loads it through Vite's `/@fs`), so on another machine regenerate the cases
there first; `ground-truth.json` keeps the portable provenance (repo-relative `scene_path`,
`scene_commit`, `scene_sha256`).

The script skips cases that already have `image.png`, keeps an image only when the renderer
exits 0 and wrote a file, and exits non-zero if any render failed. The harness's camera is a
three.js `PerspectiveCamera` (vertical fov, `lookAt(target)`, +Y up); `ground-truth.json` holds
the same camera in OpenCV form.

## 3. Run SAM 3D Objects on a GPU (untested)

Needs Linux, an NVIDIA GPU with at least 32 GB (an H100 or L40S VM on Nebius or similar),
Docker with the NVIDIA container toolkit, and access to the gated checkpoints.

```bash
# once: request access at https://huggingface.co/facebook/sam-3d-objects, then on the VM
pip install 'huggingface-hub[cli]<1.0' && hf auth login          # interactive; no token in files
hf download --repo-type model --local-dir checkpoints/hf-download --max-workers 1 facebook/sam-3d-objects
mv checkpoints/hf-download/checkpoints checkpoints/hf && rm -rf checkpoints/hf-download

# build (from tools/sam3d-bench) and run
docker build -f runner/Dockerfile -t sam3d-bench .
docker run --gpus all --rm \
  -v "$PWD/checkpoints/hf:/opt/sam-3d-objects/checkpoints/hf:ro" \
  -v "$PWD/cases:/cases:ro" -v "$PWD/runs:/runs" \
  sam3d-bench --cases /cases --out /runs/sam3d-f91db41
```

`run.py` options: `--only <case_id ...>`, `--seed 42`, `--timeout 900` (per case),
`--overwrite`, `--dry-run` (validates the cases without torch), `--pointmap-name pointmap.npy`
(when a case folder holds that H × W × 3 metric pointmap, for example from MoGe-2, it is passed
as `Inference(..., pointmap=...)`; the layout SAM 3D expects is not confirmed). Outputs per case in
`runs/<label>/<case_id>/`: `splat.ply` (object frame), `splat-posed.ply` and `layout.json`
(the predicted rotation, translation and scale), `output-keys.json` (what the pipeline
returned, with shapes) and `reconstruction.json` (status, seconds, peak GPU memory, GPU name,
upstream commit). A failed case keeps no PLY and makes the exit code non-zero.

The Dockerfile follows upstream `doc/setup.md` at commit `f91db41` and forces CUDA kernels for
sm 80/86/89/90 because the image is built without a GPU (upstream warns pytorch3d can otherwise
build without GPU support). Expect to fix something on the first build.

## 4. Score

```bash
python3 -m sam3d_bench.score --cases cases --recons runs/sam3d-f91db41 \
    --scale oracle-height --out results/oracle
python3 -m sam3d_bench.score --cases cases --recons runs/sam3d-f91db41 \
    --scale reference --out results/reference                   # each case's reference (width)
python3 -m sam3d_bench.score --cases cases --recons runs/sam3d-f91db41 \
    --recon-name splat-posed.ply --scale none --out results/native   # the model's own scale
```

Per case it reports bounding-box errors for width, height and depth (%), aspect-ratio errors
(width/height, depth/height, width/depth, which do not depend on scale), symmetric Chamfer
distance after the bounding-box alignment (metres and % of the true diagonal; no ICP), and
pass/fail: every dimension within `--tolerance` (default 5%), not counting the one the scale
method fixes. Output: `results.json` (settings, summary, per-case detail) and `results.md`.

**Scale methods** (`--scale`):

| Method | Meaning |
|---|---|
| `reference` | One known length sets the scale: a measurement whose `axis` is set, `--reference <name>` or the case's `reference_measurement`. That dimension is exact by construction and is excluded from pass/fail |
| `oracle-height` | Scale from the true height. An upper bound, since it uses the answer |
| `metric-depth` | Hook: `--depth depth.npy` (metres, H × W) from any metric depth model, or the Pascal oracle `depth-gt.npy`. Scale = median of depth / reconstruction depth over mask pixels. Needs the reconstruction in the case camera's OpenCV frame |
| `none` | Take the reconstruction's units as metres (tests the model's native scale) |

A custom method is any callable `(case, points, fitted) -> ScaleResult` passed to `score_case`.

**Up axis** (`--up`): SAM 3D's object frame orientation has not been confirmed. `auto` fits an
oriented box and assigns its extents to width, height and depth by best match to the true
proportions; that can hide a height error, so results say `auto-matched` and the table flags
them as optimistic. Once a real run shows the convention, pass it (`--up +z`, ...).

**Point filtering**: splats under `--min-opacity` (0.5, after the 3DGS sigmoid) are dropped,
then isolated splats (fewer than `--isolated-min` 5 points in their 3×3×3 voxel neighbourhood,
voxel = 2% of the diagonal). Percentile trimming (`--trim-pct`) is off by default because it
shaves real sharp features such as ridges and apexes.

**Reading Chamfer**: the default samples 4000 points per side, which puts a floor of about
half the sample spacing under the score (about 0.15 m on a 336 m² surface). Compare cases
through `pct_of_gt_diagonal`, not absolute metres.

## Tests

```bash
cd tools/sam3d-bench
python3 -m pytest -q          # scorer on synthetic boxes, case generator, runner dry run
ruff check .
```

The scorer tests build boxes of known size, then rotate, scale, translate, noise and distort
them, and check: recovery under each scale method, a 10% squashed height caught by the
reference method, the 5% tolerance boundary, low-opacity and isolated floaters ignored, a
same-bbox pyramid scoring much worse on Chamfer, the metric-depth hook recovering a 3× scale
from a rasterized depth map, and the CLI reporting missing reconstructions as missing.

## Not verified yet

- The runner has never been built or run; the first GPU run is the test. `output-keys.json`
  exists so that run documents what the pipeline really returns.
- SAM 3D's object-frame up axis and the convention of its posed output are unknown, so
  `--up auto` and the metric-depth hook have not been tried on real outputs.
- Only 2 of 21 Pascal case images were rendered here; the rest are in `render-cases.sh`.
- No external dataset has been converted yet.
