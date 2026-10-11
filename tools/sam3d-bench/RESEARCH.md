# SAM 3D Objects dimension benchmark: research brief

Checked: 2026-10-11 by market-researcher. Tags: **[F]** fact read on the cited page today; **[E]** estimate; **[O]** opinion or recommendation; **[UNVERIFIED]** could not confirm on an official page today. Nothing was signed up for, downloaded or run.

## 0. What SAM 3D gives us (baseline facts)

- License: "SAM License", last updated Nov 19 2025. It covers checkpoints and code. It bars ITAR and military end uses, requires acknowledgement in publications, and requires the agreement to travel with redistributed Materials. It does not explicitly address commercial use. [F] [LICENSE](https://github.com/facebookresearch/sam-3d-objects/blob/main/LICENSE)
- Needs linux-64 and an NVIDIA GPU with at least 32 GB VRAM. The install uses CUDA 12.1 wheels (torch, PyTorch3D, Kaolin). [F] [setup.md](https://github.com/facebookresearch/sam-3d-objects/blob/main/doc/setup.md)
- HF checkpoint gate: the form asks for full legal name, date of birth and organization. Prat must fill it himself. [F] [HF model card](https://huggingface.co/facebook/sam-3d-objects)
- Layout: rotation, translation and a **uniform** scale, "in normalized camera coordinates" [F] ([paper](https://arxiv.org/abs/2511.16624)). The model can be conditioned on a scene pointmap from LiDAR or MoGe. `Inference.__call__` takes an optional `pointmap=` argument, and the scale is asserted to be equal on x, y and z [F] ([inference.py](https://github.com/facebookresearch/sam-3d-objects/blob/main/notebook/inference.py)). Whether a metric pointmap gives layout scale in metres is **[UNVERIFIED]**. That is experiment #1.

## 1. Ground-truth sets

| Set | What you get | Metric GT? | Size | Access | License (verbatim name) | Internal | Public demo |
|---|---|---|---|---|---|---|---|
| **Poly Haven** models | CC0 props in glTF/.blend. We render our own images, so camera is known | Yes. Submission rule: "In real-world scale" [F] | Small (count not checked) | No account | "CC0" (CC0 1.0) [F] | Yes | Yes. Don't reuse site renders or logos (ToS) |
| **Amazon Berkeley Objects** | 7,900+ glTF models with 4K textures; 91-view renders with camera params, depth and masks; **real catalog photos**; listing H/L/W | Catalog dims yes (imperial). Model units not stated [UNVERIFIED] | 3D 154 GB; renders 271 GB; listings 83 MB | Public S3, no sign-up | "Creative Commons Attribution 4.0 International Public License (CC BY 4.0)" [F] | Yes | Yes, with attribution |
| **Google Scanned Objects** | 1,030 scanned household items, textured meshes | Real scans. Units not stated in paper [UNVERIFIED]. Items up to ~50 cm | ~13 GB (press figure, [E]) | Gazebo/Ignition Fuel, goo.gle/scanned-objects | "CC-BY 4.0" [F] | Yes | Yes, with attribution |
| **Objaverse / -XL** | 10M+ objects, mixed quality | No. Scale arbitrary [O] | Huge | HF / Colab | Whole set "ODC-By v1.0". Per-object licenses vary (42 values, many blank) [F] | Yes | Only objects filtered to CC0/CC-BY |
| **Sketchfab CC-BY** | Per-model downloads | Arbitrary [O] | n/a | Account needed | Per model [UNVERIFIED] | Yes | Per model |
| **3D-FUTURE** | ~10k furniture CAD models | Yes [UNVERIFIED] | n/a | Alibaba Tianchi application (page returned 404 today) | "3D-FUTURE Data Sets Use License Agreement": "scientific research purpose only", no commercialization or "external services", no redistribution [F] | Research only | **No** |
| **Hypersim** | 461 photoreal indoor scenes, 74,619 HDR images, camera poses, depth in metres, **9-DOF boxes per object**. Meshes require a TurboSquid purchase | Yes, via `meters_per_asset_unit` [F] | ~1.9 TB, split into 1–20 GB zips (fetch per scene) | Public, no sign-up | "Creative Commons Attribution-ShareAlike 3.0 Unported License" [F] | Yes | Yes, with attribution and share-alike on derived images |
| **Structured3D** | 3.5K designer houses; photoreal pano and perspective renders; layout, depth, meshes, 3D boxes, floorplans | Likely [UNVERIFIED] | n/a | Agreement form, then review | "Structured3D Terms of Use" (Drive doc, not read) [UNVERIFIED] | After agreement | Treat as **No** until terms are read |
| **3D-FRONT** | 18,968 rooms furnished with 3D-FUTURE models | Likely | n/a | Alibaba application | Presumed same Alibaba agreement [UNVERIFIED] | Research only | **No** |
| **ARKitScenes** | 5,047 captures of 1,661 real rooms; iPhone RGB-D, Faro laser scans, oriented 3D boxes for furniture | Depth in mm, poses in m [F] | 3DOD 623 GB | Public download script | Apple license: "personal, non-commercial" grant plus a commercial clause for licensees under 700M MAU. Text says "Apple Software", not data [F] | Yes | Ambiguous. Ask Apple or skip |
| **ScanNet++** | 1000+ scenes, sub-mm laser scans, DSLR, iPhone | Yes | Large | Account, application, token | "ScanNet++ Terms of Use" (visible only after sign-up) [UNVERIFIED] | After approval | Treat as **No** |
| **HM3D** | 1,000 building-scale scans | Not stated | Large | Via Matterport | Matterport EULA, "academic, non-commercial research" [F] | Research only | **No** |
| **Matterport3D** | 90 buildings, 10,800 panoramas, meshes, poses | Not stated | Large | Signed ToS emailed to maintainers | "non-commercial academic purposes only"; bans Showcase-like interactive experiences [F] | Research only | **No** |
| CC0/CC-BY whole-building sets (e.g. 3DBAG) | LoD building models | Yes | n/a | n/a | [UNVERIFIED]: pages blocked today | n/a | Check first |

Takeaways [O]: for props, Poly Haven (CC0) plus ABO (CC BY 4.0, real catalog photos with listed H/L/W) are safe for both uses. For interiors and furniture in context, Hypersim (CC BY-SA 3.0) is the only metric, photoreal set that is safe for a public demo. For **whole buildings** no public-safe set gives exterior photos plus metric GT. Prat should take a tape measure, or use a floorplan with known dimensions, and photograph 3–5 real buildings himself.

## 2. Where SAM 3D can run

- **fal.ai** `fal-ai/sam-3/3d-objects`: **$0.02 per unit**. Outputs Gaussian splat .ply, GLB, metadata JSON (empty in the sample). Inputs: image, prompt or mask, and **optional pointmap**. Marked "Commercial use permitted". [F] [fal](https://fal.ai/models/fal-ai/sam-3/3d-objects). fal also has `sam-3/3d-align` (MoGe-based alignment, $0.02), but its output is not stated as metric [F] ([fal align](https://fal.ai/models/fal-ai/sam-3/3d-align)). Needs a fal account and payment, which only Prat can set up.
- **Nebius AI Cloud** on-demand, per GPU-hour [F] ([prices](https://www.nebius.com/prices)). The page shows a "current" column and a column "effective Oct 1, 2026". Today is after Oct 1, so assume the second column applies [E]:
  - L40S: from $1.55 (Intel) / $1.82 (AMD); no change Oct 1
  - RTX PRO 6000: $1.80
  - H100: $3.85 now, $4.50 from Oct 1
  - H200: $4.50, $5.40
  - B200: $7.15, $8.50
  - B300: $7.85, $9.50

  VRAM is not on the page. From NVIDIA specs (L40S 48 GB, RTX PRO 6000 96 GB, H100 80 GB, H200 141 GB), all qualify [UNVERIFIED today]. The repo pins CUDA 12.1 wheels, which likely won't run on Blackwell (RTX PRO 6000, B200, B300), so use **L40S or H100** [E]. Cost per run is unknown. At ~1 min per run, an L40S would be ~$0.03/run plus setup hours [E].
- **Meta Segment Anything Playground** (aidemos.meta.com): lets users "generate detailed 3D reconstructions" [F] ([Meta blog](https://ai.meta.com/blog/sam-3d/)). Download and terms are [UNVERIFIED] because the page did not render. It's good for eyeballing but not for a scored benchmark [O].
- **Roboflow**: SAM 3D Objects is listed as "Not in Playground", with no API pricing shown [F] ([Roboflow](https://playground.roboflow.com/models/meta/sam-3d-objects)).
- **HF Spaces**: 15 Spaces use the model (e.g. `fayyazio/sam3d-objects-gradio`, `HaiderCG/sam3d-lab`) [F]. Whether they work, and their quotas, are [UNVERIFIED]. Third-party Spaces are fragile for a demo [O].
- **Replicate**: no SAM 3D Objects model found (site search only) [F/partial]. Segmind and Runware list it in search results [UNVERIFIED].

## 3. Getting metric scale

Proportions (aspect ratios) are scale-invariant, so they can be scored with no metric source. Absolute size needs one of these:

1. **Reference object** (a door, an A4 sheet, a known catalog dimension): the most accurate if the reference is in plane and the user types one number. It's manual [O].
2. **MoGe-2**: "metric point maps, metric depth maps, normal maps and camera FOV". Code under **MIT**; HF weights tagged **"mit"**; 60 ms on A100 [F] ([MoGe](https://github.com/microsoft/MoGe), [weights](https://huggingface.co/Ruicheng/moge-2-vitl-normal)). It's the same family SAM 3D was trained with.
3. **Apple Depth Pro**: metric depth plus focal length with no intrinsics needed. The Apple license grant lets you "use, reproduce, modify and redistribute" with no non-commercial clause in the text I read [F] ([repo](https://github.com/apple/ml-depth-pro), [LICENSE](https://raw.githubusercontent.com/apple/ml-depth-pro/main/LICENSE)).
4. **VGGT**: single-view works "surprisingly good" but was not trained for it. Metric vs normalized is [UNVERIFIED]. Only `VGGT-1B-Commercial` allows commercial use, and it is gated behind a form [F] ([VGGT](https://github.com/facebookresearch/vggt)).
5. **Depth Anything V2 metric**: indoor variant trained on Hypersim, outdoor on Virtual KITTI. The metric checkpoints' license is not on the model card [F]. The base Small is Apache-2.0, while Base, Large and Giant are CC-BY-NC-4.0 [F] ([DA-V2](https://github.com/DepthAnything/Depth-Anything-V2)). Avoid it for the demo [O].

**Recommendation [O]:** run MoGe-2 on the photo, then pass its metric pointmap into SAM 3D (`pointmap=` locally, or the `pointmap` field on fal) and read the layout scale. Let one user-typed reference dimension override it. Report two scores: (a) **proportion error** after oracle scale (fit scale to GT longest side), which tests shape; (b) **absolute dimension error** with MoGe-2 scale, which tests metric. Compute per-axis relative error on the oriented bounding box, using GT up-axis alignment.

## 4. Cheapest credible path to a measured demo by Oct 28 [O]

1. **GT set (~100 cases, all public-safe):**
   - 30 Poly Haven props rendered in Blender at known cameras
   - 30 ABO real catalog photos with listed H/L/W
   - 25 Hypersim furniture instances (metric 9-DOF boxes)
   - 5–10 Prat-shot real props and buildings with tape-measured dims

   Credit CC BY and CC BY-SA sources in the demo.
2. **Run:** iterate on fal ($0.02 × ~300 runs ≈ $6 [E]) with MoGe-2 pointmaps. For the hackathon story, rerun the final batch self-hosted on one Nebius L40S (~$1.55/h, about a day of GPU [E]).
3. **Score and show:** a table of proportion and absolute error by category, and the best and worst cases dropped into Pascal Editor at true scale.
4. **Prat-only actions:** accept the HF gate for `facebook/sam-3d-objects`, create fal and Nebius accounts and authorize spend, and decide on the hackathon terms (not checked here).

Not verified: hackathon rules and IP terms; Structured3D, ScanNet++, 3D-FRONT and 3DBAG license texts; Meta Playground download and terms; actual SAM 3D runtime per image; whether a metric pointmap gives metric layout scale.
