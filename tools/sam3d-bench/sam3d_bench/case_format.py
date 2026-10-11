"""The benchmark case format (`ground-truth.json`) and its validator.

One case is one folder:

    <case_id>/
      ground-truth.json   required; this module's schema
      image.png           RGB input image (may be pending for Pascal cases until rendered)
      mask.png            target-object mask, white = object, same size as the image
      gt-mesh.obj         optional; ground-truth surface (triangles) in the object frame
      gt-points.ply       optional; ground-truth surface samples in the object frame
      render-request.json Pascal cases only; how image.png is produced

Object frame (all ground-truth dimensions use it): metres, origin at the centre of the
object's bounding box, +Y up, +X along the longer horizontal side ("width"), +Z the
shorter horizontal side ("depth"). Camera convention: OpenCV (x right, y down, z forward),
pixel centres at integer coordinates.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .pngio import png_size

SCHEMA = "sam3d-bench/case@1"
DIMENSIONS = ("width", "height", "depth")
AXIS_OF = {"width": 0, "height": 1, "depth": 2}
SOURCE_KINDS = ("pascal-scene", "external")
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


class CaseError(ValueError):
    """A case folder that does not satisfy the format. The message names every problem."""


@dataclass
class Camera:
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    world_from_camera: np.ndarray  # 4x4, OpenCV camera axes

    @property
    def K(self) -> np.ndarray:
        return np.array([[self.fx, 0.0, self.cx], [0.0, self.fy, self.cy], [0.0, 0.0, 1.0]])


@dataclass
class Measurement:
    name: str
    value_m: float
    axis: str | None  # "x" | "y" | "z" when it equals the object's bbox extent on that axis
    derivation: str
    count: int | None = None


@dataclass
class Case:
    root: Path
    case_id: str
    source: dict
    image: Path
    mask: Path
    gt_points: Path | None
    gt_mesh: Path | None
    dimensions: dict[str, float]
    world_from_object: np.ndarray | None
    measurements: list[Measurement]
    camera: Camera | None
    reference_measurement: str | None
    raw: dict = field(repr=False)

    @property
    def dims_vector(self) -> np.ndarray:
        """(width, height, depth) = extents along object (x, y, z)."""
        return np.array([self.dimensions["width"], self.dimensions["height"], self.dimensions["depth"]])

    def reference(self, name: str) -> tuple[int, float]:
        """Resolve a reference measurement to (object axis index, metres)."""
        if name in AXIS_OF:
            return AXIS_OF[name], self.dimensions[name]
        for m in self.measurements:
            if m.name == name:
                if m.axis is None:
                    raise CaseError(
                        f"{self.case_id}: measurement {name!r} has no bbox axis, so it cannot set "
                        "scale from a bounding box (part-level scoring is not implemented)"
                    )
                return "xyz".index(m.axis), m.value_m
        known = list(AXIS_OF) + [m.name for m in self.measurements if m.axis]
        raise CaseError(f"{self.case_id}: unknown reference measurement {name!r}; known: {known}")


def _pos(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def _matrix(value, name: str, errors: list[str]) -> np.ndarray | None:
    try:
        m = np.array(value, dtype=np.float64)
    except (TypeError, ValueError):
        errors.append(f"{name} must be a 4x4 number matrix")
        return None
    if m.shape != (4, 4) or not np.all(np.isfinite(m)):
        errors.append(f"{name} must be a finite 4x4 matrix, got shape {m.shape}")
        return None
    r = m[:3, :3]
    if not np.allclose(r @ r.T, np.eye(3), atol=1e-4) or abs(np.linalg.det(r) - 1) > 1e-4:
        errors.append(f"{name} rotation block is not a proper rotation")
    if not np.allclose(m[3], [0, 0, 0, 1]):
        errors.append(f"{name} last row must be [0, 0, 0, 1]")
    return m


def load_case(path: str | Path, require_image: bool = False) -> Case:
    """Load and validate a case folder (or its ground-truth.json). Raises CaseError."""
    p = Path(path)
    root = p.parent if p.name == "ground-truth.json" else p
    gt_path = root / "ground-truth.json"
    if not gt_path.is_file():
        raise CaseError(f"{root}: missing ground-truth.json")
    try:
        raw = json.loads(gt_path.read_text())
    except json.JSONDecodeError as e:
        raise CaseError(f"{gt_path}: invalid JSON ({e})") from e

    errors: list[str] = []
    if raw.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA!r}, got {raw.get('schema')!r}")
    case_id = raw.get("case_id")
    if not isinstance(case_id, str) or not _ID.match(case_id):
        errors.append(f"case_id must match {_ID.pattern}, got {case_id!r}")
    elif case_id != root.name:
        errors.append(f"case_id {case_id!r} does not match folder name {root.name!r}")

    source = raw.get("source")
    if not isinstance(source, dict):
        errors.append("source must be an object")
        source = {}
    kind = source.get("kind")
    if kind not in SOURCE_KINDS:
        errors.append(f"source.kind must be one of {SOURCE_KINDS}, got {kind!r}")
    if not isinstance(source.get("license"), str) or not source.get("license", "").strip():
        errors.append("source.license is required (the image's licence or terms of use)")
    if kind == "external":
        url = source.get("url")
        if not isinstance(url, str) or not re.match(r"^https?://", url):
            errors.append("source.url (http/https) is required for external cases")
        if not isinstance(source.get("dataset"), str):
            errors.append("source.dataset is required for external cases")
    if kind == "pascal-scene":
        for key in ("scene_path", "scene_sha256", "node_id"):
            if not isinstance(source.get(key), str):
                errors.append(f"source.{key} is required for pascal-scene cases")

    files = raw.get("files") if isinstance(raw.get("files"), dict) else {}
    if not files:
        errors.append("files must be an object with image and mask")

    def file_entry(key: str, required: bool) -> Path | None:
        rel = files.get(key)
        if rel is None:
            if required:
                errors.append(f"files.{key} is required")
            return None
        if not isinstance(rel, str) or Path(rel).is_absolute() or ".." in Path(rel).parts:
            errors.append(f"files.{key} must be a relative path inside the case folder")
            return None
        return root / rel

    image = file_entry("image", True)
    mask = file_entry("mask", True)
    gt_points = file_entry("gt_points", False)
    gt_mesh = file_entry("gt_mesh", False)
    if mask is not None and not mask.is_file():
        errors.append(f"mask file {mask.name} does not exist")
    if image is not None and require_image and not image.is_file():
        errors.append(f"image file {image.name} does not exist (render it first)")
    if gt_points is not None and not gt_points.is_file():
        errors.append(f"gt_points file {gt_points.name} does not exist")
    if gt_mesh is not None and not gt_mesh.is_file():
        errors.append(f"gt_mesh file {gt_mesh.name} does not exist")

    obj = raw.get("object") if isinstance(raw.get("object"), dict) else {}
    dims_raw = obj.get("dimensions_m") if isinstance(obj.get("dimensions_m"), dict) else {}
    dimensions = {}
    for k in DIMENSIONS:
        if _pos(dims_raw.get(k)):
            dimensions[k] = float(dims_raw[k])
        else:
            errors.append(f"object.dimensions_m.{k} must be a positive number")
    world_from_object = None
    if obj.get("world_from_object") is not None:
        world_from_object = _matrix(obj["world_from_object"], "object.world_from_object", errors)

    measurements: list[Measurement] = []
    seen: set[str] = set()
    for i, m in enumerate(obj.get("measurements") or []):
        if not isinstance(m, dict) or not isinstance(m.get("name"), str):
            errors.append(f"object.measurements[{i}] needs a name")
            continue
        if m["name"] in seen or m["name"] in DIMENSIONS:
            errors.append(f"object.measurements[{i}] name {m['name']!r} is duplicated")
        seen.add(m["name"])
        if not _pos(m.get("value_m")):
            errors.append(f"object.measurements[{i}] ({m['name']}) value_m must be positive")
            continue
        if m.get("axis") not in (None, "x", "y", "z"):
            errors.append(f"object.measurements[{i}] axis must be x, y, z or null")
            continue
        if not isinstance(m.get("derivation"), str) or not m["derivation"].strip():
            errors.append(f"object.measurements[{i}] ({m['name']}) needs a derivation")
            continue
        count = m.get("count")
        if count is not None and (not isinstance(count, int) or count < 1):
            errors.append(f"object.measurements[{i}] count must be a positive integer")
            continue
        measurements.append(
            Measurement(m["name"], float(m["value_m"]), m.get("axis"), m["derivation"], count))

    camera = None
    cam = raw.get("camera")
    if cam is not None:
        if not isinstance(cam, dict):
            errors.append("camera must be an object or null")
        else:
            if cam.get("convention") != "opencv":
                errors.append("camera.convention must be 'opencv'")
            intr = {k: cam.get(k) for k in ("width", "height", "fx", "fy", "cx", "cy")}
            bad = [k for k in ("width", "height", "fx", "fy") if not _pos(intr[k])]
            bad += [k for k in ("cx", "cy") if not isinstance(intr[k], (int, float))]
            if bad:
                errors.append(f"camera fields invalid: {bad}")
            m = _matrix(cam.get("world_from_camera"), "camera.world_from_camera", errors)
            if not bad and m is not None:
                camera = Camera(int(intr["width"]), int(intr["height"]), float(intr["fx"]),
                                float(intr["fy"]), float(intr["cx"]), float(intr["cy"]), m)

    if image is not None and mask is not None and mask.is_file() and mask.suffix.lower() == ".png":
        mw, mh = png_size(mask)
        if image.is_file() and image.suffix.lower() == ".png":
            iw, ih = png_size(image)
            if (iw, ih) != (mw, mh):
                errors.append(f"image is {iw}x{ih} but mask is {mw}x{mh}")
        if camera is not None and (camera.width, camera.height) != (mw, mh):
            errors.append(f"camera is {camera.width}x{camera.height} but mask is {mw}x{mh}")

    ref = raw.get("reference_measurement")
    if ref is not None and not isinstance(ref, str):
        errors.append("reference_measurement must be a measurement name or null")

    if errors:
        raise CaseError(f"{root}: invalid case:\n  - " + "\n  - ".join(errors))

    case = Case(root, case_id, source, image, mask, gt_points, gt_mesh, dimensions, world_from_object,
                measurements, camera, ref, raw)
    if ref is not None:
        case.reference(ref)
    return case


def find_cases(root: str | Path) -> list[Path]:
    """Case folders below `root` (any folder holding a ground-truth.json), sorted."""
    return sorted(p.parent for p in Path(root).rglob("ground-truth.json"))
