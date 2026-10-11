"""Minimal PLY reader/writer (numpy only).

Reads the `vertex` element of ascii, binary_little_endian and binary_big_endian files,
which covers Gaussian-splat exports (x, y, z, opacity, scale_*, rot_*, f_dc_*) and plain
point clouds. Elements before `vertex` are skipped when their size is computable.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

_TYPES = {
    "char": "i1", "int8": "i1",
    "uchar": "u1", "uint8": "u1",
    "short": "i2", "int16": "i2",
    "ushort": "u2", "uint16": "u2",
    "int": "i4", "int32": "i4",
    "uint": "u4", "uint32": "u4",
    "float": "f4", "float32": "f4",
    "double": "f8", "float64": "f8",
}


class PlyError(ValueError):
    pass


def _parse_header(raw: bytes) -> tuple[str, list[dict], int]:
    end = raw.find(b"end_header")
    if not raw.startswith(b"ply") or end < 0:
        raise PlyError("not a PLY file (missing 'ply' magic or 'end_header')")
    nl = raw.find(b"\n", end)
    if nl < 0:
        raise PlyError("truncated PLY header")
    lines = raw[:end].decode("ascii", errors="replace").splitlines()
    fmt = None
    elements: list[dict] = []
    for line in lines[1:]:
        parts = line.split()
        if not parts or parts[0] in ("comment", "obj_info"):
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "element":
            elements.append({"name": parts[1], "count": int(parts[2]), "props": []})
        elif parts[0] == "property":
            if not elements:
                raise PlyError("property before any element")
            if parts[1] == "list":
                elements[-1]["props"].append(("list", parts[2], parts[3], parts[4]))
            else:
                if parts[1] not in _TYPES:
                    raise PlyError(f"unsupported property type {parts[1]!r}")
                elements[-1]["props"].append(("scalar", parts[1], parts[2]))
    if fmt not in ("ascii", "binary_little_endian", "binary_big_endian"):
        raise PlyError(f"unsupported PLY format {fmt!r}")
    return fmt, elements, nl + 1


def read_ply_vertices(path: str | Path) -> dict[str, np.ndarray]:
    """Return {property name: 1-D array} for the `vertex` element."""
    raw = Path(path).read_bytes()
    fmt, elements, offset = _parse_header(raw)
    names = [e["name"] for e in elements]
    if "vertex" not in names:
        raise PlyError(f"{path}: no 'vertex' element (elements: {names})")

    if fmt == "ascii":
        rows = raw[offset:].decode("ascii").split("\n")
        cursor = 0
        for el in elements:
            if el["name"] == "vertex":
                if any(p[0] == "list" for p in el["props"]):
                    raise PlyError("list properties on vertex are not supported")
                lines = rows[cursor:cursor + el["count"]]
                data = np.array([[float(v) for v in r.split()] for r in lines], dtype=np.float64)
                if data.shape != (el["count"], len(el["props"])):
                    raise PlyError(f"{path}: vertex data shape {data.shape} does not match header")
                return {p[2]: data[:, i] for i, p in enumerate(el["props"])}
            if any(p[0] == "list" for p in el["props"]):
                raise PlyError("cannot skip a list-bearing element before 'vertex' in ascii")
            cursor += el["count"]

    endian = "<" if fmt == "binary_little_endian" else ">"
    for el in elements:
        if any(p[0] == "list" for p in el["props"]):
            if el["name"] == "vertex":
                raise PlyError("list properties on vertex are not supported")
            raise PlyError(f"cannot skip list-bearing element {el['name']!r} before 'vertex'")
        dtype = np.dtype([(p[2], endian + _TYPES[p[1]]) for p in el["props"]])
        size = dtype.itemsize * el["count"]
        if el["name"] == "vertex":
            if offset + size > len(raw):
                raise PlyError(f"{path}: truncated vertex data")
            arr = np.frombuffer(raw, dtype=dtype, count=el["count"], offset=offset)
            return {name: arr[name].astype(np.float64) for name in dtype.names}
        offset += size
    raise PlyError("unreachable")


def read_ply_points(path: str | Path) -> tuple[np.ndarray, np.ndarray | None]:
    """Return (N x 3 xyz, opacity in [0, 1] or None).

    3D Gaussian Splatting PLYs (recognised by their scale_*/rot_* properties) store opacity
    as a logit, which is passed through a sigmoid; other files must store it in [0, 1].
    """
    v = read_ply_vertices(path)
    for axis in ("x", "y", "z"):
        if axis not in v:
            raise PlyError(f"{path}: vertex element lacks '{axis}'")
    xyz = np.stack([v["x"], v["y"], v["z"]], axis=1)
    opacity = v.get("opacity")
    if opacity is not None:
        if "scale_0" in v or "rot_0" in v:
            opacity = 1.0 / (1.0 + np.exp(-opacity))
        elif opacity.min() < 0.0 or opacity.max() > 1.0:
            raise PlyError(f"{path}: opacity outside [0, 1] in a non-3DGS PLY")
    return xyz, opacity


def write_ply_points(path: str | Path, points: np.ndarray) -> None:
    pts = np.ascontiguousarray(points, dtype="<f4")
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise PlyError(f"points must be N x 3, got {pts.shape}")
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(pts)}\n"
        "property float x\nproperty float y\nproperty float z\nend_header\n"
    )
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(pts.tobytes())
