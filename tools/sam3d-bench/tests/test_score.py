"""Scorer behaviour on synthetic boxes with known size, rotated, scaled, noised and distorted."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sam3d_bench import score as S  # noqa: E402
from sam3d_bench.case_format import CaseError, load_case  # noqa: E402
from sam3d_bench.geometry import box_triangles, rot_y, sample_triangles  # noqa: E402
from sam3d_bench.ply import read_ply_points, read_ply_vertices, write_ply_points  # noqa: E402
from sam3d_bench.pngio import write_png  # noqa: E402
from sam3d_bench.raster import look_at_camera, rasterize, world_to_camera  # noqa: E402

GT = (12.0, 7.5, 4.0)  # width, height, depth


def random_rotation(seed: int) -> np.ndarray:
    q, r = np.linalg.qr(np.random.default_rng(seed).normal(size=(3, 3)))
    q = q * np.sign(np.diag(r))
    return q if np.linalg.det(q) > 0 else -q


def make_case(root: Path, case_id: str = "box", dims=GT, camera: dict | None = None,
              mask: np.ndarray | None = None, **overrides) -> Path:
    d = root / case_id
    d.mkdir(parents=True)
    m = mask if mask is not None else np.zeros((8, 8), dtype=np.uint8)
    write_png(d / "mask.png", m)
    gt = {
        "schema": "sam3d-bench/case@1",
        "case_id": case_id,
        "source": {"kind": "external", "dataset": "synthetic", "url": "https://example.org/box",
                   "license": "CC0-1.0"},
        "files": {"image": "image.png", "mask": "mask.png"},
        "object": {"dimensions_m": dict(zip(("width", "height", "depth"), dims)),
                   "measurements": [{"name": "door_height", "value_m": 2.1, "axis": None,
                                     "derivation": "synthetic"}]},
        "camera": camera,
        "reference_measurement": "width",
    }
    for k, v in overrides.items():
        gt[k] = v
    (d / "ground-truth.json").write_text(json.dumps(gt))
    return d


def box_points(dims=GT, n=20000, seed=0) -> np.ndarray:
    return sample_triangles(box_triangles(dims), n, seed)


def write_splat(path: Path, xyz: np.ndarray, opacity_logit: np.ndarray) -> None:
    """A 3DGS-layout PLY (subset of properties) like SAM 3D's save_ply."""
    names = ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    arr = np.zeros(len(xyz), dtype=[(n, "<f4") for n in names])
    arr["x"], arr["y"], arr["z"] = xyz.T
    arr["opacity"] = opacity_logit
    arr["rot_0"] = 1.0
    header = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {len(xyz)}\n"
    header += "".join(f"property float {n}\n" for n in names) + "end_header\n"
    path.write_bytes(header.encode() + arr.tobytes())


def score(case_dir: Path, recon: Path, method: str = "oracle-height", up: str = "auto", **kw) -> dict:
    case = load_case(case_dir)
    provider = kw.pop("provider", None) or S.build_scale(method, kw.pop("reference", None), None)
    return S.score_case(case, recon, provider, up=up, **kw)


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_oracle_height_recovers_rotated_scaled_noised_box(tmp_path, seed):
    case = make_case(tmp_path)
    rng = np.random.default_rng(seed)
    pts = box_points(seed=seed) @ random_rotation(seed).T * 0.37 + [3.0, -1.0, 8.0]
    pts += rng.normal(scale=0.002, size=pts.shape)  # ~0.5 cm at true scale
    write_ply_points(tmp_path / "r.ply", pts)
    r = score(case, tmp_path / "r.ply")
    assert r["axis_assignment"] == "auto-matched"
    for d in ("width", "height", "depth"):
        assert abs(r["dim_error_pct"][d]) < 1.0, (d, r["dim_error_pct"])
    assert r["max_abs_aspect_error_pct"] < 1.0
    assert r["chamfer"]["pct_of_gt_diagonal"] < 1.0
    assert r["scale"]["exact_dimension"] == "height"
    assert r["pass"] is True


def test_known_up_axis_measures_height_along_it(tmp_path):
    case = make_case(tmp_path)
    # Object y (up) -> recon +z, with an arbitrary yaw about that up axis.
    y_to_z = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])
    pts = box_points() @ (y_to_z @ rot_y(0.7)).T * 2.0
    write_ply_points(tmp_path / "r.ply", pts)
    r = score(case, tmp_path / "r.ply", up="+z")
    assert r["axis_assignment"] == "up=+z"
    assert abs(r["scale"]["value"] - 0.5) < 1e-3
    for d in ("width", "height", "depth"):
        assert abs(r["dim_error_pct"][d]) < 0.5


def test_wrong_up_axis_fails_honestly(tmp_path):
    case = make_case(tmp_path)
    write_ply_points(tmp_path / "r.ply", box_points() @ rot_y(0.3).T)  # up is +y
    r = score(case, tmp_path / "r.ply", up="+x")
    assert r["pass"] is False


def test_reference_scale_exposes_squashed_height(tmp_path):
    case = make_case(tmp_path)
    squash = np.diag([1.0, 0.9, 1.0])  # the model got the height 10 % short
    pts = (box_points() @ squash.T) @ random_rotation(7).T * 3.0
    write_ply_points(tmp_path / "r.ply", pts)
    r = score(case, tmp_path / "r.ply", method="reference")  # case reference = width
    assert r["scale"]["exact_dimension"] == "width"
    assert abs(r["dim_error_pct"]["width"]) < 1e-6
    assert r["dim_error_pct"]["height"] == pytest.approx(-10.0, abs=0.5)
    assert abs(r["dim_error_pct"]["depth"]) < 0.5
    assert r["aspect_error_pct"]["width/height"] == pytest.approx(100 * (1 / 0.9 - 1), abs=0.5)
    assert r["scored_dimensions"] == ["height", "depth"]
    assert r["pass"] is False


def test_tolerance_boundary(tmp_path):
    case = make_case(tmp_path)
    pts = box_points() @ np.diag([1.04, 1.0, 1.0]).T  # width 4 % long
    write_ply_points(tmp_path / "r.ply", pts)
    assert score(case, tmp_path / "r.ply", up="+y")["pass"] is True
    assert score(case, tmp_path / "r.ply", up="+y", tolerance=0.03)["pass"] is False


def test_no_scale_reports_native_units(tmp_path):
    case = make_case(tmp_path)
    write_ply_points(tmp_path / "r.ply", box_points() * 2.0)
    r = score(case, tmp_path / "r.ply", method="none", up="+y")
    assert r["dim_error_pct"]["height"] == pytest.approx(100.0, abs=0.5)
    assert r["scale"]["exact_dimension"] is None
    assert r["pass"] is False


def test_reference_without_bbox_axis_is_an_error(tmp_path):
    case = make_case(tmp_path)
    write_ply_points(tmp_path / "r.ply", box_points())
    with pytest.raises(S.ScoreError, match="no bbox axis"):
        score(case, tmp_path / "r.ply", method="reference", reference="door_height")


def test_low_opacity_floaters_are_dropped(tmp_path):
    case = make_case(tmp_path)
    rng = np.random.default_rng(4)
    body = box_points(n=8000)
    floaters = rng.uniform(-40, 40, size=(400, 3))
    xyz = np.concatenate([body, floaters])
    logits = np.concatenate([np.full(len(body), 4.0), np.full(len(floaters), -4.0)])
    write_splat(tmp_path / "s.ply", xyz, logits)
    _, opacity = read_ply_points(tmp_path / "s.ply")
    assert opacity.min() > 0 and opacity.max() < 1  # logits went through a sigmoid
    r = score(case, tmp_path / "s.ply", up="+y")
    assert r["points"]["after_opacity"] == len(body)
    assert r["pass"] is True


def test_isolated_opaque_floaters_do_not_inflate_the_box(tmp_path):
    case = make_case(tmp_path)
    rng = np.random.default_rng(5)
    body = box_points(n=20000)
    floaters = rng.uniform(-30, 30, size=(40, 3))
    floaters[:, 1] += 40.0  # well above the object, as stray splats often are
    pts = np.concatenate([body, floaters])
    write_ply_points(tmp_path / "r.ply", pts)
    r = score(case, tmp_path / "r.ply", method="reference", up="+y")
    assert r["points"]["used"] == len(body)
    assert abs(r["dim_error_pct"]["height"]) < 0.5
    unfiltered = score(case, tmp_path / "r.ply", method="reference", up="+y", isolated_voxel_frac=0)
    assert unfiltered["pass"] is False


def test_chamfer_separates_wrong_shape_with_same_box(tmp_path):
    case = make_case(tmp_path)
    write_ply_points(tmp_path / "good.ply", box_points())
    # A pyramid with exactly the same bounding box: dimensions pass, shape does not.
    w, h, d = GT[0] / 2, GT[1] / 2, GT[2] / 2
    base = [[-w, -h, -d], [w, -h, -d], [w, -h, d], [-w, -h, d]]
    apex = [0.0, h, 0.0]
    tris = [[base[0], base[1], base[2]], [base[0], base[2], base[3]]]
    tris += [[base[i], base[(i + 1) % 4], apex] for i in range(4)]
    write_ply_points(tmp_path / "bad.ply", sample_triangles(np.array(tris), 20000))
    good_c = score(case, tmp_path / "good.ply", up="+y")["chamfer"]["mean_m"]
    bad = score(case, tmp_path / "bad.ply", up="+y")
    assert bad["pass"] is True
    bad_c = bad["chamfer"]["mean_m"]
    # 4000 samples on 336 m2 of surface sit ~0.29 m apart: the sampling floor is ~0.15 m.
    assert good_c < 0.2
    assert bad_c > 5 * good_c


def test_chamfer_uses_gt_mesh_when_present(tmp_path):
    from sam3d_bench.objio import write_obj_triangles
    case = make_case(tmp_path, files={"image": "image.png", "mask": "mask.png", "gt_mesh": "gt-mesh.obj"})
    write_obj_triangles(case / "gt-mesh.obj", box_triangles(GT))
    write_ply_points(tmp_path / "r.ply", box_points())
    assert score(case, tmp_path / "r.ply", up="+y")["chamfer"]["gt_surface"] == "gt_mesh"


def test_metric_depth_hook_recovers_scale(tmp_path):
    w, h = 160, 120
    cam = look_at_camera([20.0, 9.0, 25.0], [0.0, 0.0, 0.0], 45.0, w, h)
    tris = box_triangles(GT)
    depth, ids = rasterize(tris, np.arange(len(tris)), cam)
    mask = (ids >= 0).astype(np.uint8) * 255
    camera = {"convention": "opencv", "width": w, "height": h, "fx": cam.fx, "fy": cam.fy,
              "cx": cam.cx, "cy": cam.cy, "world_from_camera": cam.world_from_camera.tolist()}
    case = make_case(tmp_path, camera=camera, mask=mask)
    np.save(tmp_path / "depth.npy", depth)
    # A posed reconstruction in the camera frame at 1/3 of metric scale.
    recon_cam = world_to_camera(box_points(n=60000), cam) / 3.0
    write_ply_points(tmp_path / "r.ply", recon_cam)
    r = score(case, tmp_path / "r.ply", provider=S.scale_metric_depth(tmp_path / "depth.npy"))
    assert r["scale"]["value"] == pytest.approx(3.0, rel=0.02)
    assert r["pass"] is True


def test_cli_writes_results_and_reports_missing(tmp_path):
    cases = tmp_path / "cases"
    make_case(cases, "a")
    make_case(cases, "b")
    recons = tmp_path / "runs"
    (recons / "a").mkdir(parents=True)
    write_ply_points(recons / "a" / "splat.ply", box_points() * 0.1)
    out = tmp_path / "out"
    code = S.main(["--cases", str(cases), "--recons", str(recons), "--out", str(out), "--up", "+y"])
    assert code == 0
    data = json.loads((out / "results.json").read_text())
    status = {r["case_id"]: r["status"] for r in data["results"]}
    assert status == {"a": "scored", "b": "missing"}
    assert data["summary"]["passed"] == 1 and data["summary"]["missing"] == 1
    md = (out / "results.md").read_text()
    assert "| a | oracle-height |" in md and "| b | missing |" in md


def test_case_validation_names_every_problem(tmp_path):
    d = make_case(tmp_path, source={"kind": "external", "dataset": "x"},
                  object={"dimensions_m": {"width": 1, "height": -2}})
    with pytest.raises(CaseError) as e:
        load_case(d)
    msg = str(e.value)
    assert "source.license" in msg and "source.url" in msg
    assert "height must be a positive number" in msg and "depth must be a positive number" in msg


def test_case_validation_rejects_path_escape(tmp_path):
    d = make_case(tmp_path, files={"image": "../x.png", "mask": "mask.png"})
    with pytest.raises(CaseError, match="relative path inside"):
        load_case(d)


def test_ply_reader_formats(tmp_path):
    pts = np.array([[0.5, 1.5, -2.0], [3.0, 4.0, 5.0]])
    (tmp_path / "a.ply").write_text(
        "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\n"
        "property float z\nend_header\n0.5 1.5 -2\n3 4 5\n")
    be = pts.astype(">f8")
    (tmp_path / "b.ply").write_bytes(
        b"ply\nformat binary_big_endian 1.0\ncomment x\nelement vertex 2\nproperty double x\n"
        b"property double y\nproperty double z\nend_header\n" + be.tobytes())
    for f in ("a.ply", "b.ply"):
        v = read_ply_vertices(tmp_path / f)
        assert np.allclose(np.stack([v["x"], v["y"], v["z"]], 1), pts)
