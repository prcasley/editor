// Plan geometry in Pascal's site frame: metres, x east, z south.
export type Pt = [number, number]

export const SQFT_PER_SQM = 10.763910417
export const M_PER_FT = 0.3048
export const SQM_PER_ACRE = 4046.8564224

export const ft = (feet: number) => feet * M_PER_FT
export const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp

export function area(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i]!
    const [x2, z2] = poly[(i + 1) % poly.length]!
    a += x1 * z2 - x2 * z1
  }
  return Math.abs(a) / 2
}

/** An open ring: drops a closing point that repeats the first. */
export function openRing(poly: Pt[]): Pt[] {
  const first = poly[0]!
  const last = poly[poly.length - 1]!
  return first[0] === last[0] && first[1] === last[1] ? poly.slice(0, -1) : poly
}

/** "x y x y ..." with y north (as OpenStreetMap extracts are stored) to site [x, z]. */
export function parseNorthUp(s: string): Pt[] {
  const v = s.trim().split(/\s+/).map(Number)
  const out: Pt[] = []
  for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i]!, -v[i + 1]!])
  return openRing(out)
}

/** Angle in the plan (atan2(dz, dx)) of the polygon's longest edge. */
export function longestEdgeAngle(poly: Pt[]): number {
  let best = -1
  let angle = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i]!
    const [x2, z2] = poly[(i + 1) % poly.length]!
    const len = Math.hypot(x2 - x1, z2 - z1)
    if (len > best) {
      best = len
      angle = Math.atan2(z2 - z1, x2 - x1)
    }
  }
  return angle
}

/**
 * Plan angle of the long side of the footprint's minimum-area bounding rectangle,
 * whose sides follow one of the convex hull's edges. Irregular outlines (a
 * clubhouse with wings) get the same axes a person would draw.
 */
export function minAreaRectAngle(poly: Pt[]): number {
  const hull = convexHull(poly)
  let best = Number.POSITIVE_INFINITY
  let angle = longestEdgeAngle(poly)
  for (let i = 0; i < hull.length; i++) {
    const [x1, z1] = hull[i]!
    const [x2, z2] = hull[(i + 1) % hull.length]!
    const a = Math.atan2(z2 - z1, x2 - x1)
    const c = Math.cos(a)
    const s = Math.sin(a)
    const us = hull.map(([x, z]) => c * x + s * z)
    const vs = hull.map(([x, z]) => -s * x + c * z)
    const w = Math.max(...us) - Math.min(...us)
    const d = Math.max(...vs) - Math.min(...vs)
    if (w * d < best - 1e-6) {
      best = w * d
      angle = w >= d ? a : a + Math.PI / 2
    }
  }
  return angle
}

/**
 * A building frame for a site-frame footprint: the building's position, its
 * rotation about Y (three.js convention) and the footprint in building-local
 * coordinates, the long side of its minimum bounding rectangle along local x.
 * world = R_y(theta) * local + position, so local = R_y(-theta) * (world - position).
 */
export function buildingFrame(footprint: Pt[]) {
  const phi = minAreaRectAngle(footprint)
  const theta = -phi
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const rotated = footprint.map(([x, z]): Pt => [c * x - s * z, s * x + c * z])
  const xs = rotated.map((p) => p[0])
  const zs = rotated.map((p) => p[1])
  const lc: Pt = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2]
  // Centre in world: R_y(theta) * lc.
  const center: Pt = [c * lc[0] + s * lc[1], -s * lc[0] + c * lc[1]]
  const local = rotated.map(([x, z]): Pt => [round(x - lc[0], 3), round(z - lc[1], 3)])
  return {
    position: [round(center[0], 3), 0, round(center[1], 3)] as [number, number, number],
    rotationY: round(theta, 6),
    local,
    width: round(Math.max(...xs) - Math.min(...xs), 2),
    depth: round(Math.max(...zs) - Math.min(...zs), 2),
  }
}

/** Axis-aligned rectangle centred on (cx, cz). */
export function rect(cx: number, cz: number, w: number, d: number): Pt[] {
  return [
    [round(cx - w / 2, 3), round(cz - d / 2, 3)],
    [round(cx + w / 2, 3), round(cz - d / 2, 3)],
    [round(cx + w / 2, 3), round(cz + d / 2, 3)],
    [round(cx - w / 2, 3), round(cz + d / 2, 3)],
  ]
}

/** One quad per segment of a polyline, `width` wide, extended by half the width at each end so joints close. */
export function polylineQuads(points: Pt[], width: number): Pt[][] {
  const out: Pt[][] = []
  const h = width / 2
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, z1] = points[i]!
    const [x2, z2] = points[i + 1]!
    const len = Math.hypot(x2 - x1, z2 - z1)
    if (len < 0.5) continue
    const ux = (x2 - x1) / len
    const uz = (z2 - z1) / len
    const nx = -uz * h
    const nz = ux * h
    const ax = x1 - ux * h
    const az = z1 - uz * h
    const bx = x2 + ux * h
    const bz = z2 + uz * h
    out.push([
      [round(ax + nx, 3), round(az + nz, 3)],
      [round(bx + nx, 3), round(bz + nz, 3)],
      [round(bx - nx, 3), round(bz - nz, 3)],
      [round(ax - nx, 3), round(az - nz, 3)],
    ])
  }
  return out
}

export function polylineLength(points: Pt[]): number {
  let len = 0
  for (let i = 0; i + 1 < points.length; i++) {
    len += Math.hypot(points[i + 1]![0] - points[i]![0], points[i + 1]![1] - points[i]![1])
  }
  return len
}

/** Convex hull (monotone chain), counter-clockwise in the x/z plane. */
export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0)
      lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0)
      upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function signedArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i]!
    const [x2, z2] = poly[(i + 1) % poly.length]!
    a += x1 * z2 - x2 * z1
  }
  return a / 2
}

/** Offsets a convex polygon outward by `d` metres (mitred corners), whichever its winding. */
export function offsetConvex(poly: Pt[], d: number): Pt[] {
  const n = poly.length
  const sign = signedArea(poly) > 0 ? -1 : 1
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n]!
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const nx = (sign * (b[1] - a[1])) / len
    const nz = (-sign * (b[0] - a[0])) / len
    return { p: [a[0] + nx * d, a[1] + nz * d] as Pt, dir: [b[0] - a[0], b[1] - a[1]] as Pt }
  })
  return lines.map((l1, i) => {
    const l0 = lines[(i - 1 + n) % n]!
    const det = l0.dir[0] * l1.dir[1] - l0.dir[1] * l1.dir[0]
    const t = ((l1.p[0] - l0.p[0]) * l1.dir[1] - (l1.p[1] - l0.p[1]) * l1.dir[0]) / det
    return [round(l0.p[0] + l0.dir[0] * t, 2), round(l0.p[1] + l0.dir[1] * t, 2)] as Pt
  })
}

/** Separating-axis overlap test for two convex polygons. */
export function convexOverlap(a: Pt[], b: Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!
      const q = poly[(i + 1) % poly.length]!
      const nx = q[1] - p[1]
      const nz = p[0] - q[0]
      const project = (r: Pt[]) => r.map(([x, z]) => x * nx + z * nz)
      const pa = project(a)
      const pb = project(b)
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false
    }
  }
  return true
}

/** The strip of `depth` metres along one side of a segment (side +1 or -1), from a to b. */
export function sideStrip(a: Pt, b: Pt, offset: number, depth: number, side: 1 | -1): Pt[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const nx = (-(b[1] - a[1]) / len) * side
  const nz = ((b[0] - a[0]) / len) * side
  const at = (p: Pt, d: number): Pt => [round(p[0] + nx * d, 3), round(p[1] + nz * d, 3)]
  return [at(a, offset), at(b, offset), at(b, offset + depth), at(a, offset + depth)]
}
