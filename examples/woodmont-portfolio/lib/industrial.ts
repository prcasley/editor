// A warehouse site from published spec-sheet numbers: the building as rooms on a
// dock-high floor, dock and drive-in doors on the dock walls, a flat roof, and the
// truck courts, trailer rows and car fields on the grade level.
import { ft, type Pt, rect, round, SQM_PER_ACRE } from './geometry'
import { addSlabs, addZones, type SlabSpec, startScene } from './massing'
import type { PascalSession } from './session'

export type Space = {
  name: string
  /** Plan x range inside the building, metres. */
  x0: number
  x1: number
  docks: number
  driveIns: number
}

export type WarehouseSpec = {
  siteName: string
  buildingName: string
  address?: Record<string, string>
  lengthM: number
  depthM: number
  siteAcres: number
  wallHeightM: number
  dockHighM: number
  wallThicknessM: number
  /** 'south' = rear-load with docks on the +z wall; 'both' = cross-dock. */
  dockSides: 'south' | 'both'
  /** Spaces along the building, west to east; their docks go on the south wall (and north for a cross-dock). */
  spaces: Space[]
  /** Docks and drive-ins on the north wall of a cross-dock. */
  northDocks?: { docks: number; driveIns: number }
  dockSpacingM: number
  dockDoor: { width: number; height: number }
  driveInDoor: { width: number; height: number }
  truckCourtM: number
  trailerStalls: { south: number; north: number }
  trailerStall: { width: number; depth: number }
  carStalls: { north: number; ends: number }
  office?: { sqm: number }
  columns?: { xs: number[]; zs: number[]; size: number }
  buildingMetadata: Record<string, unknown>
  siteMetadata: Record<string, unknown>
}

const ASPHALT = '#3d3f42'
const CONCRETE = '#a9a7a1'
const STALL_W = ft(9)
const STALL_D = ft(18)
const AISLE = ft(24)

/** A double-loaded car field of `n` stalls with rows along x, its near edge on z = edgeZ, growing away by `dir`. */
function carFieldAlongX(n: number, cx: number, edgeZ: number, dir: 1 | -1, maxRow: number): Pt[] {
  const perBay = 2 * Math.floor(maxRow / STALL_W)
  const bays = Math.ceil(n / perBay)
  const perRow = Math.ceil(n / (2 * bays))
  const w = perRow * STALL_W
  const d = bays * (2 * STALL_D + AISLE)
  const z0 = edgeZ
  const z1 = edgeZ + dir * d
  return rect(cx, (z0 + z1) / 2, w, Math.abs(z1 - z0))
}

/** The same, with rows along z, near edge on x = edgeX. */
function carFieldAlongZ(n: number, cz: number, edgeX: number, dir: 1 | -1, maxRow: number): Pt[] {
  const perBay = 2 * Math.floor(maxRow / STALL_W)
  const bays = Math.ceil(n / perBay)
  const perRow = Math.ceil(n / (2 * bays))
  const d = perRow * STALL_W
  const w = bays * (2 * STALL_D + AISLE)
  return rect(edgeX + (dir * w) / 2, cz, w, d)
}

/** x positions of a run of `count` openings at `spacing`, centred on `cx`. */
function run(count: number, spacing: number, cx: number): number[] {
  return Array.from({ length: count }, (_, i) => cx + (i - (count - 1) / 2) * spacing)
}

export async function buildWarehouse(s: PascalSession, w: WarehouseSpec) {
  const L2 = w.lengthM / 2
  const D2 = w.depthM / 2
  const tc = w.truckCourtM
  const stall = w.trailerStall

  // Site layout extents, then a rectangle of the published acreage around them.
  const southEdge = D2 + tc + stall.depth
  const northEdge =
    w.dockSides === 'both' ? -(D2 + tc + stall.depth) : -(D2 + 3 + 2 * STALL_D + AISLE)
  const endField = w.carStalls.ends > 0 ? 3 + 2 * (2 * STALL_D + AISLE) : 0
  const layoutW = w.lengthM + 2 * endField
  const layoutD = southEdge - northEdge
  const siteSqm = w.siteAcres * SQM_PER_ACRE
  let siteW = layoutW + 60
  let siteD = siteSqm / siteW
  if (siteD < layoutD + 30) {
    siteD = layoutD + 30
    siteW = siteSqm / siteD
  }
  const siteCz = (southEdge + northEdge) / 2
  const sitePoly = rect(0, siteCz, siteW, siteD)

  const root = await startScene(s, {
    name: w.siteName,
    polygon: sitePoly,
    ...(w.address ? { address: w.address } : {}),
    metadata: w.siteMetadata,
  })

  // The building: one storey on the dock-high datum.
  const buildingId = 'building_warehouse'
  await s.call('apply_patch', {
    patches: [
      {
        op: 'create',
        parentId: root.siteId,
        node: {
          type: 'building',
          id: buildingId,
          name: w.buildingName,
          position: [0, w.dockHighM, 0],
          rotation: [0, 0, 0],
          metadata: w.buildingMetadata,
        },
      },
    ],
  })
  const { levelId } = await s.call('add_level', {
    buildingId,
    height: w.wallHeightM,
    name: 'Warehouse floor (dock-high)',
  })

  // Rooms west to east. An office sits in a notch at the middle of the west wall.
  const officeD = w.office ? Math.sqrt(w.office.sqm / 1.6) : 0
  const officeW = w.office ? w.office.sqm / officeD : 0
  for (const [i, sp] of w.spaces.entries()) {
    const x0 = round(sp.x0, 3)
    const x1 = round(sp.x1, 3)
    const polygon: Pt[] =
      i === 0 && w.office
        ? [
            [x0, -D2],
            [x1, -D2],
            [x1, D2],
            [x0, D2],
            [x0, round(officeD / 2, 3)],
            [round(x0 + officeW, 3), round(officeD / 2, 3)],
            [round(x0 + officeW, 3), round(-officeD / 2, 3)],
            [x0, round(-officeD / 2, 3)],
          ]
        : [
            [x0, -D2],
            [x1, -D2],
            [x1, D2],
            [x0, D2],
          ]
    await s.call('create_room', {
      levelId,
      name: sp.name,
      polygon,
      wallThickness: w.wallThicknessM,
    })
  }
  if (w.office) {
    const x0 = round(w.spaces[0]!.x0, 3)
    await s.call('create_room', {
      levelId,
      name: 'Office',
      polygon: [
        [x0, round(-officeD / 2, 3)],
        [round(x0 + officeW, 3), round(-officeD / 2, 3)],
        [round(x0 + officeW, 3), round(officeD / 2, 3)],
        [x0, round(officeD / 2, 3)],
      ],
      wallThickness: w.wallThicknessM,
      doors: [{ wallIndex: 3, t: 0.5, width: 1.8, height: 2.4, style: 'glass' }],
      windows: [
        { wallIndex: 3, t: 0.2, width: 3, height: 2.4, sillHeight: 0.9 },
        { wallIndex: 3, t: 0.8, width: 3, height: 2.4, sillHeight: 0.9 },
      ],
    })
  }

  // Openings on the dock walls, each at the wall segment that holds its x.
  const { walls } = await s.call('get_walls', { levelId })
  type W = { id: string; start: Pt; end: Pt }
  const onLine = (z: number) =>
    (walls as W[]).filter(
      (wl) => Math.abs(wl.start[1] - z) < 0.01 && Math.abs(wl.end[1] - z) < 0.01,
    )
  let docks = 0
  let driveIns = 0
  async function openings(z: number, xs: number[], kind: 'dock' | 'drive-in') {
    const door = kind === 'dock' ? w.dockDoor : w.driveInDoor
    for (const x of xs) {
      const wall = onLine(z).find(
        (wl) =>
          x > Math.min(wl.start[0], wl.end[0]) + 1 && x < Math.max(wl.start[0], wl.end[0]) - 1,
      )
      if (!wall) throw new Error(`no wall at x=${x} on z=${z}`)
      const t = (x - wall.start[0]) / (wall.end[0] - wall.start[0])
      await s.call('add_door', {
        wallId: wall.id,
        t: round(t, 5),
        width: door.width,
        height: door.height,
        doorType: 'garage-sectional',
        name: kind === 'dock' ? 'Dock door' : 'Drive-in door',
      })
      if (kind === 'dock') docks++
      else driveIns++
    }
  }
  for (const sp of w.spaces) {
    const cx = (sp.x0 + sp.x1) / 2
    const xs = run(sp.docks + sp.driveIns, w.dockSpacingM, cx)
    const half = Math.floor(sp.driveIns / 2)
    const driveXs = [...xs.slice(0, sp.driveIns - half), ...xs.slice(xs.length - half)]
    await openings(
      D2,
      xs.filter((x) => !driveXs.includes(x)),
      'dock',
    )
    await openings(D2, driveXs, 'drive-in')
  }
  if (w.northDocks) {
    const xs = run(w.northDocks.docks + w.northDocks.driveIns, w.dockSpacingM, 0)
    const half = Math.floor(w.northDocks.driveIns / 2)
    const driveXs = [...xs.slice(0, w.northDocks.driveIns - half), ...xs.slice(xs.length - half)]
    await openings(
      -D2,
      xs.filter((x) => !driveXs.includes(x)),
      'dock',
    )
    await openings(-D2, driveXs, 'drive-in')
  }

  if (w.columns) {
    for (const x of w.columns.xs)
      for (const z of w.columns.zs)
        await s.call('add_column', {
          level: levelId,
          x: round(x, 3),
          z: round(z, 3),
          height: w.wallHeightM,
          crossSection: 'square',
          width: w.columns.size,
          depth: w.columns.size,
        })
  }

  await s.call('create_roof', {
    levelId,
    width: w.lengthM,
    depth: w.depthM,
    roofType: 'flat',
    overhang: 0,
    name: 'Flat roof',
  })

  // Site works on grade.
  const slabs: SlabSpec[] = []
  const zones: { label: string; polygon: Pt[]; properties: Record<string, unknown> }[] = []
  const courtLen = w.lengthM + 20
  const court = (sign: 1 | -1, label: string) => {
    const poly = rect(0, sign * (D2 + tc / 2), courtLen, tc)
    slabs.push({
      name: label,
      polygon: poly,
      color: CONCRETE,
      metadata: { depth: `${round(tc / 0.3048)} ft` },
    })
    zones.push({ label, polygon: poly, properties: { depthFt: round(tc / 0.3048) } })
  }
  const trailers = (sign: 1 | -1, n: number) => {
    if (n === 0) return
    const poly = rect(0, sign * (D2 + tc + stall.depth / 2), n * stall.width, stall.depth)
    slabs.push({
      name: `Trailer parking (${n})`,
      polygon: poly,
      color: ASPHALT,
      metadata: { stalls: n },
    })
    zones.push({ label: `Trailer parking: ${n} stalls`, polygon: poly, properties: { stalls: n } })
  }
  court(1, w.dockSides === 'both' ? 'Truck court (south)' : 'Truck court')
  trailers(1, w.trailerStalls.south)
  if (w.dockSides === 'both') {
    court(-1, 'Truck court (north)')
    trailers(-1, w.trailerStalls.north)
  }
  if (w.carStalls.north > 0) {
    const n = w.carStalls.north
    const poly = carFieldAlongX(n, 0, -(D2 + 3), -1, w.lengthM * 0.8)
    slabs.push({ name: 'Car parking', polygon: poly, color: ASPHALT, metadata: { stalls: n } })
    zones.push({ label: `Car parking: ${n} stalls`, polygon: poly, properties: { stalls: n } })
  }
  if (w.carStalls.ends > 0) {
    const perEnd = [Math.ceil(w.carStalls.ends / 2), Math.floor(w.carStalls.ends / 2)]
    for (const [i, sign] of ([-1, 1] as const).entries()) {
      const n = perEnd[i]!
      const poly = carFieldAlongZ(n, 0, sign * (L2 + 3), sign, w.depthM)
      slabs.push({ name: 'Car parking', polygon: poly, color: ASPHALT, metadata: { stalls: n } })
      zones.push({ label: `Car parking: ${n} stalls`, polygon: poly, properties: { stalls: n } })
    }
  }
  zones.push({
    label: `Site outline (${w.siteAcres} acres, schematic)`,
    polygon: sitePoly,
    properties: { acres: w.siteAcres, basis: 'published area; shape and position schematic' },
  })
  await addSlabs(s, root.gradeLevelId, slabs)
  await addZones(s, root.gradeLevelId, zones)

  return { docks, driveIns, siteW, siteD }
}
