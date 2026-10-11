"""Case generation from a small Pascal scene whose dimensions are computed by hand."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sam3d_bench import pascal_cases as P  # noqa: E402
from sam3d_bench.case_format import load_case  # noqa: E402
from sam3d_bench.objio import read_obj_triangles  # noqa: E402
from sam3d_bench.pngio import read_mask, write_png  # noqa: E402


def node(id_, type_, parent, **kw):
    return {"object": "node", "id": id_, "type": type_, "parentId": parent, "visible": True,
            "metadata": {}, **kw}


def scene(roof_type="gable", pitch=30.0, yaw=0.4, balcony=True) -> dict:
    """A 12 x 8 m two-storey house (wall centrelines), 0.3 m walls, 2.8 m storeys."""
    corners = [(-6, -4), (6, -4), (6, 4), (-6, 4)]
    nodes = {}
    site = node("site_a", "site", None, children=["building_a"])
    b = node("building_a", "building", "site_a", position=[50.0, 0.0, -20.0], rotation=[0, yaw, 0],
             children=["level_0", "level_1", "level_r"])
    nodes.update({"site_a": site, "building_a": b})
    for li, lid in enumerate(("level_0", "level_1")):
        kids = []
        for i in range(4):
            wid = f"wall_{li}_{i}"
            kids.append(wid)
            nodes[wid] = node(wid, "wall", lid, start=list(corners[i]), end=list(corners[(i + 1) % 4]),
                              thickness=0.3, frontSide="interior", backSide="exterior", children=[])
        slab = f"slab_{li}"
        kids.append(slab)
        nodes[slab] = node(slab, "slab", lid, polygon=[[-6.15, -4.15], [6.15, -4.15], [6.15, 4.15],
                                                       [-6.15, 4.15]], elevation=0.05, thickness=0.05,
                           plateRole="base")
        nodes[lid] = node(lid, "level", "building_a", level=li, baseElevation=0, height=2.8, children=kids)
    nodes["wall_0_0"]["children"] = ["window_a", "door_a"]
    nodes["window_a"] = node("window_a", "window", "wall_0_0", width=1.2, height=1.4)
    nodes["door_a"] = node("door_a", "door", "wall_0_0", width=0.9, height=2.1)
    if balcony:  # sticks 1.5 m out of the +z facade on the upper storey
        nodes["level_1"]["children"].append("slab_balc")
        nodes["slab_balc"] = node("slab_balc", "slab", "level_1",
                                  polygon=[[-2, 4.15], [2, 4.15], [2, 5.65], [-2, 5.65]],
                                  elevation=0.05, thickness=0.2)
    nodes["level_r"] = node("level_r", "level", "building_a", level=2, baseElevation=0, height=3.0,
                            metadata={"role": "roof"}, children=["roof_a"])
    nodes["roof_a"] = node("roof_a", "roof", "level_r", position=[0, 0, 0], rotation=0,
                           support={"kind": "level"}, children=["rseg_a"])
    nodes["rseg_a"] = node("rseg_a", "roof-segment", "roof_a", position=[0, 0, 0], rotation=0,
                           roofType=roof_type, width=12.6, depth=8.6, pitch=pitch, wallHeight=0.3,
                           wallThickness=0.16, deckThickness=0.1, overhang=0.0, shingleThickness=0.05,
                           trim={"left": 0})
    return {"nodes": nodes, "rootNodeIds": ["site_a"]}


def expected_dims(pitch=30.0):
    rad = math.radians(pitch)
    rise = 8.6 / 2 * math.tan(rad)  # gable run = depth / 2
    peak = 2 * 2.8 + 0.3 + rise + 0.1 / math.cos(rad) + 0.05 / math.cos(rad)
    # gable: x extent = width + wallThickness (no shingle overhang on the gable ends)
    width = max(12.3, 12.6 + 0.16)
    depth = 5.65 + max(4.15, 4.3 + 0.08 + 0.05 * math.sin(rad))  # balcony front, eave back
    return width, peak, depth


def test_building_dimensions_match_hand_derivation():
    sc = scene()
    gt = P.building_ground_truth(sc["nodes"], sc["nodes"]["building_a"])
    w, h, d = expected_dims()
    assert gt.dims == pytest.approx([w, h, d], abs=1e-6)
    names = {m["name"]: m for m in gt.measurements}
    assert names["storey_height"]["value_m"] == 2.8 and names["storey_height"]["count"] == 2
    assert names["footprint_length"]["value_m"] == pytest.approx(12.3)
    assert names["footprint_width"]["value_m"] == pytest.approx(8.3)
    assert names["exterior_window_1.20x1.40_height"]["value_m"] == 1.4
    assert names["exterior_door_0.90x2.10_width"]["count"] == 1


def test_object_frame_is_the_building_frame_in_world():
    sc = scene(yaw=0.4)
    gt = P.building_ground_truth(sc["nodes"], sc["nodes"]["building_a"])
    tri_o = gt.triangles_object().reshape(-1, 3)
    # Bounding box of the massing in the object frame is centred and equals the dims.
    assert np.ptp(tri_o, axis=0) == pytest.approx(gt.dims, abs=1e-6)
    assert (tri_o.max(axis=0) + tri_o.min(axis=0)) / 2 == pytest.approx([0, 0, 0], abs=1e-6)
    tri_w = gt.triangles_world().reshape(-1, 3)
    m = gt.world_from_object
    assert tri_o @ m[:3, :3].T + m[:3, 3] == pytest.approx(tri_w, abs=1e-6)


def test_mitred_walls_meet_at_outer_corner():
    walls = [{"start": [0, 0], "end": [4, 0], "thickness": 0.2},
             {"start": [4, 0], "end": [4, 3], "thickness": 0.2}]
    verts = P.wall_solids(walls, 0.0, 1.0).reshape(-1, 3)
    assert verts[:, 0].max() == pytest.approx(4.1)
    assert verts[:, 2].min() == pytest.approx(-0.1)
    assert verts[:, 0].min() == pytest.approx(0.0)  # free end stays square


@pytest.mark.parametrize("kind", ["gambrel", "mansard", "dutch"])
def test_unsupported_roofs_are_refused(kind):
    sc = scene(roof_type=kind)
    with pytest.raises(P.SceneGeometryError, match="not supported"):
        P.building_ground_truth(sc["nodes"], sc["nodes"]["building_a"])


def test_cli_writes_valid_case_with_aligned_mask(tmp_path):
    path = tmp_path / "house.json"
    path.write_text(json.dumps(scene()))
    out = tmp_path / "cases"
    code = P.main(["--scene", str(path), "--out", str(out), "--name", "house", "--size", "320x240",
                   "--views", "oblique,aerial"])
    assert code == 0
    for view in ("oblique", "aerial"):
        d = out / f"pascal-house-{view}"
        case = load_case(d)
        assert case.dims_vector == pytest.approx(expected_dims(), abs=1e-6)
        mask = read_mask(case.mask)
        assert mask.shape == (240, 320) and 500 < mask.sum() < 0.6 * mask.size
        tris = read_obj_triangles(case.gt_mesh).reshape(-1, 3)
        assert np.ptp(tris, axis=0) == pytest.approx(case.dims_vector, abs=1e-4)
        req = json.loads((d / "render-request.json").read_text())
        assert req["width"] == 320 and "cam=" in req["query"] and "fov=40" in req["query"]


def test_render_script_lists_every_case_and_parses(tmp_path):
    from sam3d_bench import render_script
    path = tmp_path / "house.json"
    path.write_text(json.dumps(scene()))
    P.main(["--scene", str(path), "--out", str(tmp_path / "cases"), "--size", "64x48"])
    script = tmp_path / "render-cases.sh"
    assert render_script.main(["--cases", str(tmp_path / "cases"), "--out", str(script)]) == 0
    text = script.read_text()
    assert text.count("\nrender pascal-") == 1
    subprocess.run(["bash", "-n", str(script)], check=True)


def test_runner_dry_run_validates_cases(tmp_path):
    sys.path.insert(0, str(ROOT / "runner"))
    import run as runner
    path = tmp_path / "house.json"
    path.write_text(json.dumps(scene()))
    cases = tmp_path / "cases"
    P.main(["--scene", str(path), "--out", str(cases), "--name", "house", "--size", "64x48",
            "--views", "oblique,aerial"])
    out = tmp_path / "runs"
    # No image yet: both cases are invalid for a run.
    assert runner.main(["--cases", str(cases), "--out", str(out), "--dry-run"]) == 1
    write_png(cases / "pascal-house-oblique" / "image.png", np.zeros((48, 64, 3), np.uint8))
    write_png(cases / "pascal-house-aerial" / "image.png", np.zeros((48, 64, 3), np.uint8))
    assert runner.main(["--cases", str(cases), "--out", str(out), "--dry-run"]) == 0
    assert runner.main(["--cases", str(cases), "--out", str(out), "--dry-run", "--only", "nope"]) == 1
