"""Wavefront OBJ triangles in and out (vertices and faces only)."""

from __future__ import annotations

from pathlib import Path

import numpy as np


def read_obj_triangles(path: str | Path) -> np.ndarray:
    """Return T x 3 x 3 triangles; polygons are fan-triangulated (OBJ faces are convex)."""
    verts: list[list[float]] = []
    tris: list[tuple[int, int, int]] = []
    for lineno, line in enumerate(Path(path).read_text().splitlines(), 1):
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v":
            verts.append([float(x) for x in parts[1:4]])
        elif parts[0] == "f":
            idx = []
            for tok in parts[1:]:
                i = int(tok.split("/")[0])
                idx.append(i - 1 if i > 0 else len(verts) + i)
            if len(idx) < 3:
                raise ValueError(f"{path}:{lineno}: face with fewer than 3 vertices")
            for k in range(1, len(idx) - 1):
                tris.append((idx[0], idx[k], idx[k + 1]))
    if not tris:
        raise ValueError(f"{path}: no faces")
    v = np.array(verts, dtype=np.float64)
    t = np.array(tris)
    if t.max() >= len(v) or t.min() < 0:
        raise ValueError(f"{path}: face index out of range")
    return v[t]


def write_obj_triangles(path: str | Path, triangles: np.ndarray, header: str = "") -> None:
    tris = np.asarray(triangles, dtype=np.float64).reshape(-1, 3, 3)
    verts, inverse = np.unique(np.round(tris.reshape(-1, 3), 6), axis=0, return_inverse=True)
    faces = inverse.reshape(-1, 3) + 1
    lines = [f"# {h}" for h in header.splitlines()] if header else []
    lines += [f"v {x:.6f} {y:.6f} {z:.6f}" for x, y, z in verts]
    lines += [f"f {a} {b} {c}" for a, b, c in faces if len({a, b, c}) == 3]
    Path(path).write_text("\n".join(lines) + "\n")
