"""Score single-image reconstructions against a case's ground-truth dimensions.

Pipeline per case:
  1. Load reconstruction points (PLY vertex x/y/z; splat centres), drop low-opacity splats.
  2. Fit the object frame: with a known up axis, height is the extent along it and the plan
     axes come from the minimum-area rectangle of the horizontal projection; with `auto`,
     an oriented box is fitted and its extents are assigned to (width, height, depth) by the
     permutation that best matches the ground-truth proportions (optimistic; flagged).
  3. Align scale with one method (see SCALE_METHODS).
  4. Report bbox dimension errors, aspect-ratio errors, Chamfer distance after the bbox/PCA
     alignment (no ICP), and pass/fail at a dimension tolerance.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

from .case_format import DIMENSIONS, Case, CaseError, find_cases, load_case
from .geometry import (
    bbox,
    box_triangles,
    chamfer,
    horizontal_frame,
    isolated_mask,
    obb_frame,
    proper_signed_permutations,
    sample_triangles,
    subsample,
    yaw_quarter_turns,
)
from .objio import read_obj_triangles
from .ply import read_ply_points
from .pngio import read_mask
from .raster import project, world_to_camera

UP_CHOICES = ("auto", "+x", "-x", "+y", "-y", "+z", "-z")
SCALE_METHODS = ("reference", "oracle-height", "metric-depth", "none")
DEFAULT_TOLERANCE = 0.05


class ScoreError(RuntimeError):
    """A reconstruction that cannot be scored; the case is reported as an error, never a pass."""


# --- Reconstruction frame ---------------------------------------------------------------

@dataclass
class FittedObject:
    points_obj: np.ndarray  # N x 3 in the fitted object frame (centred, x=width, y=up, z=depth)
    dims: np.ndarray  # extents (width, height, depth) in reconstruction units
    obj_from_recon: np.ndarray  # 3x3 rotation, recon frame -> object frame
    center_recon: np.ndarray  # bbox centre in the recon frame
    assignment: str  # how axes were assigned: "up=+z" ... or "auto-matched"


def _up_vector(up: str) -> np.ndarray:
    v = np.zeros(3)
    v["xyz".index(up[1])] = 1.0 if up[0] == "+" else -1.0
    return v


def _frame_with_up(up_vec: np.ndarray) -> np.ndarray:
    """Rotation whose rows are (a, up, b) with a, b spanning the plane orthogonal to up."""
    helper = np.array([1.0, 0.0, 0.0]) if abs(up_vec[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    a = np.cross(up_vec, helper)
    a /= np.linalg.norm(a)
    b = np.cross(a, up_vec)
    return np.stack([a, up_vec, b])


def fit_object(points: np.ndarray, up: str, gt_dims: np.ndarray, trim_pct: float) -> FittedObject:
    if len(points) < 10:
        raise ScoreError(f"only {len(points)} points after filtering; need at least 10")
    if up == "auto":
        frame = obb_frame(points)
        local = points @ frame.T
        lo, hi = bbox(local, trim_pct)
        ext = hi - lo
        # Proportions only (scale-free): compare log-extents after removing their mean.
        target = np.log(gt_dims) - np.log(gt_dims).mean()
        best = None
        for perm in itertools.permutations(range(3)):
            e = np.log(np.maximum(ext[list(perm)], 1e-12))
            err = float(np.sum((e - e.mean() - target) ** 2))
            if best is None or err < best[0]:
                best = (err, perm)
        perm = best[1]
        rot = frame[list(perm)]
        if np.linalg.det(rot) < 0:
            rot[2] = -rot[2]
        assignment = "auto-matched"
    else:
        base = _frame_with_up(_up_vector(up))
        coords = points @ base.T
        lo_y, hi_y = bbox(coords[:, 1:2], trim_pct)
        plan = coords[:, [0, 2]]
        if trim_pct > 0:
            # The rectangle fit uses the same trimmed extent so floaters cannot rotate it.
            plo, phi = bbox(plan, trim_pct)
            keep = np.all((plan >= plo) & (plan <= phi), axis=1)
            plan = plan[keep]
        # hf rows are expressed in (a, up, b) coordinates; compose into the recon frame.
        rot = horizontal_frame(plan) @ base
        assignment = f"up={up}"
    local = points @ rot.T
    lo, hi = bbox(local, trim_pct)
    center_local = (lo + hi) / 2
    return FittedObject(
        points_obj=local - center_local,
        dims=hi - lo,
        obj_from_recon=rot,
        center_recon=rot.T @ center_local,
        assignment=assignment,
    )


# --- Scale alignment ----------------------------------------------------------------------

@dataclass
class ScaleResult:
    scale: float
    method: str
    detail: str
    exact_dim: str | None  # dimension that equals ground truth by construction


class ScaleProvider(Protocol):
    def __call__(self, case: Case, recon_points: np.ndarray, fitted: FittedObject) -> ScaleResult: ...


def scale_reference(name: str | None) -> ScaleProvider:
    def provider(case: Case, _pts: np.ndarray, fitted: FittedObject) -> ScaleResult:
        ref = name or case.reference_measurement
        if ref is None:
            raise ScoreError("scale method 'reference' needs --reference or the case's reference_measurement")
        try:
            axis, value = case.reference(ref)
        except CaseError as e:
            raise ScoreError(str(e)) from e
        if fitted.dims[axis] <= 0:
            raise ScoreError(f"reconstruction has zero extent on the {DIMENSIONS[axis]} axis")
        return ScaleResult(value / fitted.dims[axis], "reference",
                           f"{ref} = {value:.4g} m on the {'xyz'[axis]} axis", DIMENSIONS[axis])
    return provider


def scale_oracle_height(case: Case, _pts: np.ndarray, fitted: FittedObject) -> ScaleResult:
    if fitted.dims[1] <= 0:
        raise ScoreError("reconstruction has zero height")
    return ScaleResult(case.dimensions["height"] / fitted.dims[1], "oracle-height",
                       "ground-truth height (upper bound: uses the answer)", "height")


def scale_none(_case: Case, _pts: np.ndarray, _fitted: FittedObject) -> ScaleResult:
    return ScaleResult(1.0, "none", "reconstruction units taken as metres", None)


def scale_metric_depth(depth_path: str | Path, min_pixels: int = 50) -> ScaleProvider:
    """Hook for a metric depth estimate (any model, or the Pascal oracle depth-gt.npy).

    Needs the reconstruction in the case camera's OpenCV frame (SAM 3D's posed output, once
    its convention is confirmed). The scale is the median, over mask pixels that both the
    depth map and the projected reconstruction cover, of metric depth / reconstruction depth.
    """
    def provider(case: Case, recon_points: np.ndarray, _fitted: FittedObject) -> ScaleResult:
        if case.camera is None:
            raise ScoreError("metric-depth scale needs the case camera intrinsics")
        depth = np.load(depth_path)
        cam = case.camera
        if depth.shape != (cam.height, cam.width):
            raise ScoreError(f"depth map is {depth.shape}, camera is {cam.height}x{cam.width}")
        mask = read_mask(case.mask)
        pts = recon_points[recon_points[:, 2] > 1e-6]
        if len(pts) == 0:
            raise ScoreError("no reconstruction points in front of the camera; is the recon in camera frame?")
        uv = np.round(project(pts, cam)).astype(int)
        ok = (uv[:, 0] >= 0) & (uv[:, 0] < cam.width) & (uv[:, 1] >= 0) & (uv[:, 1] < cam.height)
        uv, z = uv[ok], pts[ok, 2]
        zbuf = np.full((cam.height, cam.width), np.inf)
        np.minimum.at(zbuf, (uv[:, 1], uv[:, 0]), z)
        use = mask & np.isfinite(zbuf) & np.isfinite(depth) & (depth > 0)
        if use.sum() < min_pixels:
            raise ScoreError(f"only {int(use.sum())} mask pixels have both depths (need {min_pixels})")
        s = float(np.median(depth[use] / zbuf[use]))
        detail = f"median depth ratio over {int(use.sum())} px from {Path(depth_path).name}"
        return ScaleResult(s, "metric-depth", detail, None)
    return provider


def recon_to_camera(points: np.ndarray, case: Case) -> np.ndarray:
    if case.camera is None:
        raise ScoreError("case has no camera")
    return world_to_camera(points, case.camera)


# --- Metrics ------------------------------------------------------------------------------

def gt_surface(case: Case, n: int, seed: int) -> tuple[np.ndarray, str]:
    if case.gt_points is not None:
        pts, _ = read_ply_points(case.gt_points)
        return subsample(pts, n, seed), "gt_points"
    if case.gt_mesh is not None:
        return sample_triangles(read_obj_triangles(case.gt_mesh), n, seed), "gt_mesh"
    return sample_triangles(box_triangles(case.dims_vector), n, seed), "bbox"


def filter_points(pts: np.ndarray, opacity: np.ndarray | None, min_opacity: float,
                  isolated_voxel_frac: float, isolated_min: int) -> tuple[np.ndarray, dict]:
    stats = {"total": int(len(pts))}
    keep = np.all(np.isfinite(pts), axis=1)
    if opacity is not None:
        keep &= opacity >= min_opacity
    stats["after_opacity"] = int(keep.sum())
    pts = pts[keep]
    if isolated_voxel_frac > 0 and len(pts) > 0:
        # Voxel size from the 1-99 percentile box so far floaters cannot inflate it.
        lo, hi = np.percentile(pts, 1, axis=0), np.percentile(pts, 99, axis=0)
        voxel = isolated_voxel_frac * float(np.linalg.norm(hi - lo))
        if voxel > 0:
            pts = pts[~isolated_mask(pts, voxel, isolated_min)]
    stats["used"] = int(len(pts))
    return pts, stats


def score_case(case: Case, recon_path: str | Path, scale: ScaleProvider, up: str = "auto",
               tolerance: float = DEFAULT_TOLERANCE, min_opacity: float = 0.5,
               trim_pct: float = 0.0, isolated_voxel_frac: float = 0.02, isolated_min: int = 5,
               chamfer_points: int = 4000, seed: int = 0) -> dict:
    raw, opacity = read_ply_points(recon_path)
    pts, counts = filter_points(raw, opacity, min_opacity, isolated_voxel_frac, isolated_min)
    gt = case.dims_vector
    fitted = fit_object(pts, up, gt, trim_pct)
    sres = scale(case, pts, fitted)
    if not (math.isfinite(sres.scale) and sres.scale > 0):
        raise ScoreError(f"scale method {sres.method} produced an invalid scale {sres.scale}")

    dims = fitted.dims * sres.scale
    dim_err = (dims - gt) / gt
    ratios = {"width/height": (0, 1), "depth/height": (2, 1), "width/depth": (0, 2)}
    aspect = {}
    for k, (a, b) in ratios.items():
        aspect[k] = float((dims[a] / dims[b]) / (gt[a] / gt[b]) - 1.0)

    gt_pts, gt_src = gt_surface(case, chamfer_points, seed)
    rec = subsample(fitted.points_obj * sres.scale, chamfer_points, seed)
    # The fitted frame is defined up to the box symmetries; keep the best-matching one.
    candidates = yaw_quarter_turns() if up != "auto" else _all_box_rotations()
    best = None
    for r in candidates:
        a_to_b, b_to_a = chamfer(rec @ r.T, gt_pts)
        sym = (a_to_b + b_to_a) / 2
        if best is None or sym < best[0]:
            best = (sym, a_to_b, b_to_a)
    diag = float(np.linalg.norm(gt))

    scored = [d for d in DIMENSIONS if d != sres.exact_dim]
    passed = bool(all(abs(dim_err[DIMENSIONS.index(d)]) <= tolerance for d in scored))
    return {
        "case_id": case.case_id,
        "status": "scored",
        "recon": str(recon_path),
        "points": counts,
        "axis_assignment": fitted.assignment,
        "scale": {"method": sres.method, "value": sres.scale, "detail": sres.detail,
                  "exact_dimension": sres.exact_dim},
        "gt_dims_m": dict(zip(DIMENSIONS, map(float, gt))),
        "recon_dims_m": dict(zip(DIMENSIONS, map(float, dims))),
        "dim_error_pct": {d: float(100 * e) for d, e in zip(DIMENSIONS, dim_err)},
        "aspect_error_pct": {k: 100 * v for k, v in aspect.items()},
        "max_abs_aspect_error_pct": float(100 * max(abs(v) for v in aspect.values())),
        "chamfer": {"mean_m": float(best[0]), "recon_to_gt_m": float(best[1]),
                    "gt_to_recon_m": float(best[2]), "pct_of_gt_diagonal": float(100 * best[0] / diag),
                    "gt_surface": gt_src, "alignment": "bbox frame + scale, no ICP"},
        "tolerance_pct": 100 * tolerance,
        "scored_dimensions": scored,
        "pass": passed,
    }


def _all_box_rotations() -> list[np.ndarray]:
    # Keep only rotations that map each axis onto itself (sign flips): the extents are fixed.
    return [m for m in proper_signed_permutations() if np.allclose(np.abs(m), np.eye(3))]


# --- Reporting ----------------------------------------------------------------------------

def summarize(results: list[dict]) -> dict:
    scored = [r for r in results if r["status"] == "scored"]
    out = {"cases": len(results), "scored": len(scored),
           "passed": sum(r["pass"] for r in scored),
           "errors": sum(r["status"] == "error" for r in results),
           "missing": sum(r["status"] == "missing" for r in results)}
    if scored:
        for d in DIMENSIONS:
            vals = [abs(r["dim_error_pct"][d]) for r in scored if d in r["scored_dimensions"]]
            if vals:
                out[f"median_abs_{d}_error_pct"] = float(np.median(vals))
        chamfers = [r["chamfer"]["pct_of_gt_diagonal"] for r in scored]
        out["median_chamfer_pct_of_diagonal"] = float(np.median(chamfers))
    return out


def markdown_table(results: list[dict], summary: dict, tolerance: float) -> str:
    lines = ["| case | scale | W err % | H err % | D err % | max aspect err % | Chamfer % diag | pass |",
             "|---|---|---:|---:|---:|---:|---:|---|"]
    for r in results:
        if r["status"] != "scored":
            lines.append(f"| {r['case_id']} | {r['status']} | | | | | | {r.get('reason', '')} |")
            continue
        cells = []
        for d in DIMENSIONS:
            v = f"{r['dim_error_pct'][d]:+.1f}"
            cells.append(v + (" (ref)" if d == r["scale"]["exact_dimension"] else ""))
        lines.append(
            f"| {r['case_id']} | {r['scale']['method']} | {' | '.join(cells)} | "
            f"{r['max_abs_aspect_error_pct']:.1f} | {r['chamfer']['pct_of_gt_diagonal']:.2f} | "
            f"{'PASS' if r['pass'] else 'FAIL'} |")
    lines.append("")
    lines.append(f"{summary['passed']}/{summary['scored']} scored cases pass "
                 f"({summary['missing']} missing, {summary['errors']} errors) at "
                 f"{100 * tolerance:g}% dimension tolerance. (ref) marks the dimension fixed "
                 "by the scale method and is not counted for pass/fail.")
    axes = sorted({r["axis_assignment"] for r in results if r["status"] == "scored"})
    if "auto-matched" in axes:
        lines.append("Axis assignment was auto-matched to ground-truth proportions: errors are optimistic.")
    return "\n".join(lines) + "\n"


def build_scale(method: str, reference: str | None, depth: str | None) -> ScaleProvider:
    if method == "reference":
        return scale_reference(reference)
    if method == "oracle-height":
        return scale_oracle_height
    if method == "none":
        return scale_none
    if method == "metric-depth":
        if depth is None:
            raise SystemExit("--scale metric-depth needs --depth <depth.npy> (metres, H x W)")
        return scale_metric_depth(depth)
    raise SystemExit(f"unknown scale method {method}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m sam3d_bench.score", description=__doc__.split("\n")[0])
    ap.add_argument("--cases", required=True, help="a case folder, or a folder of case folders")
    ap.add_argument("--recons", required=True,
                    help="folder holding <case_id>/splat.ply (runner output), or a .ply for a single case")
    ap.add_argument("--recon-name", default="splat.ply", help="file name inside each <case_id>/ folder")
    ap.add_argument("--scale", choices=SCALE_METHODS, default="oracle-height")
    ap.add_argument("--reference", help="measurement name for --scale reference (default: the case's)")
    ap.add_argument("--depth", help="metric depth .npy for --scale metric-depth (single case)")
    ap.add_argument("--up", choices=UP_CHOICES, default="auto",
                    help="reconstruction up axis; 'auto' matches axes to GT proportions (optimistic)")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE, help="fraction, default 0.05")
    ap.add_argument("--min-opacity", type=float, default=0.5)
    ap.add_argument("--trim-pct", type=float, default=0.0,
                    help="percentile trimmed per side for extents (shaves sharp features; default off)")
    ap.add_argument("--isolated-voxel", type=float, default=0.02,
                    help="isolated-splat filter voxel, as a fraction of the cloud diagonal (0 = off)")
    ap.add_argument("--isolated-min", type=int, default=5,
                    help="points needed in a splat's 3x3x3 voxel neighbourhood to keep it")
    ap.add_argument("--out", required=True, help="output folder for results.json and results.md")
    args = ap.parse_args(argv)

    cases_root = Path(args.cases)
    case_dirs = [cases_root] if (cases_root / "ground-truth.json").is_file() else find_cases(cases_root)
    if not case_dirs:
        print(f"no cases under {cases_root}", file=sys.stderr)
        return 2
    scale = build_scale(args.scale, args.reference, args.depth)
    results = []
    for d in case_dirs:
        try:
            case = load_case(d)
        except CaseError as e:
            results.append({"case_id": d.name, "status": "error", "reason": str(e).splitlines()[0]})
            print(e, file=sys.stderr)
            continue
        recon = Path(args.recons)
        if recon.is_dir():
            recon = recon / case.case_id / args.recon_name
        if not recon.is_file():
            results.append({"case_id": case.case_id, "status": "missing", "reason": f"no {recon}"})
            continue
        try:
            results.append(score_case(case, recon, scale, args.up, args.tolerance,
                                      args.min_opacity, args.trim_pct, args.isolated_voxel,
                                      args.isolated_min))
        except (ScoreError, ValueError) as e:
            results.append({"case_id": case.case_id, "status": "error", "reason": str(e)})
            print(f"{case.case_id}: {e}", file=sys.stderr)
    summary = summarize(results)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    settings = {k: v for k, v in vars(args).items() if k not in ("out",)}
    (out / "results.json").write_text(json.dumps({"settings": settings, "summary": summary,
                                                   "results": results}, indent=2) + "\n")
    (out / "results.md").write_text(markdown_table(results, summary, args.tolerance))
    print((out / "results.md").read_text())
    return 0 if summary["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
