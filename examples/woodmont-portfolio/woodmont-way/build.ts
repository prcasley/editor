// Woodmont Way, West Windsor NJ: the site massing and one typical residential building.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Facts } from '../lib/facts'
import {
  area,
  convexHull,
  convexOverlap,
  offsetConvex,
  type Pt,
  parseNorthUp,
  polylineLength,
  polylineQuads,
  rect,
  round,
  SQFT_PER_SQM,
  SQM_PER_ACRE,
  sideStrip,
} from '../lib/geometry'
import { addMass, addSlabs, addZones, type SlabSpec, startScene } from '../lib/massing'
import type { PascalSession } from '../lib/session'
import type { SceneOutput } from '../lib/types'

type OsmWay = { id: number; tag: string; role?: string; name?: string; p: string }
type OsmExtract = { buildings: OsmWay[]; pools: OsmWay[]; roads: OsmWay[] }

/** Per-building story corrections, keyed by OSM way id, for when better evidence turns up. */
const storiesByWay: Record<number, number> = {}

const ASPHALT = '#3d3f42'
const STREET = '#2f3133'
const DECK = '#cdbfa8'
const WATER = '#3fa7c9'
const ROOF_SHINGLES = 'library:roof-greyshingles'

const osmRef = (id: number) => ({
  refs: [{ ns: 'osm', id: `way/${id}`, role: 'primary' as const }],
})

export async function buildSiteMassing(
  s: PascalSession,
  facts: Facts,
  dir: string,
): Promise<SceneOutput> {
  const osm = JSON.parse(readFileSync(join(dir, 'osm-extract.json'), 'utf8')) as OsmExtract
  const f2f = facts.num('floorToFloor')
  const stories = facts.num('residentialStories')
  const wall = facts.num('exteriorWall')
  const overhang = facts.num('roofOverhang')
  const pitch = facts.num('roofPitch')
  facts.get('footprints')
  facts.get('buildingCount')
  facts.get('residentialBuildingCount')
  facts.get('units')

  const footprints = osm.buildings.map((b) => ({ way: b, poly: parseNorthUp(b.p) }))
  const pool = parseNorthUp(osm.pools[0]!.p)
  const services = osm.roads.filter((r) => r.tag === 'highway=service' && !r.name)
  const streets = osm.roads.filter((r) => r.tag !== 'highway=service' || r.name)

  // Site outline: an estimate (see facts siteOutlineOffset).
  const hullPoints: Pt[] = [
    ...footprints.flatMap((f) => f.poly),
    ...pool,
    ...services.flatMap((r) => parseNorthUp(r.p)),
  ]
  const siteOutline = offsetConvex(convexHull(hullPoints), facts.num('siteOutlineOffset'))
  const siteAcres = area(siteOutline) / SQM_PER_ACRE

  const root = await startScene(s, {
    name: 'Woodmont Way, West Windsor NJ (site massing)',
    polygon: siteOutline,
    address: { street: facts.str('address'), city: 'West Windsor', state: 'NJ' },
    metadata: {
      basis:
        'Outline is an estimate: convex hull of mapped buildings, pool and drives plus 8 m. Published site area: 23 acres (Community News, 2018).',
      outlineAcres: round(siteAcres, 1),
      publishedAcres: facts.num('siteAcres'),
    },
  })

  // Buildings.
  let residentialGfaSqm = 0
  let residentialCount = 0
  let garageCount = 0
  for (const { way, poly } of footprints) {
    const seed = `ww_${way.id}`
    if (way.role === 'residential') {
      residentialCount++
      const st = storiesByWay[way.id] ?? stories
      residentialGfaSqm += area(poly) * st
      await addMass(
        s,
        root.siteId,
        {
          name: `Residential building ${residentialCount}`,
          footprint: poly,
          stories: st,
          floorToFloor: f2f,
          wallThickness: wall,
          roof: { type: 'hip', pitch, overhang, material: ROOF_SHINGLES },
          provenance: osmRef(way.id),
          metadata: {
            footprint: `OSM way ${way.id}`,
            stories: storiesByWay[way.id] ? 'per-building correction' : 'estimate (see facts.md)',
            floorToFloor: 'estimate',
            roof: 'hip, pitch estimated',
          },
        },
        seed,
      )
    } else if (way.role === 'clubhouse') {
      facts.get('clubhouseRoof')
      await addMass(
        s,
        root.siteId,
        {
          name: 'Clubhouse',
          footprint: poly,
          stories: facts.num('clubhouseStories'),
          floorToFloor: facts.num('clubhouseFloorToFloor'),
          wallThickness: wall,
          roof: { type: 'hip', pitch, overhang, material: ROOF_SHINGLES },
          provenance: osmRef(way.id),
          metadata: {
            footprint: `OSM way ${way.id}`,
            stories: 'two-story clubhouse (JLL, 2023)',
            floorToFloor: 'estimate',
          },
        },
        seed,
      )
    } else {
      const name =
        way.role === 'detached garage' ? `Detached garage ${++garageCount}` : 'Maintenance building'
      await addMass(
        s,
        root.siteId,
        {
          name,
          footprint: poly,
          stories: 1,
          floorToFloor: facts.num('accessoryHeight'),
          wallThickness: facts.num('accessoryWall'),
          roof: {
            type: 'gable',
            pitch: facts.num('accessoryRoofPitch'),
            overhang: facts.num('accessoryOverhang'),
            material: ROOF_SHINGLES,
          },
          provenance: osmRef(way.id),
          metadata: { footprint: `OSM way ${way.id}`, role: way.role, height: 'estimate' },
        },
        seed,
      )
    }
  }

  // Pool, deck and cabana.
  const deckOffset = facts.num('poolDeck')
  const deck = offsetConvex(convexHull(pool), deckOffset)
  facts.get('pool')
  facts.get('cabana')
  const poolZs = pool.map((p) => p[1])
  const poolXs = pool.map((p) => p[0])
  const poolCx = (Math.min(...poolXs) + Math.max(...poolXs)) / 2
  const [cabanaW, cabanaD] = facts.dims('cabana')
  const cabana = rect(poolCx, Math.min(...poolZs) - deckOffset + cabanaD / 2, cabanaW, cabanaD)
  const slabs: SlabSpec[] = [
    {
      name: 'Pool deck',
      polygon: deck,
      color: DECK,
      elevation: 0.05,
      thickness: 0.05,
      metadata: { basis: 'estimate: pool outline + 6 m' },
    },
    {
      name: 'Swimming pool',
      polygon: pool,
      color: WATER,
      elevation: -facts.num('poolDepth'),
      thickness: 0.2,
      recessed: true,
      metadata: { basis: 'OSM way 1375161104 (leisure=swimming_pool); depth estimated' },
    },
    {
      name: 'Cabana (open pergola)',
      polygon: cabana,
      color: '#efece6',
      elevation: 0.12,
      thickness: 0.07,
      metadata: { basis: 'published (pool and cabana); size and position estimated' },
    },
  ]

  // Streets: OSM centrelines with an estimated paving width.
  const streetWidth = facts.num('streetWidth')
  for (const r of streets) {
    for (const q of polylineQuads(parseNorthUp(r.p), streetWidth)) {
      slabs.push({
        name: r.name ?? 'Street',
        polygon: q,
        color: STREET,
        elevation: 0.01,
        thickness: 0.01,
        metadata: { basis: `OSM way ${r.id} centreline (${r.tag}); width estimated` },
      })
    }
  }

  // Drive aisles and the stall strips that clear every building, the pool and its deck.
  const aisle = facts.num('driveAisleWidth')
  const stallDepth = facts.num('stallDepth')
  const stallWidth = facts.num('stallWidth')
  const obstacles = [...footprints.map((f) => convexHull(f.poly)), deck]
  const chunk = 4 * stallWidth
  let stripLength = 0
  for (const r of services) {
    const line = parseNorthUp(r.p)
    for (const q of polylineQuads(line, aisle)) {
      slabs.push({
        name: 'Drive aisle',
        polygon: q,
        color: ASPHALT,
        elevation: 0.015,
        thickness: 0.01,
        metadata: { basis: `OSM way ${r.id} centreline (highway=service); width estimated` },
      })
    }
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]!
      const b = line[i + 1]!
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const pieces = Math.floor(len / chunk)
      for (let k = 0; k < pieces; k++) {
        const t0 = (k * chunk) / len
        const t1 = ((k + 1) * chunk) / len
        const p0: Pt = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]
        const p1: Pt = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]
        for (const side of [1, -1] as const) {
          const strip = sideStrip(p0, p1, aisle / 2, stallDepth, side)
          if (obstacles.some((o) => convexOverlap(strip, o))) continue
          stripLength += chunk
          slabs.push({
            name: 'Parking stalls (estimated)',
            polygon: strip,
            color: ASPHALT,
            elevation: 0.015,
            thickness: 0.01,
            metadata: {
              basis: 'estimate: 4 perpendicular stalls beside an OSM service-road aisle',
            },
          })
        }
      }
    }
  }
  await addSlabs(s, root.gradeLevelId, slabs)
  const stalls = Math.round(stripLength / stallWidth)

  await addZones(s, root.gradeLevelId, [
    {
      label: 'Site outline (estimate)',
      polygon: siteOutline,
      properties: { basis: 'convex hull of mapped features + 8 m; not a parcel survey' },
    },
    {
      label: 'Cabana (estimated position)',
      polygon: cabana,
      properties: { basis: 'published amenity; size and position estimated' },
    },
  ])

  const resGfaSf = residentialGfaSqm * SQFT_PER_SQM
  return {
    file: 'site-massing.json',
    title: 'Site massing',
    stats: {
      'Residential buildings modelled': residentialCount,
      'All buildings modelled (incl. clubhouse, garages, maintenance)': footprints.length,
      'Residential gross floor area (footprint x stories)': `${Math.round(resGfaSf).toLocaleString('en-US')} SF (estimate)`,
      'Gross SF per unit implied (443 units)': `${Math.round(resGfaSf / facts.num('units')).toLocaleString('en-US')} SF (estimate)`,
      'Site outline area': `${round(siteAcres, 1)} acres (estimate; published 23 acres)`,
      'Estimated surface parking stalls': `${stalls} (estimate; no public count)`,
      'Internal drives (OSM service-road centrelines)': `${Math.round(services.reduce((t, r) => t + polylineLength(parseNorthUp(r.p)), 0))} m`,
    },
    notes: [
      "`verify_scene`'s `walls_no_doors` and `missing_stair` are expected here: a massing building is a stack of story shells with no doors or stairs (the typical building has both). `zones_no_ceilings` comes from the site zones on the grade level.",
    ],
  }
}

/**
 * One residential building, OSM way 1518661329, in its own axes: four floors of
 * units on a double-loaded corridor, a sliding door to a balcony (a patio at
 * grade) for every unit, window rhythm on every exterior wall, and a hip roof.
 */
export async function buildTypicalBuilding(
  s: PascalSession,
  facts: Facts,
  dir: string,
): Promise<SceneOutput> {
  const osm = JSON.parse(readFileSync(join(dir, 'osm-extract.json'), 'utf8')) as OsmExtract
  facts.get('typicalBuilding')
  facts.get('patioOrBalcony')
  facts.get('ceilingHeight')
  facts.get('doors')
  const way = osm.buildings.find((b) => b.id === 1518661329)!
  const poly = parseNorthUp(way.p)
  const L = Math.max(
    ...poly.map((p, i) => Math.hypot(poly[(i + 1) % 4]![0] - p[0], poly[(i + 1) % 4]![1] - p[1])),
  )
  const D = area(poly) / L
  const W2 = round(L / 2, 3)
  const D2 = round(D / 2, 3)
  const stories = facts.num('residentialStories')
  const f2f = facts.num('floorToFloor')
  const perSide = facts.num('unitsPerFloor') / 2
  const c2 = facts.num('corridorWidth') / 2
  const wall = facts.num('exteriorWall')
  const stairW = facts.num('stairHall')

  const root = await startScene(s, {
    name: 'Woodmont Way typical residential building (OSM way 1518661329)',
    polygon: rect(0, 0, L + 30, D + 30),
    address: { city: 'West Windsor', state: 'NJ' },
    metadata: {
      basis:
        'Footprint is OSM way 1518661329 rotated into its own axes; plan, units, openings and balconies are estimates.',
    },
  })
  // This scene's only building is the residential one: the default building and level take it.
  await s.call('apply_patch', {
    patches: [
      {
        op: 'update',
        id: root.gradeBuildingId,
        data: {
          name: 'Residential building (typical)',
          provenance: osmRef(way.id),
          metadata: {
            footprint: `OSM way ${way.id}, ${round(L, 1)} x ${round(D, 1)} m`,
            stories: 'estimate',
            units: 'estimate',
          },
        },
      },
      { op: 'update', id: root.gradeLevelId, data: { name: 'Ground floor', height: f2f } },
    ],
  })

  const levelIds = [root.gradeLevelId]
  for (let i = 1; i < stories; i++) {
    const lv = await s.call('add_level', {
      buildingId: root.gradeBuildingId,
      height: f2f,
      name: `Floor ${i + 1}`,
    })
    levelIds.push(lv.levelId)
  }

  const [winW, winH] = facts.dims('windows')
  const win = { width: winW, height: winH, sillHeight: 0.6, style: 'double-hung' }
  const [balconyW, balconyD] = facts.dims('balcony')
  let unitCount = 0
  let windowCount = 0
  let balconyCount = 0
  for (let li = 0; li < levelIds.length; li++) {
    const levelId = levelIds[li]!
    const corridor = await s.call('create_room', {
      levelId,
      name: 'Corridor',
      polygon: [
        [-W2, -c2],
        [W2, -c2],
        [W2, c2],
        [-W2, c2],
      ],
      wallThickness: wall,
      ...(li === 0
        ? {
            doors: [
              { wallIndex: 1, width: 1.8, height: 2.3, style: 'glass' },
              { wallIndex: 3, width: 1.8, height: 2.3, style: 'glass' },
            ],
          }
        : {}),
    })
    if (li === 0 && corridor.doorIds.length !== 2) throw new Error('entry doors were skipped')
    // Stair halls at both ends of the north side, each with a window on the gable wall.
    for (const west of [true, false]) {
      const xa = west ? -W2 : W2 - stairW
      const xb = west ? -W2 + stairW : W2
      const hall = await s.call('create_room', {
        levelId,
        name: 'Stair',
        polygon: [
          [round(xa, 3), -D2],
          [round(xb, 3), -D2],
          [round(xb, 3), -c2],
          [round(xa, 3), -c2],
        ],
        wallThickness: wall,
        doors: [{ wallIndex: 2, t: 0.5, width: 0.95, style: 'glass' }],
        windows: [{ wallIndex: west ? 3 : 1, t: 0.5, ...win }],
      })
      windowCount += hall.windowIds.length
    }
    const outdoor: SlabSpec[] = []
    for (const north of [true, false]) {
      // North units sit between the stair halls; south units run the full length.
      const start = north ? -W2 + stairW : -W2
      const unitW = north ? (L - 2 * stairW) / perSide : L / perSide
      for (let u = 0; u < perSide; u++) {
        const x0 = round(start + u * unitW, 3)
        const x1 = round(start + (u + 1) * unitW, 3)
        // North units: edge 0 is the facade, edge 2 the corridor. South units: the reverse.
        const polygon: Pt[] = north
          ? [
              [x0, -D2],
              [x1, -D2],
              [x1, -c2],
              [x0, -c2],
            ]
          : [
              [x0, c2],
              [x1, c2],
              [x1, D2],
              [x0, D2],
            ]
        const facade = north ? 0 : 2
        const corridorEdge = north ? 2 : 0
        const windows = [
          { wallIndex: facade, t: 0.18, ...win },
          { wallIndex: facade, t: 0.82, ...win },
        ]
        if (!north && u === 0)
          windows.push({ wallIndex: 3, t: 0.3, ...win }, { wallIndex: 3, t: 0.7, ...win })
        if (!north && u === perSide - 1)
          windows.push({ wallIndex: 1, t: 0.3, ...win }, { wallIndex: 1, t: 0.7, ...win })
        const unit = await s.call('create_room', {
          levelId,
          name: `Unit ${li + 1}${String.fromCharCode(65 + (north ? u : perSide + u))}`,
          polygon,
          wallThickness: wall,
          doors: [{ wallIndex: corridorEdge, t: 0.5, width: 0.95, style: 'panel' }],
          windows,
        })
        unitCount++
        windowCount += unit.windowIds.length
        if (unit.skippedOpenings?.length)
          throw new Error(`openings skipped: ${JSON.stringify(unit.skippedOpenings)}`)
        await s.call('add_door', {
          wallId: unit.wallIds[facade],
          t: 0.5,
          width: 1.8,
          height: 2.1,
          doorType: 'sliding',
        })
        // Balcony (upper floors) or patio (ground floor) outside the sliding door.
        const cx = (x0 + x1) / 2
        const out = north ? -1 : 1
        const z0 = out * (D2 + wall / 2)
        const z1 = out * (D2 + wall / 2 + balconyD)
        const p: Pt[] = [
          [round(cx - balconyW / 2, 3), round(z0, 3)],
          [round(cx + balconyW / 2, 3), round(z0, 3)],
          [round(cx + balconyW / 2, 3), round(z1, 3)],
          [round(cx - balconyW / 2, 3), round(z1, 3)],
        ]
        balconyCount++
        outdoor.push({
          name: li === 0 ? 'Patio' : 'Balcony',
          polygon: p,
          color: li === 0 ? '#bdb6aa' : '#d9d4cb',
          elevation: li === 0 ? 0.03 : 0.05,
          thickness: li === 0 ? 0.03 : 0.2,
          metadata: {
            basis: 'estimate: one per unit (published: every home has a patio or balcony)',
          },
        })
      }
    }
    await s.call('apply_patch', {
      patches: outdoor.map((o) => ({
        op: 'create',
        parentId: levelId,
        node: {
          type: 'slab',
          name: o.name,
          polygon: o.polygon,
          elevation: o.elevation,
          thickness: o.thickness,
          slots: { surface: o.color },
          metadata: o.metadata,
          ...(o.name === 'Balcony'
            ? {
                railing: [
                  { start: o.polygon[1], end: o.polygon[2] },
                  { start: o.polygon[2], end: o.polygon[3] },
                  { start: o.polygon[3], end: o.polygon[0] },
                ],
              }
            : {}),
        },
      })),
    })
  }

  // A switchback flight per storey in each stair hall: up toward the facade, then back.
  let stairCount = 0
  for (let li = 0; li + 1 < levelIds.length; li++) {
    for (const x of [-W2 + stairW / 2, W2 - stairW / 2]) {
      const towardFacade = li % 2 === 0
      await s.call('create_stair', {
        levelId: levelIds[li],
        toLevelId: levelIds[li + 1],
        x: round(x, 3),
        z: round(towardFacade ? -c2 - 0.4 : -D2 + 0.4, 3),
        rotation: towardFacade ? 180 : 0,
        width: 1.2,
      })
      stairCount++
    }
  }

  const overhang = facts.num('roofOverhang')
  await s.call('create_roof', {
    levelId: levelIds[levelIds.length - 1],
    width: round(L + 2 * overhang, 3),
    depth: round(D + 2 * overhang, 3),
    roofType: 'hip',
    pitch: facts.num('roofPitch'),
    overhang: 0,
    materialPreset: ROOF_SHINGLES,
    name: 'Hip roof',
  })

  return {
    file: 'typical-building.json',
    title: 'Typical residential building',
    stats: {
      Footprint: `${round(L, 1)} x ${round(D, 1)} m (OSM way 1518661329)`,
      Floors: `${stories} (estimate)`,
      'Units modelled': `${unitCount} (estimate: ${perSide * 2} per floor)`,
      'Windows modelled': windowCount,
      'Balconies and patios': `${balconyCount} (one per unit)`,
      'Stair flights': `${stairCount} (two stair halls, estimate)`,
    },
  }
}
