"""Geometry primitives shared by the case generator and the scorer (numpy only)."""

from __future__ import annotations

import itertools

import numpy as np


def rot_y(angle: float) -> np.ndarray:
    """Rotation about +Y with three.js semantics (Object3D.rotation.y)."""
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def convex_hull_2d(points: np.ndarray) -> np.ndarray:
    """Andrew's monotone chain; returns hull vertices counter-clockwise."""
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) > 64:
        # Akl-Toussaint: drop points strictly inside the octagon of extreme points so the
        # Python loop below only sees hull candidates.
        dirs = np.array([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]])
        oct_ = pts[np.argmax(pts @ dirs.T, axis=0)]
        inside = np.ones(len(pts), dtype=bool)
        for a, b in zip(oct_, np.roll(oct_, -1, axis=0)):
            if np.allclose(a, b):
                continue
            cross = (b[0] - a[0]) * (pts[:, 1] - a[1]) - (b[1] - a[1]) * (pts[:, 0] - a[0])
            inside &= cross > 1e-12
        pts = pts[~inside]
    pts = np.unique(pts, axis=0)
    if len(pts) < 3:
        return pts
    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

    def half(seq: np.ndarray) -> list:
        out: list = []
        for p in seq:
            while len(out) >= 2:
                o, a = out[-2], out[-1]
                if (a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0]) > 0:
                    break
                out.pop()
            out.append(p)
        return out

    lower = half(pts)
    upper = half(pts[::-1])
    return np.array(lower[:-1] + upper[:-1])


def min_area_rect(points: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Minimum-area enclosing rectangle of 2-D points (rotating-calipers edge search).

    Returns (angle, extents, center): rotating the points by -angle makes the rectangle
    axis-aligned with side lengths `extents` (longer first) around `center` (input frame).
    """
    hull = convex_hull_2d(points)
    if len(hull) < 3:
        raise ValueError("min_area_rect needs at least 3 non-collinear points")
    edges = np.roll(hull, -1, axis=0) - hull
    angles = np.unique(np.mod(np.arctan2(edges[:, 1], edges[:, 0]), np.pi / 2))
    best = None
    for a in angles:
        c, s = np.cos(-a), np.sin(-a)
        r = hull @ np.array([[c, s], [-s, c]])
        lo, hi = r.min(axis=0), r.max(axis=0)
        area = float(np.prod(hi - lo))
        if best is None or area < best[0] - 1e-12:
            best = (area, a, lo, hi)
    _, a, lo, hi = best
    ext = hi - lo
    mid = (lo + hi) / 2
    c, s = np.cos(a), np.sin(a)
    center = np.array([[c, -s], [s, c]]) @ mid
    if ext[1] > ext[0]:
        a += np.pi / 2
        ext = ext[::-1]
    return float(a), ext, center


def horizontal_frame(points_xz: np.ndarray) -> np.ndarray:
    """3x3 rotation whose rows are the object x (long side), y (up), z axes in world coords,
    from the minimum-area rectangle of the plan (x, z) projection."""
    a, _, _ = min_area_rect(points_xz)
    # a is measured in the (x, z) plane; the long side direction in world is (cos a, 0, sin a).
    x_axis = np.array([np.cos(a), 0.0, np.sin(a)])
    y_axis = np.array([0.0, 1.0, 0.0])
    z_axis = np.cross(x_axis, y_axis)
    return np.stack([x_axis, y_axis, z_axis])


def obb_frame(points: np.ndarray, max_points: int = 20000) -> np.ndarray:
    """Approximate minimum-volume oriented box: for each PCA axis, fit the minimum-area
    rectangle in the perpendicular plane and keep the smallest-volume box.

    Returns a 3x3 proper rotation whose rows are the box axes in the input frame. Robust
    when two principal variances coincide (square footprints), where plain PCA is not.
    """
    # The frame is fitted on at most `max_points` samples (the hull search is the cost);
    # callers measure extents on the full cloud.
    pts = subsample(np.asarray(points, dtype=np.float64), max_points)
    centred = pts - pts.mean(axis=0)
    _, vecs = np.linalg.eigh(np.cov(centred.T))
    axes = vecs.T
    best = None
    # A PCA axis is only approximately a box axis; re-fitting around the best box's own
    # axes converges to the exact faces of box-like shapes in a couple of passes.
    for _ in range(3):
        for n in axes:
            u = np.cross(n, [1.0, 0.0, 0.0])
            if np.linalg.norm(u) < 1e-6:
                u = np.cross(n, [0.0, 1.0, 0.0])
            u /= np.linalg.norm(u)
            v = np.cross(n, u)
            proj = np.stack([centred @ u, centred @ v], axis=1)
            a, _, _ = min_area_rect(proj)
            e1 = np.cos(a) * u + np.sin(a) * v
            frame = np.stack([e1, np.cross(n, e1), n])
            local = centred @ frame.T
            vol = float(np.prod(local.max(axis=0) - local.min(axis=0)))
            if best is None or vol < best[0] - 1e-12:
                best = (vol, frame)
        axes = best[1]
    return best[1]


def proper_signed_permutations() -> list[np.ndarray]:
    """The 24 rotations that map coordinate axes onto coordinate axes."""
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1.0, -1.0), repeat=3):
            m = np.zeros((3, 3))
            for row, (col, sg) in enumerate(zip(perm, signs)):
                m[row, col] = sg
            if np.linalg.det(m) > 0:
                out.append(m)
    return out


def yaw_quarter_turns() -> list[np.ndarray]:
    return [rot_y(k * np.pi / 2) for k in range(4)]


def bbox(points: np.ndarray, trim_pct: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    if trim_pct > 0:
        lo = np.percentile(points, trim_pct, axis=0)
        hi = np.percentile(points, 100.0 - trim_pct, axis=0)
    else:
        lo, hi = points.min(axis=0), points.max(axis=0)
    return lo, hi


def subsample(points: np.ndarray, n: int, seed: int = 0) -> np.ndarray:
    if len(points) <= n:
        return points
    idx = np.random.default_rng(seed).choice(len(points), size=n, replace=False)
    return points[idx]


def nearest_distances(src: np.ndarray, dst: np.ndarray, chunk: int = 1024) -> np.ndarray:
    """For each src point, the Euclidean distance to its nearest dst point (brute force)."""
    out = np.empty(len(src))
    d2n = np.einsum("ij,ij->i", dst, dst)
    for i in range(0, len(src), chunk):
        s = src[i:i + chunk]
        d2 = np.einsum("ij,ij->i", s, s)[:, None] - 2.0 * s @ dst.T + d2n[None, :]
        out[i:i + chunk] = np.sqrt(np.maximum(d2.min(axis=1), 0.0))
    return out


def chamfer(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """(mean a->b, mean b->a) nearest-neighbour distances."""
    return float(nearest_distances(a, b).mean()), float(nearest_distances(b, a).mean())


def box_triangles(extents) -> np.ndarray:
    """12 triangles of an axis-aligned box centred at the origin."""
    hx, hy, hz = np.asarray(extents, dtype=np.float64) / 2
    v = np.array([[x, y, z] for x in (-hx, hx) for y in (-hy, hy) for z in (-hz, hz)])
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    tris = []
    for a, b, c, d in quads:
        tris += [(a, b, c), (a, c, d)]
    return v[np.array(tris)]


def sample_triangles(tris: np.ndarray, n: int, seed: int = 0) -> np.ndarray:
    """Area-weighted uniform surface samples from T x 3 x 3 triangles."""
    tris = np.asarray(tris, dtype=np.float64)
    area = 0.5 * np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1)
    if area.sum() <= 0:
        raise ValueError("triangles have zero total area")
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(tris), size=n, p=area / area.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    t = tris[pick]
    return t[:, 0] + u[:, None] * (t[:, 1] - t[:, 0]) + v[:, None] * (t[:, 2] - t[:, 0])


def isolated_mask(points: np.ndarray, voxel: float, min_neighbors: int) -> np.ndarray:
    """True for points with fewer than `min_neighbors` points (itself included) in their
    3x3x3 voxel neighbourhood. Removes stray splats without shaving dense sharp features."""
    keys = np.floor(points / voxel).astype(np.int64)
    keys -= keys.min(axis=0) - 1
    span = keys.max(axis=0) + 2
    code = (keys[:, 0] * span[1] + keys[:, 1]) * span[2] + keys[:, 2]
    uniq, inverse, counts = np.unique(code, return_inverse=True, return_counts=True)
    total = np.zeros(len(uniq), dtype=np.int64)
    vk = np.stack(np.unravel_index(uniq, (span[0], span[1], span[2])), axis=1)
    for off in itertools.product((-1, 0, 1), repeat=3):
        nb = ((vk[:, 0] + off[0]) * span[1] + vk[:, 1] + off[1]) * span[2] + vk[:, 2] + off[2]
        pos = np.searchsorted(uniq, nb)
        pos = np.minimum(pos, len(uniq) - 1)
        hit = uniq[pos] == nb
        total[hit] += counts[pos[hit]]
    return total[inverse] < min_neighbors
