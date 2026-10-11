"""Pinhole camera helpers and a small z-buffer triangle rasterizer (numpy only).

Used to produce occlusion-aware target masks (and metric depth) for Pascal cases from the
same massing geometry the ground truth is measured on, and by the tests.
"""

from __future__ import annotations

import numpy as np

from .case_format import Camera


def look_at_camera(position, target, fov_y_deg: float, width: int, height: int,
                   up=(0.0, 1.0, 0.0)) -> Camera:
    """OpenCV camera equivalent to a three.js PerspectiveCamera(fov_y).lookAt(target).

    three.js maps pixel i to [i, i+1) in screen space; OpenCV puts pixel centres on
    integers, hence c = (size - 1) / 2.
    """
    pos = np.asarray(position, dtype=np.float64)
    fwd = np.asarray(target, dtype=np.float64) - pos
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, np.asarray(up, dtype=np.float64))
    if np.linalg.norm(right) < 1e-9:
        raise ValueError("camera forward is parallel to up")
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, down, fwd, pos
    f = (height / 2.0) / np.tan(np.radians(fov_y_deg) / 2.0)
    return Camera(width, height, f, f, (width - 1) / 2.0, (height - 1) / 2.0, m)


def world_to_camera(points: np.ndarray, cam: Camera) -> np.ndarray:
    m = np.linalg.inv(cam.world_from_camera)
    return points @ m[:3, :3].T + m[:3, 3]


def project(points_cam: np.ndarray, cam: Camera) -> np.ndarray:
    z = points_cam[..., 2:3]
    return np.concatenate([cam.fx * points_cam[..., 0:1] / z + cam.cx,
                           cam.fy * points_cam[..., 1:2] / z + cam.cy], axis=-1)


def rasterize(triangles_world: np.ndarray, ids: np.ndarray, cam: Camera,
              near: float = 0.05) -> tuple[np.ndarray, np.ndarray]:
    """Z-buffer T x 3 x 3 world triangles (clipped at `near`). Returns (depth H x W with inf
    background, id map H x W with -1 background)."""
    H, W = cam.height, cam.width
    depth = np.full((H, W), np.inf)
    idmap = np.full((H, W), -1, dtype=np.int64)
    tri_cam = world_to_camera(triangles_world.reshape(-1, 3), cam).reshape(-1, 3, 3)
    pieces, piece_ids = [], []
    for t, tid in zip(tri_cam, ids):
        z = t[:, 2]
        if np.all(z > near):
            pieces.append(t)
            piece_ids.append(tid)
        elif np.any(z > near):
            poly = _clip_near(t, near)
            for k in range(1, len(poly) - 1):
                pieces.append(np.array([poly[0], poly[k], poly[k + 1]]))
                piece_ids.append(tid)
    for t, tid in zip(pieces, piece_ids):
        z = t[:, 2]
        uv = project(t, cam)
        x0, y0 = np.floor(uv.min(axis=0)).astype(int)
        x1, y1 = np.ceil(uv.max(axis=0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, W - 1), min(y1, H - 1)
        if x0 > x1 or y0 > y1:
            continue
        (ax, ay), (bx, by), (cx, cy) = uv
        area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if abs(area) < 1e-12:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        w0 = ((bx - xs) * (cy - ys) - (by - ys) * (cx - xs)) / area
        w1 = ((cx - xs) * (ay - ys) - (cy - ys) * (ax - xs)) / area
        w2 = 1.0 - w0 - w1
        inside = (w0 >= -1e-9) & (w1 >= -1e-9) & (w2 >= -1e-9)
        if not inside.any():
            continue
        zz = 1.0 / (w0 / z[0] + w1 / z[1] + w2 / z[2])  # perspective-correct depth
        win = depth[y0:y1 + 1, x0:x1 + 1]
        closer = inside & (zz < win)
        win[closer] = zz[closer]
        idmap[y0:y1 + 1, x0:x1 + 1][closer] = tid
    return depth, idmap


def _clip_near(tri: np.ndarray, near: float) -> list[np.ndarray]:
    """Sutherland-Hodgman clip of one camera-space triangle against z > near."""
    out = []
    for i in range(3):
        p, q = tri[i], tri[(i + 1) % 3]
        pin, qin = p[2] > near, q[2] > near
        if pin:
            out.append(p)
        if pin != qin:
            t = (near - p[2]) / (q[2] - p[2])
            out.append(p + t * (q - p))
    return out
