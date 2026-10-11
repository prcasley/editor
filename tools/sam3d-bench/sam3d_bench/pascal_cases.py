"""Ground-truth cases from Pascal scene JSON (we own the scenes, so dimensions are exact).

For each building: rebuild its massing from the scene graph (storeys from base-plate
outlines and level heights, protruding slabs such as balconies, the roof from its segment
parameters with the same layer stack the viewer's roof system builds), take the bounding
box in the building's own axes, and write a case folder with:

  ground-truth.json   dimensions, measurements with derivations, camera, provenance
  mask.png            occlusion-aware target mask from the same massing (all buildings)
  gt-mesh.obj         the massing in the object frame, for Chamfer
  render-request.json how to render image.png with the Pascal headless harness

Roof geometry beyond hip / gable / shed / flat / conical, trimmed segments and wall-hosted
roofs are refused rather than approximated, so a case never carries a guessed number.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .case_format import SCHEMA, load_case
from .geometry import convex_hull_2d, min_area_rect, rot_y
from .objio import write_obj_triangles
from .pngio import write_png
from .raster import look_at_camera, rasterize

SUPPORTED_ROOFS = ("hip", "gable", "shed", "flat", "conical")
VIEWS = {
    # azimuth from the object's +Z face towards +X, elevation above the horizon (degrees)
    "oblique": (35.0, 22.0),
    "oblique-back": (215.0, 22.0),
    "aerial": (30.0, 55.0),
}


class SceneGeometryError(ValueError):
    """The scene uses geometry the generator cannot reproduce exactly."""


# --- Geometry builders -------------------------------------------------------------------

def triangulate_polygon(poly: np.ndarray) -> list[tuple[int, int, int]]:
    """Ear clipping for a simple polygon (either winding)."""
    pts = np.asarray(poly, dtype=np.float64)
    n = len(pts)
    if n < 3:
        raise SceneGeometryError("polygon with fewer than 3 points")
    area = 0.5 * np.sum(pts[:, 0] * np.roll(pts[:, 1], -1) - np.roll(pts[:, 0], -1) * pts[:, 1])
    idx = list(range(n)) if area > 0 else list(range(n))[::-1]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    tris = []
    guard = 0
    while len(idx) > 3 and guard < 10 * n:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = pts[i0], pts[i1], pts[i2]
            if cross(a, b, c) <= 1e-12:
                continue
            inside = False
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                p = pts[j]
                if cross(a, b, p) >= 0 and cross(b, c, p) >= 0 and cross(c, a, p) >= 0:
                    inside = True
                    break
            if not inside:
                tris.append((i0, i1, i2))
                idx.pop(k)
                break
        else:
            raise SceneGeometryError("polygon could not be triangulated (self-intersecting?)")
    tris.append(tuple(idx))
    return tris


def prism(poly_xz: np.ndarray, y0: float, y1: float) -> np.ndarray:
    """Closed prism over a plan polygon (x, z) between heights y0 < y1."""
    p = np.asarray(poly_xz, dtype=np.float64)
    bot = np.stack([p[:, 0], np.full(len(p), y0), p[:, 1]], axis=1)
    top = np.stack([p[:, 0], np.full(len(p), y1), p[:, 1]], axis=1)
    tris = []
    for a, b, c in triangulate_polygon(p):
        tris += [[bot[a], bot[c], bot[b]], [top[a], top[b], top[c]]]
    for i in range(len(p)):
        j = (i + 1) % len(p)
        tris += [[bot[i], bot[j], top[j]], [bot[i], top[j], top[i]]]
    return np.array(tris)


def wall_solids(walls: list[dict], y0: float, y1: float, tol: float = 1e-3) -> np.ndarray | None:
    """One prism per wall at its thickness. Where exactly two walls share an endpoint the
    ends are mitred on the angle bisector (the outer faces meet); other ends stay square."""
    if not walls:
        return None
    ends: dict[tuple, list[tuple[int, str]]] = {}
    for i, w in enumerate(walls):
        for e in ("start", "end"):
            key = tuple(np.round(np.array(w[e], float) / tol).astype(int))
            ends.setdefault(key, []).append((i, e))
    out = []
    for i, w in enumerate(walls):
        a, b = np.array(w["start"], float), np.array(w["end"], float)
        length = float(np.linalg.norm(b - a))
        if length < tol:
            continue
        u = (b - a) / length
        n = np.array([-u[1], u[0]])
        half = float(w["thickness"]) / 2
        corners = {}
        for e, p, away in (("start", a, u), ("end", b, -u)):
            key = tuple(np.round(p / tol).astype(int))
            others = [(j, f) for j, f in ends[key] if j != i]
            joint = None
            if len(others) == 1:
                j, f = others[0]
                q0, q1 = np.array(walls[j]["start"], float), np.array(walls[j]["end"], float)
                v = (q1 - q0) if f == "start" else (q0 - q1)
                v /= np.linalg.norm(v)
                bis = away + v
                if np.linalg.norm(bis) > 1e-6 and abs(np.dot(away, v)) < 0.999:
                    joint = bis / np.linalg.norm(bis)
            pts = []
            for side in (1.0, -1.0):
                base = p + side * half * n
                if joint is None:
                    pts.append(base)
                    continue
                # base + lam * away = p + mu * joint
                m = np.array([away, -joint]).T
                lam, _ = np.linalg.solve(m, p - base)
                pts.append(base + lam * away)
            corners[e] = pts
        quad = np.array([corners["start"][0], corners["end"][0], corners["end"][1], corners["start"][1]])
        out.append(prism(quad, y0, y1))
    return np.concatenate(out) if out else None


def box_solid(x0, x1, y0, y1, z0, z1) -> np.ndarray:
    return prism(np.array([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]), y0, y1)


@dataclass
class RoofSolid:
    triangles: np.ndarray  # segment frame
    peak: float
    eave_top: float
    derivation: str


def roof_segment_solid(seg: dict) -> RoofSolid:
    """Mirror of core's getSegmentSlopeFrame / getRoofSegmentVisibleTopBounds and the
    viewer roof system's deck + shingle stack, for the supported roof types."""
    kind = seg.get("roofType")
    if kind not in SUPPORTED_ROOFS:
        raise SceneGeometryError(f"roof type {kind!r} is not supported for exact ground truth")
    if any(abs(float(v)) > 1e-9 for v in (seg.get("trim") or {}).values()):
        raise SceneGeometryError("trimmed roof segments are not supported for exact ground truth")
    w, d = float(seg["width"]), float(seg["depth"])
    wall_h = float(seg.get("wallHeight", 0.0))
    wall_t = float(seg.get("wallThickness", 0.0))
    deck_t = float(seg.get("deckThickness", 0.0))
    shingle_t = float(seg.get("shingleThickness", 0.0))
    overhang = float(seg.get("overhang", 0.0))
    pitch = float(seg.get("pitch", 0.0) or 0.0)
    if kind == "flat" or not pitch > 0:
        rh, cos_t, sin_t, tan_t = 0.0, 1.0, 0.0, 0.0
    else:
        run = {"hip": min(w, d) / 2, "gable": d / 2, "shed": d, "conical": w / 2}[kind]
        rad = math.radians(pitch)
        cos_t, sin_t, tan_t = math.cos(rad), math.sin(rad), math.tan(rad)
        rh = run * tan_t
    deck_ext = wall_t / 2 + overhang * cos_t
    shingle_over = shingle_t * sin_t
    x_ext = front_ext = back_ext = deck_ext
    if kind in ("hip", "conical"):
        x_ext += shingle_over
        front_ext += shingle_over
        back_ext += shingle_over
    elif kind == "gable":
        front_ext += shingle_over
        back_ext += shingle_over
    elif kind == "shed" and rh > 0:
        front_ext += shingle_over
    min_x, max_x = -w / 2 - x_ext, w / 2 + x_ext
    min_z, max_z = -d / 2 - back_ext, d / 2 + front_ext
    # Top of the shingle layer at the peak: deck adds deck/cos vertically, shingles st/cos.
    if rh > 0:
        peak = wall_h + rh + deck_t / cos_t + shingle_t / cos_t
    else:
        peak = wall_h + deck_t + shingle_t
    derivation = (f"{kind} roof: width {w:.3f}, depth {d:.3f}, pitch {pitch:g} deg -> rise {rh:.3f} m; "
                  f"peak = wallHeight {wall_h:g} + rise + deck {deck_t:g}/cos + shingle {shingle_t:g}/cos")

    parts = []
    if wall_h > 0:
        parts.append(box_solid(-w / 2 - wall_t / 2, w / 2 + wall_t / 2, 0.0, wall_h,
                               -d / 2 - wall_t / 2, d / 2 + wall_t / 2))
    y0 = wall_h
    cx, cz = (min_x + max_x) / 2, (min_z + max_z) / 2
    corners = np.array([[min_x, y0, min_z], [max_x, y0, min_z], [max_x, y0, max_z], [min_x, y0, max_z]])
    base = [[corners[0], corners[2], corners[1]], [corners[0], corners[3], corners[2]]]
    if rh == 0:
        parts.append(box_solid(min_x, max_x, y0, peak, min_z, max_z))
    elif kind == "conical":
        n = 24
        ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
        rx, rz = (max_x - min_x) / 2, (max_z - min_z) / 2
        ring = np.stack([cx + rx * np.cos(ang), np.full(n, y0), cz + rz * np.sin(ang)], axis=1)
        apex, centre = np.array([cx, peak, cz]), np.array([cx, y0, cz])
        tris = []
        for i in range(n):
            j = (i + 1) % n
            tris += [[ring[i], ring[j], apex], [ring[j], ring[i], centre]]
        parts.append(np.array(tris))
    else:
        if kind == "hip":
            half = max(0.0, ((max_x - min_x) - (max_z - min_z)) / 2)
            if max_x - min_x >= max_z - min_z:
                r0, r1 = np.array([cx - half, peak, cz]), np.array([cx + half, peak, cz])
            else:
                r0, r1 = np.array([cx, peak, cz - half]), np.array([cx, peak, cz + half])
        elif kind == "gable":
            r0, r1 = np.array([min_x, peak, cz]), np.array([max_x, peak, cz])
        else:  # shed: high edge at the back
            r0, r1 = np.array([min_x, peak, min_z]), np.array([max_x, peak, min_z])
        c = corners
        if kind == "hip" and max_x - min_x < max_z - min_z:
            faces = [[c[0], c[1], r0], [c[1], c[2], r1], [c[1], r1, r0], [c[2], c[3], r1], [c[3], c[0], r0],
                     [c[3], r0, r1]]
        else:
            faces = [[c[0], r0, c[1]], [c[1], r0, r1], [c[1], r1, c[2]], [c[2], r1, c[3]], [c[3], r1, r0],
                     [c[3], r0, c[0]]]
        parts.append(np.array(base + faces))
    return RoofSolid(np.concatenate(parts), peak, wall_h, derivation)


# --- Scene graph -------------------------------------------------------------------------

@dataclass
class BuildingGT:
    node: dict
    triangles_b: np.ndarray  # building frame
    world_from_building: np.ndarray
    dims: np.ndarray  # width (long), height, depth
    building_from_object: np.ndarray  # 4x4
    measurements: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def world_from_object(self) -> np.ndarray:
        return self.world_from_building @ self.building_from_object

    def triangles_world(self) -> np.ndarray:
        m = self.world_from_building
        return self.triangles_b @ m[:3, :3].T + m[:3, 3]

    def triangles_object(self) -> np.ndarray:
        m = np.linalg.inv(self.building_from_object)
        return self.triangles_b @ m[:3, :3].T + m[:3, 3]


def _pose(position, yaw: float) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = rot_y(yaw)
    m[:3, 3] = position
    return m


def _yaw(node: dict) -> float:
    r = node.get("rotation", 0.0)
    if isinstance(r, (list, tuple)):
        if abs(r[0]) > 1e-9 or abs(r[2]) > 1e-9:
            raise SceneGeometryError(f"{node['id']}: only yaw rotations are supported")
        return float(r[1])
    return float(r or 0.0)


def _dist_to_outline(p: np.ndarray, outline: np.ndarray) -> float:
    best = math.inf
    for a, b in zip(outline, np.roll(outline, -1, axis=0)):
        ab = b - a
        t = 0.0 if not ab.any() else float(np.clip(np.dot(p - a, ab) / np.dot(ab, ab), 0, 1))
        best = min(best, float(np.linalg.norm(p - (a + t * ab))))
    return best


def building_ground_truth(nodes: dict, building: dict) -> BuildingGT:
    levels = sorted((nodes[c] for c in building.get("children", []) if nodes[c]["type"] == "level"),
                    key=lambda n: n.get("level", 0))
    if not levels:
        raise SceneGeometryError(f"{building['id']}: building has no levels")
    tris: list[np.ndarray] = []
    notes: list[str] = []
    measurements: list[dict] = []
    elev = 0.0
    storeys = []
    roof_info = []
    ground_outline = None
    openings: dict[tuple, int] = {}
    for lvl in levels:
        elev += float(lvl.get("baseElevation", 0.0))
        kids = [nodes[c] for c in lvl.get("children", [])]
        roofs = [k for k in kids if k["type"] == "roof"]
        walls = [k for k in kids if k["type"] == "wall"]
        base_plates = [k for k in kids if k["type"] == "slab" and k.get("plateRole") == "base"]
        if "height" not in lvl:
            raise SceneGeometryError(f"{lvl['id']}: level has no stored height")
        h = float(lvl["height"])
        is_roof_level = (lvl.get("metadata") or {}).get("role") == "roof" or (roofs and not walls)
        if not is_roof_level:
            if any(w.get("height") is not None for w in walls):
                raise SceneGeometryError(f"{lvl['id']}: explicit wall heights are not supported")
            if any(s.get("floorHeight") is not None for s in base_plates):
                raise SceneGeometryError(f"{lvl['id']}: floor-foundation lifts are not supported")
            wall_tris = wall_solids(walls, elev, elev + h)
            if wall_tris is not None:
                tris.append(wall_tris)
                if ground_outline is None:
                    ground_outline = wall_tris.reshape(-1, 3)[:, [0, 2]]
            for s in kids:
                if s["type"] == "slab":
                    top = elev + float(s.get("elevation", 0.05))
                    th = float(s.get("thickness", 0.05))
                    tris.append(prism(np.array(s["polygon"], dtype=np.float64), top - th, top))
            if walls:
                hull = convex_hull_2d(np.array([w[e] for w in walls for e in ("start", "end")], float))
            for w in walls:
                sides = {w.get("frontSide"), w.get("backSide")}
                if "exterior" in sides:
                    exterior = True
                elif sides <= {"interior"}:
                    exterior = False
                else:  # sides unknown: on the convex outline counts as exterior
                    mid = (np.array(w["start"]) + np.array(w["end"])) / 2
                    exterior = _dist_to_outline(mid, hull) <= float(w["thickness"])
                for c in w.get("children", []):
                    o = nodes[c]
                    if o["type"] in ("door", "window") and exterior:
                        key = (o["type"], round(float(o["width"]), 3), round(float(o["height"]), 3))
                        openings[key] = openings.get(key, 0) + 1
            storeys.append((lvl.get("name", lvl["id"]), h, elev))
        for r in roofs:
            if (r.get("support") or {}).get("kind", "level") != "level":
                raise SceneGeometryError(f"{r['id']}: only level-supported roofs are supported")
            rpose = _pose([r["position"][0], elev + r["position"][1], r["position"][2]], _yaw(r))
            for sid in r.get("children", []):
                seg = nodes[sid]
                solid = roof_segment_solid(seg)
                m = rpose @ _pose(seg["position"], _yaw(seg))
                tris.append(solid.triangles @ m[:3, :3].T + m[:3, 3])
                roof_info.append((solid, m[1, 3], seg))
        elev += h

    allt = np.concatenate(tris)
    verts = allt.reshape(-1, 3)
    angle, ext, centre = min_area_rect(verts[:, [0, 2]])
    y0, y1 = float(verts[:, 1].min()), float(verts[:, 1].max())
    ex = np.array([math.cos(angle), 0.0, math.sin(angle)])
    ez = np.cross(ex, [0.0, 1.0, 0.0])
    b_from_o = np.eye(4)
    b_from_o[:3, :3] = np.stack([ex, [0.0, 1.0, 0.0], ez], axis=1)
    b_from_o[:3, 3] = [centre[0], (y0 + y1) / 2, centre[1]]
    dims = np.array([ext[0], y1 - y0, ext[1]])

    if storeys:
        hs = {round(h, 4) for _, h, _ in storeys}
        if len(hs) == 1:
            measurements.append({"name": "storey_height", "value_m": storeys[0][1], "axis": None,
                                 "count": len(storeys),
                                 "derivation": f"level.height of {len(storeys)} storeys (floor to floor)"})
        top = storeys[-1][2] + storeys[-1][1]
        measurements.append({"name": "wall_top_height", "value_m": top - y0, "axis": None,
                             "derivation": "sum of storey heights: plane-bound walls reach the storey top"})
    if ground_outline is not None:
        _, fext, _ = min_area_rect(ground_outline)
        measurements.append({"name": "footprint_length", "value_m": float(fext[0]), "axis": None,
                             "derivation": "ground storey wall outer faces, long side"})
        measurements.append({"name": "footprint_width", "value_m": float(fext[1]), "axis": None,
                             "derivation": "ground storey wall outer faces, short side"})
    for solid, base_y, seg in roof_info[:1]:
        measurements.append({"name": "eave_wall_top_height", "value_m": base_y + solid.eave_top - y0,
                             "axis": None, "derivation": "roof base + roof wallHeight"})
        notes.append(solid.derivation)
    for (kind, w, h), count in sorted(openings.items()):
        for dim, val in (("width", w), ("height", h)):
            measurements.append({"name": f"exterior_{kind}_{w:.2f}x{h:.2f}_{dim}", "value_m": val,
                                 "axis": None, "count": count,
                                 "derivation": f"{kind} node {dim} on {count} exterior wall openings"})
    for i, name in enumerate(("width", "height", "depth")):
        notes.append(f"{name} {dims[i]:.3f} m is the bounding box of the massing in building axes")
    return BuildingGT(building, allt, _pose(building.get("position", [0, 0, 0]), _yaw(building)),
                      dims, b_from_o, measurements, notes)


def scene_buildings(nodes: dict) -> list[dict]:
    out = []
    for n in nodes.values():
        if n["type"] != "building":
            continue
        has_walls = any(nodes[c]["type"] == "wall" for lid in n.get("children", [])
                        if nodes[lid]["type"] == "level" for c in nodes[lid].get("children", []))
        if has_walls:
            out.append(n)
    return out


# --- Cameras, masks, files ---------------------------------------------------------------

def view_camera(gt: BuildingGT, view: str, fov: float, width: int, height: int):
    az, el = (math.radians(v) for v in VIEWS[view])
    m = gt.world_from_object
    ex, ey, ez = m[:3, 0], m[:3, 1], m[:3, 2]
    target = m[:3, 3]
    direction = math.cos(el) * (math.sin(az) * ex + math.cos(az) * ez) + math.sin(el) * ey
    radius = 0.5 * float(np.linalg.norm(gt.dims))
    half_v = math.radians(fov) / 2
    half_h = math.atan(math.tan(half_v) * width / height)
    dist = 1.08 * radius / math.sin(min(half_v, half_h))
    pos = target + dist * direction
    return look_at_camera(pos, target, fov, width, height), pos, target


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def provenance(scene: Path) -> dict:
    sha = hashlib.sha256(scene.read_bytes()).hexdigest()
    info = {"scene_sha256": sha}
    try:
        top = subprocess.run(["git", "-C", str(scene.parent), "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        head = subprocess.run(["git", "-C", str(scene.parent), "rev-parse", "HEAD"],
                              capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        info["scene_path"] = str(scene.resolve().relative_to(Path(top).resolve()))
        info["scene_commit"] = head
    except (subprocess.SubprocessError, ValueError, FileNotFoundError):
        info["scene_path"] = scene.name
    return info


class LowVisibility(SceneGeometryError):
    pass


def write_case(out_root: Path, scene_path: Path, gt: BuildingGT, others: list[BuildingGT],
               view: str, fov: float, width: int, height: int, case_id: str,
               min_visible: float = 0.0, write_depth: bool = False) -> dict:
    cam, pos, target = view_camera(gt, view, fov, width, height)
    target_tris = gt.triangles_world()
    all_tris = [target_tris] + [o.triangles_world() for o in others]
    ids = np.concatenate([np.full(len(t), i) for i, t in enumerate(all_tris)])
    depth, idmap = rasterize(np.concatenate(all_tris), ids, cam)
    mask = idmap == 0
    alone = rasterize(target_tris, np.zeros(len(target_tris), dtype=int), cam)[1] >= 0
    visible = float(mask.sum() / max(1, alone.sum()))
    if not mask.any():
        raise SceneGeometryError(f"{case_id}: target is not visible from the {view} view")
    if visible < min_visible:
        raise LowVisibility(f"{case_id}: only {visible:.0%} of the target is unoccluded")
    border = mask[0].any() or mask[-1].any() or mask[:, 0].any() or mask[:, -1].any()

    d = out_root / case_id
    d.mkdir(parents=True, exist_ok=True)
    write_png(d / "mask.png", mask.astype(np.uint8) * 255)
    write_obj_triangles(d / "gt-mesh.obj", gt.triangles_object(),
                        header=f"{case_id}: Pascal massing in the object frame (metres, +Y up)")
    if write_depth:
        np.save(d / "depth-gt.npy", np.where(mask, depth, np.inf).astype(np.float32))

    prov = provenance(scene_path)
    osm = [r for r in ((gt.node.get("provenance") or {}).get("refs") or []) if r.get("ns") == "osm"]
    licence = "Pascal scene authored by us; rendered image and dimensions are ours"
    if osm:
        licence += "; footprint derived from OpenStreetMap (ODbL 1.0, (c) OpenStreetMap contributors)"
    query = (f"scene=/@fs{scene_path.resolve()}&cam={','.join(f'{v:.3f}' for v in pos)}"
             f"&target={','.join(f'{v:.3f}' for v in target)}&fov={fov:g}")
    request = {
        "renderer": "Pascal headless harness (render.mjs: Playwright + SwiftShader WebGL)",
        "query": query,
        "width": width,
        "height": height,
        "out": "image.png",
        "camera_note": "three.js PerspectiveCamera, vertical fov, lookAt(target), up +Y; "
                       "ground-truth.json camera is the same camera in OpenCV form",
    }
    (d / "render-request.json").write_text(json.dumps(request, indent=2) + "\n")
    gtj = {
        "schema": SCHEMA,
        "case_id": case_id,
        "source": {
            "kind": "pascal-scene",
            **prov,
            "node_id": gt.node["id"],
            "node_name": gt.node.get("name"),
            "osm_refs": [r["id"] for r in osm],
            "license": licence,
            "view": view,
        },
        "files": {"image": "image.png", "mask": "mask.png", "gt_mesh": "gt-mesh.obj"},
        "object": {
            "frame": "metres; origin at bbox centre; +Y up; +X long horizontal side; +Z short side",
            "dimensions_m": {"width": float(gt.dims[0]), "height": float(gt.dims[1]), "depth": float(gt.dims[2])},
            "world_from_object": gt.world_from_object.round(6).tolist(),
            "measurements": gt.measurements,
            "notes": gt.notes,
        },
        "camera": {
            "convention": "opencv",
            "width": width, "height": height,
            "fx": cam.fx, "fy": cam.fy, "cx": cam.cx, "cy": cam.cy,
            "fov_y_deg": fov,
            "world_from_camera": cam.world_from_camera.round(6).tolist(),
        },
        "mask_stats": {"pixels": int(mask.sum()), "visible_fraction": round(visible, 4),
                       "touches_border": bool(border),
                       "method": "z-buffer of every building's massing; roofs as solid hip/gable/flat"},
        "reference_measurement": "width",
    }
    (d / "ground-truth.json").write_text(json.dumps(gtj, indent=2) + "\n")
    load_case(d)  # the written case must validate
    return {"case_id": case_id, "visible_fraction": visible, "touches_border": bool(border),
            "dims": gt.dims.round(3).tolist()}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m sam3d_bench.pascal_cases", description=__doc__.split("\n")[0])
    ap.add_argument("--scene", required=True, type=Path, help="Pascal scene JSON ({nodes, rootNodeIds})")
    ap.add_argument("--building", action="append", help="building id or name (repeatable; default: all)")
    ap.add_argument("--views", default="oblique", help=f"comma list of {sorted(VIEWS)}")
    ap.add_argument("--size", default="1024x768", help="image WxH")
    ap.add_argument("--fov", type=float, default=40.0, help="vertical field of view, degrees")
    ap.add_argument("--min-visible", type=float, default=0.6,
                    help="skip views where less than this fraction of the target is unoccluded")
    ap.add_argument("--name", help="scene slug for case ids (default: <folder>-<file>)")
    ap.add_argument("--write-depth", action="store_true", help="also write depth-gt.npy (metric, masked)")
    ap.add_argument("--out", required=True, type=Path, help="cases root folder")
    args = ap.parse_args(argv)

    width, height = (int(v) for v in args.size.lower().split("x"))
    views = [v.strip() for v in args.views.split(",") if v.strip()]
    for v in views:
        if v not in VIEWS:
            raise SystemExit(f"unknown view {v!r}; choose from {sorted(VIEWS)}")
    graph = json.loads(args.scene.read_text())
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        raise SystemExit(f"{args.scene}: not a Pascal scene (no nodes object)")
    buildings = scene_buildings(nodes)
    if args.building:
        wanted = set(args.building)
        buildings = [b for b in buildings if b["id"] in wanted or b.get("name") in wanted]
        missing = wanted - {b["id"] for b in buildings} - {b.get("name") for b in buildings}
        if missing:
            raise SystemExit(f"buildings not found: {sorted(missing)}")
    gts, failures = [], []
    for b in scene_buildings(nodes):
        try:
            gts.append(building_ground_truth(nodes, b))
        except SceneGeometryError as e:
            failures.append((b, str(e)))
    selected = {b["id"] for b in buildings}
    scene_slug = args.name or slug(f"{args.scene.parent.name}-{args.scene.stem}")
    report = []
    for b, err in failures:
        if b["id"] in selected:
            print(f"SKIP {b.get('name', b['id'])}: {err}", file=sys.stderr)
    for gt in gts:
        if gt.node["id"] not in selected:
            continue
        others = [o for o in gts if o is not gt]
        bslug = "" if len(gts) == 1 else "-" + slug(gt.node.get("name") or gt.node["id"])
        for view in views:
            case_id = f"pascal-{scene_slug}{bslug}-{view}"
            try:
                r = write_case(args.out, args.scene, gt, others, view, args.fov, width, height,
                               case_id, args.min_visible, args.write_depth)
            except SceneGeometryError as e:
                print(f"SKIP {e}", file=sys.stderr)
                continue
            report.append(r)
            print(f"{case_id}: dims {r['dims']} m, visible {r['visible_fraction']:.0%}"
                  + (", touches border" if r["touches_border"] else ""))
    return 0 if report else 1


if __name__ == "__main__":
    sys.exit(main())
