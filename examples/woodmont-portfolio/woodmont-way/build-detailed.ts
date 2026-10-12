// Woodmont Way, West Windsor NJ: the whole site with the facade vocabulary read from
// the public renderings and photos (lap siding, brick base, white trim bands, window
// bays, stacked balconies on columns, hip roofs with cross-gables and dormers), the
// clubhouse, garages, pool courtyard, courts, bark park, roads, parking, lawn and trees.
// Every node is made through Pascal MCP tool calls, like the other scenes.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createDormerDefaultWindow,
  DormerNode,
  getDormerDefaultWindowFace,
  getRoofSegmentSurfaceY,
  type RoofSegmentNode,
} from '@pascal-app/core'
import type { Facts } from '../lib/facts'
import {
  area,
  buildingFrame,
  convexHull,
  convexOverlap,
  offsetConvex,
  type Pt,
  parseNorthUp,
  polylineQuads,
  round,
  SQM_PER_ACRE,
  sideStrip,
} from '../lib/geometry'
import { type SlabSpec, startScene } from '../lib/massing'
import type { PascalSession } from '../lib/session'
import type { SceneOutput } from '../lib/types'

type OsmWay = { id: number; tag: string; role?: string; name?: string; p: string }
type OsmExtract = { buildings: OsmWay[]; pools: OsmWay[]; roads: OsmWay[] }
type Vec3 = [number, number, number]

const lib = (id: string) => `library:${id}`
const M = {
  sidings: ['siding-lap-white', 'siding-lap-greige', 'siding-lap-gray', 'siding-lap-sage'].map(lib),
  brick: lib('flooring-weatheredbrick'),
  trim: lib('preset-white'),
  shingles: lib('roof-greyshingles'),
  poolTile: lib('flooring-pooltiles'),
  deck: lib('concrete-raw'),
  patio: lib('concrete-plate'),
  walk: lib('flooring-ground13'),
  balconyDeck: lib('wood-woodplank19'),
}
const C = {
  lawn: '#66844a',
  street: '#2f3133',
  asphalt: '#3d3f42',
  water: '#3e9fc4',
  courtBlue: '#2f6c9e',
  courtGreen: '#3d6b48',
  bocceSand: '#cbb48a',
  bocceTimber: '#6f5236',
  barkTurf: '#7a8c55',
  fenceBlack: '#1f1f1f',
}

const osmRef = (id: number) => ({
  refs: [{ ns: 'osm', id: `way/${id}`, role: 'primary' as const }],
})

function signedArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i]!
    const [x2, z2] = poly[(i + 1) % poly.length]!
    a += x1 * z2 - x2 * z1
  }
  return a / 2
}

/** The ring wound so that a wall drawn along each edge has its exterior on face `b`. */
const exteriorOnB = (poly: Pt[]) => (signedArea(poly) > 0 ? poly : [...poly].reverse())

/** A rectangle centred on c, `w` along plan angle `ang`, `d` across it. */
function orientedRect(c: Pt, w: number, d: number, ang: number): Pt[] {
  const u: Pt = [Math.cos(ang), Math.sin(ang)]
  const n: Pt = [-u[1], u[0]]
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => [
    round(c[0] + (u[0] * a! * w) / 2 + (n[0] * b! * d) / 2, 3),
    round(c[1] + (u[1] * a! * w) / 2 + (n[1] * b! * d) / 2, 3),
  ])
}

function insideConvex(p: Pt, poly: Pt[]): boolean {
  const s = Math.sign(signedArea(poly))
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    if (s * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) < 0) return false
  }
  return true
}

/** Building-local plan point to world (the building frame's R_y(theta) and position). */
function toWorld(frame: ReturnType<typeof buildingFrame>, p: Pt): Pt {
  const c = Math.cos(frame.rotationY)
  const s = Math.sin(frame.rotationY)
  return [
    round(c * p[0] + s * p[1] + frame.position[0], 2),
    round(-s * p[0] + c * p[1] + frame.position[2], 2),
  ]
}

type Edge = { wallId: string; a: Pt; b: Pt; len: number; face: 'a' | 'b'; reversed: boolean }

type ShellBuilding = {
  buildingId: string
  frame: ReturnType<typeof buildingFrame>
  ring: Pt[]
  levelIds: string[]
  edges: Edge[][]
}

/** A building of story shells on its footprint, with each exterior edge mapped to its wall. */
async function addShellBuilding(
  s: PascalSession,
  siteId: string,
  spec: {
    id: string
    name: string
    footprint: Pt[]
    stories: number
    floorToFloor: number
    wallThickness: number
    provenance?: ReturnType<typeof osmRef>
    metadata: Record<string, unknown>
  },
): Promise<ShellBuilding> {
  const frame = buildingFrame(spec.footprint)
  const ring = exteriorOnB(frame.local)
  const buildingId = `building_${spec.id}`
  await s.call('apply_patch', {
    patches: [
      {
        op: 'create',
        parentId: siteId,
        node: {
          type: 'building',
          id: buildingId,
          name: spec.name,
          position: frame.position,
          rotation: [0, frame.rotationY, 0],
          metadata: spec.metadata,
          ...(spec.provenance ? { provenance: spec.provenance } : {}),
        },
      },
    ],
  })
  const levelIds: string[] = []
  const edges: Edge[][] = []
  for (let i = 0; i < spec.stories; i++) {
    const lv = await s.call('add_level', {
      buildingId,
      height: spec.floorToFloor,
      name: i === 0 ? 'Ground floor' : `Floor ${i + 1}`,
    })
    levelIds.push(lv.levelId)
    await s.call('create_story_shell', {
      levelId: lv.levelId,
      footprint: ring,
      wallThickness: spec.wallThickness,
      namePrefix: `${spec.name} F${i + 1}`,
    })
    const { walls } = await s.call('get_walls', { levelId: lv.levelId })
    const near = (p: number[], q: Pt) => Math.hypot(p[0]! - q[0], p[1]! - q[1]) < 0.05
    edges.push(
      ring.map((a, k) => {
        const b = ring[(k + 1) % ring.length]!
        const fwd = walls.find(
          (w: { start: number[]; end: number[] }) => near(w.start, a) && near(w.end, b),
        )
        const rev = walls.find(
          (w: { start: number[]; end: number[] }) => near(w.start, b) && near(w.end, a),
        )
        const wall = fwd ?? rev
        if (!wall) throw new Error(`${spec.name}: no wall on edge ${k}`)
        return {
          wallId: wall.id,
          a,
          b,
          len: Math.hypot(b[0] - a[0], b[1] - a[1]),
          face: fwd ? 'b' : 'a',
          reversed: !fwd,
        }
      }),
    )
  }
  return { buildingId, frame, ring, levelIds, edges }
}

/** Exterior finish of every shell wall: siding (brick on a brick-base ground floor) and a white crown band. */
async function finishWalls(
  s: PascalSession,
  b: ShellBuilding,
  siding: string,
  brickBase: boolean,
  band = 0.2,
) {
  const patches = b.edges.flatMap((level, li) =>
    level.map((e) => ({
      op: 'update',
      id: e.wallId,
      data: {
        slots: {
          [e.face]: li === 0 && brickBase ? M.brick : siding,
          [`${e.face}Crown`]: M.trim,
        },
        crown: { enabled: true, sides: e.face, height: band, proud: 0.035, profile: 'flat' },
      },
    })),
  )
  await s.call('apply_patch', { patches })
}

const along = (e: Edge, t: number) => (e.reversed ? 1 - t : t)

type Openings = { windows: string[]; doors: string[]; garageDoors: string[] }

async function addWindow(
  s: PascalSession,
  o: Openings,
  e: Edge,
  t: number,
  w: { width: number; height: number; sillHeight: number },
) {
  const r = await s.call('add_window', {
    wallId: e.wallId,
    t: along(e, t),
    ...w,
    windowType: 'fixed',
    style: 'grid',
  })
  o.windows.push(r.windowId)
}

async function addDoor(
  s: PascalSession,
  o: Openings,
  e: Edge,
  t: number,
  d: Record<string, unknown>,
  garage = false,
) {
  const r = await s.call('add_door', { wallId: e.wallId, t: along(e, t), ...d })
  ;(garage ? o.garageDoors : o.doors).push(r.doorId)
}

/** White frames on windows and doors, white panels on garage doors. */
async function paintOpenings(s: PascalSession, o: Openings) {
  const patches = [
    ...o.windows.map((id) => ({ op: 'update', id, data: { slots: { frame: M.trim } } })),
    ...o.doors.map((id) => ({ op: 'update', id, data: { slots: { frame: M.trim } } })),
    ...o.garageDoors.map((id) => ({
      op: 'update',
      id,
      data: { slots: { frame: M.trim, panel: M.trim } },
    })),
  ]
  if (patches.length) await s.call('apply_patch', { patches })
}

/** A roof with its roles painted: shingles on top, white fascia, siding on its knee walls and gables. */
async function addRoof(
  s: PascalSession,
  levelId: string,
  seg: { width: number; depth: number; roofType: string; pitch: number; center?: Vec3 },
  siding: string,
  name: string,
) {
  const roof = await s.call('create_roof', {
    levelId,
    width: round(seg.width, 3),
    depth: round(seg.depth, 3),
    roofType: seg.roofType,
    pitch: seg.pitch,
    overhang: 0,
    name,
  })
  await s.call('apply_patch', {
    patches: [
      {
        op: 'update',
        id: roof.roofId,
        data: {
          topMaterialPreset: M.shingles,
          edgeMaterialPreset: M.trim,
          wallMaterialPreset: siding,
        },
      },
    ],
  })
  // Moving the segment regenerates its default gutters, so it goes in a call of its own.
  if (seg.center)
    await s.call('apply_patch', {
      patches: [{ op: 'update', id: roof.roofSegmentId, data: { position: seg.center } }],
    })
  return roof as { roofId: string; roofSegmentId: string; roofLevelId: string }
}

const roofSegment = (
  roofType: string,
  width: number,
  depth: number,
  pitch: number,
  position: Vec3,
  rotation: number,
  name: string,
) => ({
  type: 'roof-segment',
  name,
  roofType,
  width: round(width, 3),
  depth: round(depth, 3),
  pitch,
  wallHeight: 0.35,
  wallThickness: 0.16,
  overhang: 0,
  position: position.map((v) => round(v, 3)),
  rotation: round(rotation, 6),
})

const whiteColumn = (x: number, z: number, height: number, size: number, name: string) => ({
  type: 'column',
  name,
  position: [round(x, 3), 0, round(z, 3)],
  crossSection: 'square',
  width: size,
  depth: size,
  height: round(height, 3),
  baseStyle: 'simple-square',
  capitalStyle: 'simple-slab',
  slots: { shaft: M.trim, base: M.trim, capital: M.trim },
})

export async function buildSiteDetailed(
  s: PascalSession,
  facts: Facts,
  dir: string,
): Promise<SceneOutput> {
  const osm = JSON.parse(readFileSync(join(dir, 'osm-extract.json'), 'utf8')) as OsmExtract
  facts.get('footprints')
  facts.get('units')
  facts.get('patioOrBalcony')
  facts.get('facadeVocabulary')
  facts.get('amenities')
  facts.get('barkParkAndGarages')
  facts.get('crossGables')
  const f2f = facts.num('floorToFloor')
  const stories = facts.num('residentialStories')
  const wall = facts.num('exteriorWall')
  const overhang = facts.num('roofOverhang')
  const pitch = facts.num('roofPitchDetailed')
  const bay = facts.num('windowBay')
  const [balconyW, balconyD] = facts.dims('balcony')
  const [winW, winH] = facts.dims('pairedWindow')
  const sill = facts.num('windowSill')
  const columnSize = facts.num('balconyColumn')
  const dormersPerSide = facts.num('dormersPerSide')
  const brickEvery = facts.num('brickBaseShare')

  const footprints = osm.buildings.map((b) => ({ way: b, poly: parseNorthUp(b.p) }))
  const pool = parseNorthUp(osm.pools[0]!.p)
  const services = osm.roads.filter((r) => r.tag === 'highway=service' && !r.name)
  const streets = osm.roads.filter((r) => r.tag !== 'highway=service' || r.name)

  const hullPoints: Pt[] = [
    ...footprints.flatMap((f) => f.poly),
    ...pool,
    ...services.flatMap((r) => parseNorthUp(r.p)),
  ]
  const siteOutline = offsetConvex(convexHull(hullPoints), facts.num('siteOutlineOffset'))

  const root = await startScene(s, {
    name: 'Woodmont Way, West Windsor NJ (detailed site)',
    polygon: siteOutline,
    address: { street: facts.str('address'), city: 'West Windsor', state: 'NJ' },
    metadata: {
      basis:
        'Footprints, pool and road centrelines from OpenStreetMap; facade vocabulary read from the public renderings and photos; layouts, sizes and amenity positions estimated (see facts.md).',
      outlineAcres: round(area(siteOutline) / SQM_PER_ACRE, 1),
      publishedAcres: facts.num('siteAcres'),
    },
  })

  // ---------------------------------------------------------------- site works
  const deckOffset = facts.num('poolDeck')
  const deck = offsetConvex(convexHull(pool), deckOffset)
  const [cabanaW, cabanaD] = facts.dims('cabana')
  const poolXs = pool.map((p) => p[0])
  const poolZs = pool.map((p) => p[1])
  const poolC: Pt = [
    (Math.min(...poolXs) + Math.max(...poolXs)) / 2,
    (Math.min(...poolZs) + Math.max(...poolZs)) / 2,
  ]
  const cabanaC: Pt = [poolC[0], Math.min(...poolZs) - deckOffset + cabanaD / 2 + 0.3]

  const walkWidth = facts.num('buildingWalk')
  const buildingHulls = footprints.map((f) => convexHull(f.poly))
  const walkOuter = buildingHulls.map((h) => offsetConvex(h, walkWidth))
  const clearance = buildingHulls.map((h) => offsetConvex(h, walkWidth + 0.5))

  const slabs: (SlabSpec & { holes?: Pt[][] })[] = [
    {
      name: 'Lawn',
      polygon: siteOutline,
      holes: [pool],
      color: C.lawn,
      elevation: 0.005,
      thickness: 0.01,
      metadata: { basis: 'estimate: landscaped ground inside the estimated site outline' },
    },
  ]
  const streetWidth = facts.num('streetWidth')
  const streetQuads: Pt[][] = []
  for (const r of streets) {
    for (const q of polylineQuads(parseNorthUp(r.p), streetWidth)) {
      streetQuads.push(q)
      slabs.push({
        name: r.name ?? 'Street',
        polygon: q,
        color: C.street,
        elevation: 0.02,
        thickness: 0.02,
        metadata: { basis: `OSM way ${r.id} centreline (${r.tag}); width estimated` },
      })
    }
  }
  const aisle = facts.num('driveAisleWidth')
  const stallDepth = facts.num('stallDepth')
  const stallWidth = facts.num('stallWidth')
  const parkingObstacles = [...clearance, deck]
  const chunk = 4 * stallWidth
  const pavedQuads: Pt[][] = [...streetQuads]
  let stripLength = 0
  for (const r of services) {
    const line = parseNorthUp(r.p)
    for (const q of polylineQuads(line, aisle)) {
      pavedQuads.push(q)
      slabs.push({
        name: 'Drive aisle',
        polygon: q,
        color: C.asphalt,
        elevation: 0.025,
        thickness: 0.02,
        metadata: { basis: `OSM way ${r.id} centreline (highway=service); width estimated` },
      })
    }
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]!
      const b = line[i + 1]!
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      for (let k = 0; k < Math.floor(len / chunk); k++) {
        const p0: Pt = [
          a[0] + ((b[0] - a[0]) * k * chunk) / len,
          a[1] + ((b[1] - a[1]) * k * chunk) / len,
        ]
        const p1: Pt = [
          a[0] + ((b[0] - a[0]) * (k + 1) * chunk) / len,
          a[1] + ((b[1] - a[1]) * (k + 1) * chunk) / len,
        ]
        for (const side of [1, -1] as const) {
          const strip = sideStrip(p0, p1, aisle / 2, stallDepth, side)
          if (parkingObstacles.some((o) => convexOverlap(strip, o))) continue
          stripLength += chunk
          pavedQuads.push(strip)
          slabs.push({
            name: 'Parking stalls (estimated)',
            polygon: strip,
            color: C.asphalt,
            elevation: 0.025,
            thickness: 0.02,
            metadata: {
              basis: 'estimate: 4 perpendicular stalls beside an OSM service-road aisle',
            },
          })
        }
      }
    }
  }
  footprints.forEach((f, i) => {
    slabs.push({
      name: 'Building walk',
      polygon: walkOuter[i]!,
      color: M.walk,
      elevation: 0.03,
      thickness: 0.02,
      metadata: { basis: `estimate: ${walkWidth} m walk around OSM way ${f.way.id}` },
    })
  })
  slabs.push(
    {
      name: 'Pool deck',
      polygon: deck,
      holes: [pool],
      color: M.deck,
      elevation: 0.06,
      thickness: 0.06,
      metadata: { basis: `estimate: pool outline + ${deckOffset} m` },
    },
    {
      name: 'Swimming pool',
      polygon: pool,
      color: M.poolTile,
      elevation: -facts.num('poolDepth'),
      thickness: 0.2,
      recessed: true,
      metadata: { basis: 'OSM way 1375161104 (leisure=swimming_pool); depth estimated' },
    },
    {
      name: 'Pool water',
      polygon: offsetConvex(convexHull(pool), -0.08),
      color: C.water,
      elevation: -0.18,
      thickness: 0.02,
      metadata: { basis: 'water surface 0.18 m below the coping (estimate)' },
    },
  )
  // Slab colours that are library refs go to the surface slot; the side slot follows for pool tile.
  const slabSlots = (sl: SlabSpec) =>
    sl.color === M.poolTile ? { surface: M.poolTile, side: M.poolTile } : { surface: sl.color }

  // Amenity placement: the published courts and bark park, positions estimated as the
  // nearest open lawn to a target, aligned with the residential grid.
  const gridAngle = -buildingFrame(footprints.find((f) => f.way.id === 1518661330)!.poly).rotationY
  const taken: Pt[][] = [...clearance, ...pavedQuads, offsetConvex(deck, 1)]
  const place = (target: Pt, w: number, d: number, label: string) => {
    for (let r = 0; r <= 160; r += 2) {
      const steps = Math.max(1, Math.round((2 * Math.PI * r) / 4))
      for (let k = 0; k < steps; k++) {
        const c: Pt = [
          target[0] + r * Math.cos((2 * Math.PI * k) / steps),
          target[1] + r * Math.sin((2 * Math.PI * k) / steps),
        ]
        for (const ang of [gridAngle, gridAngle + Math.PI / 2]) {
          const rect = orientedRect(c, w, d, ang)
          if (!rect.every((p) => insideConvex(p, siteOutline))) continue
          if (taken.some((o) => convexOverlap(offsetConvex(rect, 1.5), o))) continue
          taken.push(rect)
          return { c, ang, rect }
        }
      }
    }
    throw new Error(`no open lawn for ${label}`)
  }
  const clubhouseFp = footprints.find((f) => f.way.role === 'clubhouse')!
  const clubFrame = buildingFrame(clubhouseFp.poly)
  const clubC: Pt = [clubFrame.position[0], clubFrame.position[2]]
  const [pbW, pbD] = facts.dims('pickleballCourts')
  const [boW, boD] = facts.dims('bocceCourts')
  const [bpW, bpD] = facts.dims('barkPark')
  const pickleball = place(clubC, pbW, pbD, 'pickleball')
  const bocce = place(poolC, boW, boD, 'bocce')
  const barkPark = place([-90, 0], bpW, bpD, 'bark park')

  const u = (ang: number): Pt => [Math.cos(ang), Math.sin(ang)]
  const off = (c: Pt, ang: number, a: number, b: number): Pt => {
    const [ux, uz] = u(ang)
    return [round(c[0] + ux * a - uz * b, 3), round(c[1] + uz * a + ux * b, 3)]
  }
  // Pickleball: two 44 x 20 ft courts side by side on a shared surround.
  slabs.push({
    name: 'Pickleball courts surround',
    polygon: pickleball.rect,
    color: C.courtGreen,
    elevation: 0.04,
    thickness: 0.04,
    metadata: { basis: 'published (pickleball courts); size standard, position estimated' },
  })
  for (const side of [-1, 1]) {
    slabs.push({
      name: 'Pickleball court',
      polygon: orientedRect(
        off(pickleball.c, pickleball.ang, 0, (side * pbD) / 4),
        13.41,
        6.1,
        pickleball.ang,
      ),
      color: C.courtBlue,
      elevation: 0.045,
      thickness: 0.01,
      metadata: { basis: 'standard 44 x 20 ft court' },
    })
  }
  slabs.push(
    {
      name: 'Bocce courts border',
      polygon: bocce.rect,
      color: C.bocceTimber,
      elevation: 0.08,
      thickness: 0.08,
      metadata: { basis: 'published (bocce ball courts); size and position estimated' },
    },
    ...[-1, 1].map((side) => ({
      name: 'Bocce court',
      polygon: orientedRect(
        off(bocce.c, bocce.ang, 0, (side * boD) / 4),
        boW - 0.6,
        boD / 2 - 0.6,
        bocce.ang,
      ),
      color: C.bocceSand,
      elevation: 0.085,
      thickness: 0.02,
      metadata: { basis: 'estimate: two side-by-side bocce lanes' },
    })),
    {
      name: 'Bark park',
      polygon: barkPark.rect,
      color: C.barkTurf,
      elevation: 0.03,
      thickness: 0.02,
      metadata: { basis: 'published (bark park); size and position estimated' },
    },
  )
  await s.call('apply_patch', {
    patches: slabs.map((sl) => ({
      op: 'create',
      parentId: root.gradeLevelId,
      node: {
        type: 'slab',
        name: sl.name,
        polygon: sl.polygon,
        ...(sl.holes ? { holes: sl.holes } : {}),
        elevation: sl.elevation ?? 0.02,
        thickness: sl.thickness ?? 0.02,
        ...(sl.recessed ? { recessed: true } : {}),
        slots: slabSlots(sl),
        metadata: sl.metadata,
      },
    })),
  })

  // Fences: court enclosure and nets, bark park.
  const fence = (a: Pt, b: Pt, spec: Record<string, unknown>, name: string) => ({
    op: 'create',
    parentId: root.gradeLevelId,
    node: { type: 'fence', name, start: a, end: b, ...spec },
  })
  const loop = (rect: Pt[], spec: Record<string, unknown>, name: string) =>
    rect.map((p, i) => fence(p, rect[(i + 1) % rect.length]!, spec, name))
  const black = { posts: C.fenceBlack, infill: C.fenceBlack, rail: C.fenceBlack }
  await s.call('apply_patch', {
    patches: [
      ...loop(
        pickleball.rect,
        {
          height: 3.0,
          style: 'guard',
          guardInfill: 'cable',
          postSpacing: 3,
          baseStyle: 'floating',
          postCap: 'flat',
          slots: black,
        },
        'Pickleball enclosure',
      ),
      ...[-1, 1].map((side) =>
        fence(
          off(pickleball.c, pickleball.ang, 0, (side * pbD) / 4 - 3.4),
          off(pickleball.c, pickleball.ang, 0, (side * pbD) / 4 + 3.4),
          {
            height: 0.91,
            style: 'guard',
            guardInfill: 'cable',
            postSpacing: 6.8,
            baseStyle: 'floating',
            postCap: 'none',
            slots: black,
          },
          'Pickleball net',
        ),
      ),
      ...loop(
        barkPark.rect,
        { height: 1.2, style: 'picket', baseStyle: 'floating', postCap: 'flat', slots: black },
        'Bark park fence',
      ),
    ],
  })

  // ---------------------------------------------------------------- residential buildings
  const counts = {
    units: 0,
    windows: 0,
    doors: 0,
    balconies: 0,
    patios: 0,
    columns: 0,
    dormers: 0,
    gables: 0,
    stairs: 0,
  }
  let resIndex = 0
  const residential: {
    name: string
    b: ShellBuilding
    siding: string
    brick: boolean
    way: number
  }[] = []
  for (const { way, poly } of footprints.filter((f) => f.way.role === 'residential')) {
    const k = resIndex++
    const siding = M.sidings[k % M.sidings.length]!
    const brick = k % brickEvery === 0
    const name = `Residential building ${k + 1}`
    const b = await addShellBuilding(s, root.siteId, {
      id: `wwd_${way.id}`,
      name,
      footprint: poly,
      stories,
      floorToFloor: f2f,
      wallThickness: wall,
      provenance: osmRef(way.id),
      metadata: {
        footprint: `OSM way ${way.id}`,
        stories: 'estimate (see facts.md)',
        siding: siding.replace('library:', ''),
        brickBase: brick,
      },
    })
    residential.push({ name, b, siding, brick, way: way.id })
    if (process.env.WW_PROGRESS) console.log(name, Math.round(performance.now() / 1000), 's')
    await finishWalls(s, b, siding, brick)
    const o: Openings = { windows: [], doors: [], garageDoors: [] }
    const longMin = 0.6 * b.frame.width
    const balconySlabs: object[] = []
    const columns: object[] = []
    const gableSpots: { x: number; side: number }[] = []
    const dormerSpots: { x: number; side: number }[] = []
    for (let li = 0; li < stories; li++) {
      const levelId = b.levelIds[li]!
      for (const e of b.edges[li]!) {
        if (e.len < 6) continue
        const n = Math.max(1, Math.round(e.len / bay))
        const ux = (e.b[0] - e.a[0]) / e.len
        const uz = (e.b[1] - e.a[1]) / e.len
        const nx = uz
        const nz = -ux
        if (e.len >= longMin) {
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n
            const isBalcony = i % 2 === 0
            if (li === stories - 1) {
              const x = e.a[0] + ux * t * e.len
              const side = Math.sign((e.a[1] + e.b[1]) / 2)
              if (n >= 7 && (i === 1 || i === n - 3))
                gableSpots.push({ x: x + (ux * e.len) / n / 2, side })
              const inGable = [1, 2, n - 3, n - 2].includes(i)
              if (
                !isBalcony &&
                !inGable &&
                dormerSpots.filter((d) => d.side === side).length < dormersPerSide
              )
                dormerSpots.push({ x, side })
            }
            if (!isBalcony) {
              await addWindow(s, o, e, t, { width: winW, height: winH, sillHeight: sill })
              continue
            }
            await addDoor(s, o, e, t, { width: 1.8, height: 2.1, doorType: 'sliding' })
            counts.units++
            const cx = e.a[0] + ux * t * e.len
            const cz = e.a[1] + uz * t * e.len
            const at = (along: number, out: number): Pt => [
              round(cx + ux * along + nx * out, 3),
              round(cz + uz * along + nz * out, 3),
            ]
            const o0 = wall / 2
            const o1 = wall / 2 + balconyD
            const p: Pt[] = [
              at(-balconyW / 2, o0),
              at(balconyW / 2, o0),
              at(balconyW / 2, o1),
              at(-balconyW / 2, o1),
            ]
            const upper = li > 0
            balconySlabs.push({
              op: 'create',
              parentId: levelId,
              node: {
                type: 'slab',
                name: upper ? 'Balcony' : 'Patio',
                polygon: p,
                elevation: upper ? 0.1 : 0.05,
                thickness: upper ? 0.25 : 0.05,
                slots: upper
                  ? { surface: M.balconyDeck, side: M.trim, edge: M.trim }
                  : { surface: M.patio },
                ...(upper
                  ? {
                      railing: [
                        { start: p[1], end: p[2] },
                        { start: p[2], end: p[3] },
                        { start: p[3], end: p[0] },
                      ],
                    }
                  : {}),
                metadata: {
                  basis: 'estimate: one per unit; published: every home has a patio or balcony',
                },
              },
            })
            if (upper) counts.balconies++
            else counts.patios++
            if (li === 0 && stories > 1) {
              const h = (stories - 1) * f2f + 0.1 - 0.25
              const inset = columnSize / 2 + 0.05
              for (const q of [
                at(-balconyW / 2 + inset, o1 - inset),
                at(balconyW / 2 - inset, o1 - inset),
              ]) {
                columns.push({
                  op: 'create',
                  parentId: levelId,
                  node: whiteColumn(q[0], q[1], h, columnSize, 'Balcony column'),
                })
                counts.columns++
              }
            }
          }
        } else {
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n
            if (li === 0 && i === Math.floor(n / 2) && n % 2 === 1) {
              await addDoor(s, o, e, t, {
                width: 1.8,
                height: 2.3,
                doorType: 'double',
                style: 'glass',
              })
              continue
            }
            await addWindow(s, o, e, t, { width: winW, height: winH, sillHeight: sill })
          }
        }
      }
    }
    await s.call('apply_patch', { patches: [...balconySlabs, ...columns] })
    await paintOpenings(s, o)
    counts.windows += o.windows.length
    counts.doors += o.doors.length
    for (let li = 0; li + 1 < stories; li++) {
      await s.call('create_stair', {
        levelId: b.levelIds[li],
        toLevelId: b.levelIds[li + 1],
        x: round(-b.frame.width / 2 + 4.5, 3),
        z: 0,
        rotation: 90,
        width: 1.2,
      })
      counts.stairs++
    }
    // Roof: hip over the bounding rectangle, cross-gables over two bays on each long side, gable dormers.
    const W = b.frame.width + 2 * overhang
    const D = b.frame.depth + 2 * overhang
    const roof = await addRoof(
      s,
      b.levelIds[stories - 1]!,
      { width: W, depth: D, roofType: 'hip', pitch },
      siding,
      `${name} roof`,
    )
    const segPatches = gableSpots.map((g) => {
      const ridge = D / 2
      return {
        op: 'create',
        parentId: roof.roofId,
        node: roofSegment(
          'gable',
          ridge,
          2 * (b.frame.width / Math.max(1, Math.round(b.frame.width / bay))),
          pitch,
          [g.x, 0, g.side * (D / 2 - ridge / 2)],
          Math.PI / 2,
          'Cross gable',
        ),
      }
    })
    counts.gables += segPatches.length
    const { node: main } = await s.call('get_node', { id: roof.roofSegmentId })
    const dormerPatches = dormerSpots.flatMap((d) => {
      const z = d.side * (D / 2 - 2.8)
      const dormer = DormerNode.parse({
        name: 'Gable dormer',
        roofSegmentId: roof.roofSegmentId,
        parentId: roof.roofSegmentId,
        position: [
          round(d.x, 3),
          round(getRoofSegmentSurfaceY(main as RoofSegmentNode, d.x, z), 3),
          round(z, 3),
        ],
        rotation: d.side < 0 ? Math.PI : 0,
        width: 2.0,
        depth: 2.2,
        height: 1.3,
        roofType: 'gable',
        roofHeight: 0.9,
        windowWidth: 0.9,
        windowHeight: 1.0,
        windowOffsetY: 1.75,
        windowColumns: 2,
        windowRows: 2,
        wallMaterialPreset: siding,
        topMaterialPreset: M.shingles,
        sideMaterialPreset: M.trim,
      })
      const win = createDormerDefaultWindow(
        dormer,
        `window_${dormer.id.replace(/^dormer_/, '')}_front`,
        getDormerDefaultWindowFace(dormer, main as RoofSegmentNode),
      )
      counts.dormers++
      return [
        { op: 'create', parentId: roof.roofSegmentId, node: dormer },
        { op: 'create', parentId: dormer.id, node: { ...win, slots: { frame: M.trim } } },
      ]
    })
    await s.call('apply_patch', { patches: [...segPatches, ...dormerPatches] })
  }

  // ---------------------------------------------------------------- clubhouse
  const clubF2f = facts.num('clubhouseFloorToFloor')
  const club = await addShellBuilding(s, root.siteId, {
    id: `wwd_${clubhouseFp.way.id}`,
    name: 'Clubhouse',
    footprint: clubhouseFp.poly,
    stories: facts.num('clubhouseStories'),
    floorToFloor: clubF2f,
    wallThickness: wall,
    provenance: osmRef(clubhouseFp.way.id),
    metadata: {
      footprint: `OSM way ${clubhouseFp.way.id}`,
      stories: 'two-story clubhouse (JLL, 2023)',
    },
  })
  await finishWalls(s, club, M.sidings[0]!, true, 0.25)
  {
    const o: Openings = { windows: [], doors: [], garageDoors: [] }
    const longest = [...club.edges[0]!]
      .sort((a, b) => b.len - a.len)
      .slice(0, 2)
      .map((e) => e.wallId)
    for (let li = 0; li < club.levelIds.length; li++) {
      for (const e of club.edges[li]!) {
        if (e.len < 3.5) continue
        const n = Math.max(1, Math.floor(e.len / 3.6))
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n
          if (li === 0 && longest.includes(e.wallId) && i === Math.floor(n / 2)) {
            await addDoor(s, o, e, t, {
              width: 2.0,
              height: 2.5,
              doorType: 'double',
              style: 'glass',
            })
            continue
          }
          await addWindow(
            s,
            o,
            e,
            t,
            li === 0
              ? { width: 1.6, height: 2.3, sillHeight: 0.5 }
              : { width: 1.3, height: 1.7, sillHeight: 0.8 },
          )
        }
      }
    }
    await paintOpenings(s, o)
    counts.windows += o.windows.length
    counts.doors += o.doors.length
    await s.call('create_stair', {
      levelId: club.levelIds[0],
      toLevelId: club.levelIds[1],
      x: -16,
      z: 0,
      rotation: 90,
      width: 1.2,
    })
    counts.stairs++
    // Hips over the two wings, a cross-gable over the centre block (rectangles of the OSM outline).
    const ov = overhang
    const roof = await addRoof(
      s,
      club.levelIds[club.levelIds.length - 1]!,
      {
        width: 21.8 + 2 * ov,
        depth: 11.6 + 2 * ov,
        roofType: 'hip',
        pitch,
        center: [-10.6, 0, -0.2],
      },
      M.sidings[0]!,
      'Clubhouse roof',
    )
    await s.call('apply_patch', {
      patches: [
        {
          op: 'create',
          parentId: roof.roofId,
          node: roofSegment(
            'hip',
            10.3 + 2 * ov,
            16.85 + 2 * ov,
            pitch,
            [16.25, 0, 1.9],
            0,
            'East wing',
          ),
        },
        {
          op: 'create',
          parentId: roof.roofId,
          node: roofSegment(
            'gable',
            23.7 + 2 * ov,
            11.1 + 2 * ov,
            pitch,
            [5.6, 0, 0],
            Math.PI / 2,
            'Centre gable',
          ),
        },
      ],
    })
  }

  // ---------------------------------------------------------------- cabana (open pergola roof on columns)
  {
    await s.call('apply_patch', {
      patches: [
        {
          op: 'create',
          parentId: root.siteId,
          node: {
            type: 'building',
            id: 'building_wwd_cabana',
            name: 'Cabana',
            position: [round(cabanaC[0], 3), 0, round(cabanaC[1], 3)],
            rotation: [0, 0, 0],
            metadata: { basis: 'published (pool and cabana); size and position estimated' },
          },
        },
      ],
    })
    const lv = await s.call('add_level', {
      buildingId: 'building_wwd_cabana',
      height: 2.8,
      name: 'Cabana',
    })
    const cols: object[] = []
    for (const sx of [-1, 0, 1])
      for (const sz of [-1, 1])
        cols.push({
          op: 'create',
          parentId: lv.levelId,
          node: whiteColumn(
            (sx * (cabanaW - 0.6)) / 2,
            (sz * (cabanaD - 0.6)) / 2,
            2.8,
            0.3,
            'Cabana column',
          ),
        })
    await s.call('apply_patch', {
      patches: [
        ...cols,
        {
          op: 'create',
          parentId: lv.levelId,
          node: {
            type: 'slab',
            name: 'Cabana floor',
            polygon: orientedRect([0, 0], cabanaW, cabanaD, 0),
            elevation: 0.1,
            thickness: 0.1,
            slots: { surface: M.patio },
          },
        },
      ],
    })
    counts.columns += cols.length
    await addRoof(
      s,
      lv.levelId,
      { width: cabanaW + 0.8, depth: cabanaD + 0.8, roofType: 'hip', pitch: 25 },
      M.trim,
      'Cabana roof',
    )
  }

  // ---------------------------------------------------------------- garages and maintenance
  const serviceLines = services.map((r) => parseNorthUp(r.p))
  const distToServices = (p: Pt) =>
    Math.min(
      ...serviceLines.flatMap((l) =>
        l.slice(0, -1).map((a, i) => {
          const b = l[i + 1]!
          const dx = b[0] - a[0]
          const dz = b[1] - a[1]
          const t = Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz)),
          )
          return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dz - p[1])
        }),
      ),
    )
  let garageCount = 0
  for (const { way, poly } of footprints.filter(
    (f) => f.way.role !== 'residential' && f.way.role !== 'clubhouse',
  )) {
    const isGarage = way.role === 'detached garage'
    const name = isGarage ? `Detached garage ${++garageCount}` : 'Maintenance building'
    const siding = isGarage ? M.sidings[2]! : M.sidings[1]!
    const b = await addShellBuilding(s, root.siteId, {
      id: `wwd_${way.id}`,
      name,
      footprint: poly,
      stories: 1,
      floorToFloor: facts.num('accessoryHeight'),
      wallThickness: facts.num('accessoryWall'),
      provenance: osmRef(way.id),
      metadata: { footprint: `OSM way ${way.id}`, role: way.role, height: 'estimate' },
    })
    await finishWalls(s, b, siding, false, 0.18)
    const o: Openings = { windows: [], doors: [], garageDoors: [] }
    const edges = b.edges[0]!
    // Garage doors face the nearer drive.
    const mid = (e: Edge): Pt =>
      toWorld(b.frame, [
        (e.a[0] + e.b[0]) / 2 + (e.b[1] - e.a[1]) / e.len,
        (e.a[1] + e.b[1]) / 2 - (e.b[0] - e.a[0]) / e.len,
      ])
    const longEdges = [...edges].sort((a, b2) => b2.len - a.len).slice(0, 2)
    const front = longEdges.sort((a, b2) => distToServices(mid(a)) - distToServices(mid(b2)))[0]!
    if (isGarage) {
      const n = Math.floor(front.len / 3.4)
      for (let i = 0; i < n; i++)
        await addDoor(
          s,
          o,
          front,
          (i + 0.5) / n,
          { width: 2.7, height: 2.3, doorType: 'garage-sectional' },
          true,
        )
    } else {
      await addDoor(
        s,
        o,
        front,
        0.3,
        { width: 3.0, height: 2.6, doorType: 'garage-sectional' },
        true,
      )
      await addDoor(s, o, front, 0.75, { width: 0.95, height: 2.1, style: 'panel' })
    }
    await paintOpenings(s, o)
    counts.doors += o.doors.length + o.garageDoors.length
    const accPitch = facts.num('accessoryRoofPitch')
    const accOv = facts.num('accessoryOverhang')
    if (isGarage) {
      await addRoof(
        s,
        b.levelIds[0]!,
        {
          width: b.frame.width + 2 * accOv,
          depth: b.frame.depth + 2 * accOv,
          roofType: 'gable',
          pitch: accPitch,
        },
        siding,
        `${name} roof`,
      )
    } else {
      // The L-shaped outline: a gable over each leg.
      const roof = await addRoof(
        s,
        b.levelIds[0]!,
        {
          width: 20.76 + 2 * accOv,
          depth: 4.63 + 2 * accOv,
          roofType: 'gable',
          pitch: accPitch,
          center: [0, 0, -2.8],
        },
        siding,
        `${name} roof`,
      )
      await s.call('apply_patch', {
        patches: [
          {
            op: 'create',
            parentId: roof.roofId,
            node: roofSegment(
              'gable',
              10.23 + 2 * accOv,
              13.46 + 2 * accOv,
              accPitch,
              [3.65, 0, 0],
              Math.PI / 2,
              'Service wing',
            ),
          },
        ],
      })
    }
  }

  // ---------------------------------------------------------------- trees along the drives
  const tree = JSON.parse(readFileSync(join(dir, 'tree-design.json'), 'utf8'))
  const treeSpacing = facts.num('treeSpacing')
  const treeObstacles = [
    ...taken,
    ...walkOuter,
    offsetConvex(orientedRect(cabanaC, cabanaW, cabanaD, 0), 2),
  ]
  const treeSpots: Pt[] = []
  for (const line of serviceLines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]!
      const b = line[i + 1]!
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      for (let d = treeSpacing / 2; d < len; d += treeSpacing) {
        const p: Pt = [a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len]
        for (const side of [1, -1]) {
          for (const offs of [aisle / 2 + stallDepth + 2.5, aisle / 2 + 2.5]) {
            const q: Pt = [
              p[0] - (side * (b[1] - a[1]) * offs) / len,
              p[1] + (side * (b[0] - a[0]) * offs) / len,
            ]
            const box = orientedRect(q, 3, 3, 0)
            if (!insideConvex(q, siteOutline)) continue
            if (treeObstacles.some((o) => convexOverlap(box, o))) continue
            if (treeSpots.some((t) => Math.hypot(t[0] - q[0], t[1] - q[1]) < treeSpacing * 0.8))
              continue
            treeSpots.push(q)
            break
          }
        }
      }
    }
  }
  for (const [i, q] of treeSpots.entries()) {
    await s.call('place_design', {
      design: tree,
      hostId: root.gradeLevelId,
      position: [round(q[0], 2), 0, round(q[1], 2)],
      rotation: round((i * 2.399) % (2 * Math.PI), 3),
      parameters: { height: 8 + ((i * 37) % 50) / 10, spread: 5 + ((i * 53) % 30) / 10 },
      name: 'Shade tree',
    })
  }

  // ---------------------------------------------------------------- cameras
  const resById = new Map(residential.map((r) => [r.way, r]))
  const site = convexHull(hullPoints)
  const cx = (Math.min(...site.map((p) => p[0])) + Math.max(...site.map((p) => p[0]))) / 2
  const cz = (Math.min(...site.map((p) => p[1])) + Math.max(...site.map((p) => p[1]))) / 2
  const typical = resById.get(1518661329)!.b.frame
  const tc: Pt = [typical.position[0], typical.position[2]]
  const tu: Pt = [Math.cos(typical.rotationY), -Math.sin(typical.rotationY)]
  const tn: Pt = [Math.sin(typical.rotationY), Math.cos(typical.rotationY)]
  const v3 = (p: Pt, y: number): Vec3 => [round(p[0], 1), round(y, 1), round(p[1], 1)]
  const cameras = {
    coordinateSystem:
      'Pascal world coordinates: metres, x east, z south, y up; origin lat 40.3138, lon -74.6670 (see osm-extract.json).',
    cameras: {
      aerial: {
        position: v3([cx + 250, cz + 230], 230),
        target: v3([cx, cz], 0),
        fov: 40,
        note: 'High oblique over the whole site from the south-east, like the published aerial rendering (without its roll).',
      },
      entrance: {
        position: v3([181, -93], 1.7),
        target: v3(clubC, 5),
        fov: 55,
        note: 'Eye level where the entry drive (OSM way 1081085603) leaves the community road (OSM way 1011222095), looking south-west to the clubhouse with residential building OSM way 1011222098 on the left.',
      },
      pool: {
        position: v3([poolC[0] - 3, poolC[1] + 14], 1.6),
        target: v3([clubC[0], clubC[1] - 6], 4),
        fov: 60,
        note: 'Eye level on the south-west corner of the pool deck looking north-east past the cabana to the clubhouse and the nearest buildings.',
      },
      street: {
        position: v3([2, -56], 1.6),
        target: v3([62.8, 1.2], 4),
        fov: 55,
        note: 'Eye level on the internal drive OSM way 1081085607 between residential buildings (OSM ways 1011222096 and 1011222097), looking south-east along both balcony facades.',
      },
      'building-close': {
        position: v3([tc[0] + tu[0] * 38 + tn[0] * 46, tc[1] + tu[1] * 38 + tn[1] * 46], 16),
        target: v3(tc, 7),
        fov: 50,
        note: 'Three-quarter view of the typical residential building (OSM way 1518661329), long balcony facade and one end.',
      },
      top: {
        position: v3([cx, cz + 0.01], 650),
        target: v3([cx, cz], 0),
        fov: 45,
        note: 'Plan view, north up (world -z).',
      },
    },
  }
  writeFileSync(join(dir, 'cameras-detailed.json'), `${JSON.stringify(cameras, null, 2)}\n`)

  return {
    file: 'site-detailed.json',
    title: 'Detailed site',
    stats: {
      'Residential buildings': `${residential.length} (4 floors each, estimate), siding colours cycling white / greige / gray / sage, brick ground floor on every ${brickEvery === 2 ? 'second' : `${brickEvery}th`} building`,
      'Balcony doors (one per unit, estimate)': `${counts.units} sliding doors, ${counts.balconies} balconies with railings, ${counts.patios} patios`,
      'Windows and doors modelled': `${counts.windows} windows (paired double-hung look), ${counts.doors} doors`,
      'Balcony and cabana columns': counts.columns,
      'Roof detail': `${counts.gables} cross-gables, ${counts.dormers} gable dormers, grey asphalt shingles`,
      'Stair flights': `${counts.stairs} (one per storey per building, position estimated)`,
      'Estimated surface parking stalls': `${Math.round(stripLength / stallWidth)} (estimate; no public count)`,
      'Trees (procedural design)': `${treeSpots.length} (positions estimated)`,
      'Amenities placed':
        'pool with tiled shell and water, deck, cabana, two pickleball courts, two bocce lanes, bark park (positions estimated)',
    },
    notes: [
      "`verify_scene` notes on this scene, all expected: `opening_not_on_wall` is each dormer's window (a dormer hosts its window on its own face, as the editor's dormer tool makes it, which verify_scene's wall-only check does not know), and `roof_level_occupied` is the roof level of each building with dormers, counted occupied because of those windows. `zones_no_ceilings` comes from the grade level, which holds site paving and no rooms.",
      'Cameras for this scene are in `cameras-detailed.json` (Pascal world coordinates).',
    ],
  }
}
