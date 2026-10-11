"""PNG helpers with the standard library only: write 8-bit gray/RGB, read the size."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def write_png(path: str | Path, image: np.ndarray) -> None:
    """Write an H x W (gray) or H x W x 3 (RGB) uint8 array."""
    img = np.asarray(image)
    if img.dtype != np.uint8:
        raise ValueError(f"PNG writer needs uint8, got {img.dtype}")
    if img.ndim == 2:
        color_type, channels = 0, 1
    elif img.ndim == 3 and img.shape[2] == 3:
        color_type, channels = 2, 3
    else:
        raise ValueError(f"PNG writer needs H x W or H x W x 3, got {img.shape}")
    h, w = img.shape[:2]
    rows = img.reshape(h, w * channels)
    raw = np.concatenate([np.zeros((h, 1), np.uint8), rows], axis=1).tobytes()
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0)
    data = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(raw, 9))
    Path(path).write_bytes(data + _chunk(b"IEND", b""))


def png_size(path: str | Path) -> tuple[int, int]:
    """Return (width, height) from the IHDR chunk."""
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        raise ValueError(f"{path} is not a PNG file")
    w, h = struct.unpack(">II", head[16:24])
    return int(w), int(h)


def _unfilter(raw: bytes, h: int, row_bytes: int, bpp: int) -> np.ndarray:
    data = np.frombuffer(raw, dtype=np.uint8)
    if len(data) != h * (row_bytes + 1):
        raise ValueError("PNG image data has the wrong length")
    rows = data.reshape(h, row_bytes + 1)
    out = np.zeros((h, row_bytes), dtype=np.uint8)
    prev = np.zeros(row_bytes, dtype=np.int32)
    for y in range(h):
        ftype, line = rows[y, 0], rows[y, 1:].astype(np.int32)
        if ftype == 0:
            cur = line
        elif ftype == 1:  # Sub: running sum per byte lane
            pad = (-row_bytes) % bpp
            lanes = np.concatenate([line, np.zeros(pad, np.int32)]).reshape(-1, bpp)
            cur = (np.cumsum(lanes, axis=0) % 256).reshape(-1)[:row_bytes]
        elif ftype == 2:
            cur = (line + prev) % 256
        elif ftype in (3, 4):
            cur = np.zeros(row_bytes, dtype=np.int32)
            for i in range(row_bytes):
                a = int(cur[i - bpp]) if i >= bpp else 0
                b = int(prev[i])
                if ftype == 3:
                    cur[i] = (int(line[i]) + (a + b) // 2) % 256
                else:
                    c = int(prev[i - bpp]) if i >= bpp else 0
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                    cur[i] = (int(line[i]) + pred) % 256
        else:
            raise ValueError(f"PNG filter type {ftype} is invalid")
        out[y] = cur
        prev = cur
    return out


def read_png(path: str | Path) -> np.ndarray:
    """Decode a non-interlaced PNG to uint8 H x W x C (C = 1, 2, 3 or 4; palette expanded)."""
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG file")
    pos, idat, palette, trns = 8, [], None, None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif tag == b"PLTE":
            palette = np.frombuffer(body, np.uint8).reshape(-1, 3)
        elif tag == b"tRNS":
            trns = np.frombuffer(body, np.uint8)
        elif tag == b"IDAT":
            idat.append(body)
        elif tag == b"IEND":
            break
    if interlace:
        raise ValueError(f"{path}: interlaced PNG is not supported")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    bits = depth * channels
    row_bytes = (w * bits + 7) // 8
    raw = _unfilter(zlib.decompress(b"".join(idat)), h, row_bytes, max(1, bits // 8))
    if depth == 16:
        img = raw.reshape(h, w, channels * 2)[:, :, 0::2]
    elif depth == 8:
        img = raw.reshape(h, w, channels)
    else:
        bitsarr = np.unpackbits(raw, axis=1).reshape(h, -1)[:, : w * depth].reshape(h, w, depth)
        vals = (bitsarr * (1 << np.arange(depth - 1, -1, -1))).sum(axis=2).astype(np.uint8)
        img = vals[..., None] if ctype == 3 else (vals * (255 // ((1 << depth) - 1)))[..., None]
    if ctype == 3:
        if palette is None:
            raise ValueError(f"{path}: palette image without PLTE")
        idx = img[..., 0]
        rgb = palette[idx]
        if trns is not None:
            alpha = np.full(len(palette), 255, np.uint8)
            alpha[: len(trns)] = trns
            return np.concatenate([rgb, alpha[idx][..., None]], axis=2)
        return rgb
    return img


def read_mask(path: str | Path) -> np.ndarray:
    """Boolean H x W object mask: the alpha channel when present, else any non-zero colour."""
    img = read_png(path)
    if img.shape[2] in (2, 4):
        return img[..., -1] > 0
    return np.any(img > 0, axis=2)
