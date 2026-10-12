// Red Mountain (Hendrickson Construction), Aspen CO: three stories of bronze-framed glass
// between sandstone piers, cantilevered slabs with glass rails, deep cedar soffits, a flat
// roof and two stone chimneys. Rebuilt from facts.json through Pascal MCP tool calls only.
//
//   bun run --cwd packages/mcp build     # once: the MCP server's dist
//   bun examples/red-mountain/build.ts
//
// Plan frame: x runs along the front, z is depth, the front faces +z (Pascal south), y up.
// facts.json holds the earlier reading in feet; everything is converted to metres here.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBuildJson } from '@pascal-app/core'
import { Facts } from '../woodmont-portfolio/lib/facts'
import { renderFactsMd, type SceneCheck } from '../woodmont-portfolio/lib/report'
import { openSession, type PascalSession } from '../woodmont-portfolio/lib/session'
import type { SceneOutput } from '../woodmont-portfolio/lib/types'

type Pt = [number, number]
type Extent = { x0: number; x1: number; z0: number; z1: number }

const FT = 0.3048
const m = (ft: number) => Math.round(ft * FT * 10000) / 10000
const mp = ([x, z]: Pt): Pt => [m(x), m(z)]
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

// Light sandstone ledgestone: the library's flooring-wallstone1 texture renders as orange-brown
// rusty stone, so sandstone.jpg recolours that same texture's luminance onto a tan-cream ramp
// (#b58a5c courses, #d9bf93 to #e2cba2 faces). It travels as a scene material with a
// data:image albedo; no MCP tool writes the scene material table, so it is added to the
// exported file and the slots reference it as scene:mat_sandstone.
const SANDSTONE: { id: `mat_${string}`; name: string; material: Record<string, unknown> } = {
  id: 'mat_sandstone',
  name: 'Sandstone ledgestone (light)',
  material: {
    preset: 'custom',
    properties: {
      color: '#ffffff',
      roughness: 0.88,
      metalness: 0,
      opacity: 1,
      transparent: false,
      side: 'front',
    },
    texture: {
      url: `data:image/jpeg;base64,${readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sandstone.jpg')).toString('base64')}`,
      repeat: [1, 1],
    },
  },
}

// Library finishes. Each is refused by the server if the id is not in the catalog.
const MAT = {
  stone: `scene:${SANDSTONE.id}`, // walls, piers, retaining wall, terrace edges
  plaster: 'library:concrete-plaster', // interior wall faces
  cedar: 'library:siding-lap-cedar', // tongue-and-groove soffits
  bronze: 'library:preset-espresso', // window frames, door frames, fascias, rail caps
  glass: 'library:preset-glass', // glazing and rail infill
  pavers: 'library:flooring-tile79', // terrace and balcony pavers
  roof: 'library:preset-charcoal', // low-slope roof membrane
}
const LAWN = '#55703f' // the catalog has no grass finish

// ---------------------------------------------------------------- fact parsing

function extentOf(text: string): Extent {
  const r = text.match(/x\s*(-?[\d.]+)\.\.(-?[\d.]+),\s*z\s*(-?[\d.]+)\.\.(-?[\d.]+)/)
  if (!r) throw new Error(`not an extent: ${text}`)
  return { x0: +r[1]!, x1: +r[2]!, z0: +r[3]!, z1: +r[4]! }
}
const numbers = (text: string) => [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((r) => Number(r[0]))
const pairs = (text: string): [number, number][] =>
  [...text.matchAll(/(\d+(?:\.\d+)?)\+(\d+(?:\.\d+)?)/g)].map((r) => [+r[1]!, +r[2]!])
function slabOf(text: string) {
  const r = text.match(/(?:top|base)\s*(-?[\d.]+),\s*([\d.]+)\s*thick/)
  if (!r) throw new Error(`no top/thickness: ${text}`)
  return { ...extentOf(text), top: +r[1]!, thick: +r[2]! }
}
const rect = (e: Extent): Pt[] => [
  [e.x0, e.z0],
  [e.x1, e.z0],
  [e.x1, e.z1],
  [e.x0, e.z1],
]
const rectM = (e: Extent): Pt[] => rect(e).map(mp)
const inset = (e: Extent, d: number): Extent => ({
  x0: e.x0 + d,
  x1: e.x1 - d,
  z0: e.z0 + d,
  z1: e.z1 - d,
})

// ---------------------------------------------------------------- facades

/** A run of glass on one facade: world endpoints in feet, on the facade's outer line. */
type GlassSpan = { a: Pt; b: Pt; panels: number; basis: string; door?: boolean }

/**
 * Glass between piers on a facade from `a` to `b` (feet). Piers are [offset, width] from `a`;
 * each gap between piers (and the facade ends) becomes one glass run of `panelFt` panels.
 */
function spansFromPiers(a: Pt, b: Pt, piers: [number, number][], panelFt: number): GlassSpan[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const d: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
  const at = (u: number): Pt => [a[0] + d[0] * u, a[1] + d[1] * u]
  const sorted = [...piers].sort((p, q) => p[0] - q[0])
  const gaps: [number, number][] = []
  let u = 0
  for (const [o, w] of sorted) {
    if (o - u > 1) gaps.push([u, o])
    u = Math.max(u, o + w)
  }
  if (len - u > 1) gaps.push([u, len])
  return gaps.map(([u0, u1]) => ({
    a: at(u0),
    b: at(u1),
    panels: Math.max(1, Math.round((u1 - u0) / panelFt)),
    basis: 'read from the hero photo (earlier reading)',
  }))
}

/** Invented glass on facades no photo shows: "x a..b, c..d" along a line of constant z or x. */
function inventedSpans(spec: string, facade: string, line: number, panelFt: number): GlassSpan[] {
  const part = spec.split(';').find((p) => p.trim().startsWith(facade))
  if (!part) throw new Error(`invented facade ${facade} missing`)
  const axis = part.trim().slice(facade.length).trim()[0] as 'x' | 'z'
  return [...part.matchAll(/(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)/g)].map((r) => {
    const [u0, u1] = [+r[1]!, +r[2]!]
    const pt = (u: number): Pt => (axis === 'x' ? [u, line] : [line, u])
    return {
      a: pt(u0),
      b: pt(u1),
      panels: Math.max(1, Math.round(Math.abs(u1 - u0) / panelFt)),
      basis: 'invented (facade not in any published photo)',
    }
  })
}

type WallInfo = {
  id: string
  start: Pt
  end: Pt
  length: number
  thickness: number
  resolvedHeight: number
}

/** The wall whose centreline carries a span's midpoint, and the span's position on it. */
function hostWall(walls: WallInfo[], span: GlassSpan, endMargin: number) {
  const a = mp(span.a)
  const b = mp(span.b)
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  for (const w of walls) {
    const dx = w.end[0] - w.start[0]
    const dz = w.end[1] - w.start[1]
    const len = Math.hypot(dx, dz)
    const along = ((mid[0] - w.start[0]) * dx + (mid[1] - w.start[1]) * dz) / (len * len)
    const off = Math.abs((mid[0] - w.start[0]) * dz - (mid[1] - w.start[1]) * dx) / len
    const sx = Math.abs(((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / len)
    if (off > w.thickness / 2 + 0.02 || sx > 0.01 || along <= 0 || along >= 1) continue
    const ua = ((a[0] - w.start[0]) * dx + (a[1] - w.start[1]) * dz) / len
    const ub = ((b[0] - w.start[0]) * dx + (b[1] - w.start[1]) * dz) / len
    const lo = Math.max(Math.min(ua, ub), endMargin)
    const hi = Math.min(Math.max(ua, ub), len - endMargin)
    return { wall: w, lo, hi, len }
  }
  throw new Error(`no wall carries the span ${JSON.stringify(span)}`)
}

/** Adds an opening as tall as its wall allows, retrying with the overrun the server reports. */
async function tallOpening(
  s: PascalSession,
  tool: 'add_window' | 'add_door',
  args: Record<string, unknown>,
  height: number,
) {
  let h = height
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return { result: await s.call(tool, { ...args, height: round(h) }), height: h }
    } catch (e) {
      const over = String(e).match(/exceeds its wall top by ([\d.]+) m/)
      if (!over) throw e
      h -= Number(over[1]) + 0.003
    }
  }
  throw new Error(`${tool} never fit under its wall`)
}

// ---------------------------------------------------------------- the scene

async function buildRedMountain(s: PascalSession, facts: Facts): Promise<SceneOutput> {
  const L1 = extentOf(facts.str('level1'))
  const wing = extentOf(facts.str('wing'))
  const L2 = extentOf(facts.str('level2'))
  const L3 = extentOf(facts.str('level3'))
  const [h1, h2, h3] = numbers(facts.str('floorToFloor')) as [number, number, number]
  const [t1, t2, t3] = numbers(facts.str('wallThickness')).map(m) as [number, number, number]
  const slab1 = slabOf(facts.str('slab1'))
  const slab2 = slabOf(facts.str('slab2'))
  const wingDeck = slabOf(facts.str('wingDeck'))
  const roof = slabOf(facts.str('roof'))
  const panelFt = facts.num('panelWidth')
  const railH = m(facts.num('railHeight'))
  const head = facts.num('windowHead')
  const invented = facts.str('invented')
  facts.get('stories')
  facts.get('location')
  facts.get('interiors')
  facts.get('stairs')

  // The default site, building and ground level become the house.
  const scene = await s.call('get_scene')
  const all = Object.values(scene.nodes) as { id: string; type: string }[]
  const siteId = all.find((n) => n.type === 'site')!.id
  const buildingId = all.find((n) => n.type === 'building')!.id
  const level1 = all.find((n) => n.type === 'level')!.id
  const lawn = extentOf(facts.str('lawn'))
  await s.call('apply_patch', {
    patches: [
      {
        op: 'update',
        id: siteId,
        data: {
          name: 'Red Mountain, Aspen CO',
          polygon: { type: 'polygon', points: rectM(lawn) },
          address: { city: 'Aspen', state: 'CO' },
          metadata: {
            basis: 'Site outline is an estimate sized to the camera views; no parcel is published.',
          },
        },
      },
      {
        op: 'update',
        id: buildingId,
        data: {
          name: 'Red Mountain residence (Hendrickson Construction)',
          metadata: {
            builder: 'Hendrickson Construction',
            source: 'https://hendricksoninc.com/our-work/red-mountain/',
            basis:
              'Massing read from the builder hero photo by an earlier build; back and far-left facades and all interiors are invented. Not the CCY Architects house of the same name.',
          },
        },
      },
      { op: 'update', id: level1, data: { name: 'Level 1', height: m(h1) } },
    ],
  })
  const level2 = (await s.call('add_level', { buildingId, height: m(h2), name: 'Level 2' }))
    .levelId as string
  const level3 = (await s.call('add_level', { buildingId, height: m(h3), name: 'Level 3' }))
    .levelId as string

  // Story shells on the wall centrelines: the facts give outer faces.
  const shellFootprint = (pts: Pt[], t: number): Pt[] => {
    // Rectilinear outline: each corner moves inward by t/2 along both of its edges' normals.
    const n = pts.length
    let twiceArea = 0
    for (let i = 0; i < n; i++) {
      const [x0, z0] = pts[i]!
      const [x1, z1] = pts[(i + 1) % n]!
      twiceArea += x0 * z1 - x1 * z0
    }
    const side = twiceArea > 0 ? 1 : -1
    const normal = (a: Pt, b: Pt): Pt => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      return [(side * -(b[1] - a[1])) / len, (side * (b[0] - a[0])) / len]
    }
    return pts.map((p, i) => {
      const n1 = normal(pts[(i + n - 1) % n]!, p)
      const n2 = normal(p, pts[(i + 1) % n]!)
      return [
        round(p[0] + ((n1[0] + n2[0]) * t) / 2, 4),
        round(p[1] + ((n1[1] + n2[1]) * t) / 2, 4),
      ] as Pt
    })
  }
  const l1Outline: Pt[] = [
    [wing.x0, wing.z0],
    [L1.x0, wing.z0],
    [L1.x0, L1.z0],
    [L1.x1, L1.z0],
    [L1.x1, L1.z1],
    [wing.x0, L1.z1],
  ]
  await s.call('create_story_shell', {
    levelId: level1,
    footprint: shellFootprint(l1Outline.map(mp), t1),
    wallThickness: t1,
    slabElevation: 0.05,
    namePrefix: 'Level 1',
  })
  await s.call('create_story_shell', {
    levelId: level2,
    footprint: shellFootprint(rectM(L2), t2),
    wallThickness: t2,
    slabElevation: 0.05,
    namePrefix: 'Level 2',
  })
  await s.call('create_story_shell', {
    levelId: level3,
    footprint: shellFootprint(rectM(L3), t3),
    wallThickness: t3,
    slabElevation: 0.05,
    namePrefix: 'Level 3',
  })

  // Cantilevered slabs: bronze fascia slab, cedar soffit just under it.
  type Deck = { name: string; levelId: string; slab: ReturnType<typeof slabOf>; hole?: Extent }
  const decks: Deck[] = [
    { name: 'Level 2 balcony slab', levelId: level2, slab: slab1, hole: L2 },
    { name: 'Wing roof deck', levelId: level2, slab: wingDeck },
    { name: 'Level 3 balcony slab', levelId: level3, slab: slab2, hole: L3 },
  ]
  const deckIds: Record<string, string> = {}
  for (const d of decks) {
    const thick = m(d.slab.thick)
    const holes = d.hole ? [rectM(d.hole)] : []
    const res = await s.call('apply_patch', {
      patches: [
        {
          op: 'create',
          parentId: d.levelId,
          node: {
            type: 'slab',
            name: d.name,
            polygon: rectM(d.slab),
            holes,
            elevation: 0,
            thickness: thick,
            slots: { surface: MAT.pavers, side: MAT.bronze },
            metadata: { basis: 'read from the hero photo (earlier reading)', role: 'cantilever' },
          },
        },
        {
          op: 'create',
          parentId: d.levelId,
          node: {
            type: 'slab',
            name: `${d.name} soffit`,
            polygon: rectM(inset(d.slab, 0.08)),
            holes,
            elevation: round(-thick - 0.001, 4),
            thickness: 0.02,
            slots: { surface: MAT.cedar, side: MAT.cedar },
            metadata: { basis: 'cedar tongue-and-groove soffit (hero photo)', role: 'soffit' },
          },
        },
      ],
    })
    deckIds[d.name] = res.createdIds[0]
  }

  // Interior rooms (invented) and the stair hall that stacks through all three floors.
  // Room edges that lie on a storey's outer face move onto that shell wall's centreline.
  const room = (
    levelId: string,
    name: string,
    e: Extent,
    outer: Extent,
    t: number,
    doorEdge: number,
    doorT = 0.5,
  ) => {
    const snap = (v: number, lo: number, hi: number) =>
      v === lo ? m(v) + t / 2 : v === hi ? m(v) - t / 2 : m(v)
    const x0 = snap(e.x0, outer.x0, outer.x1)
    const x1 = snap(e.x1, outer.x0, outer.x1)
    const z0 = snap(e.z0, outer.z0, outer.z1)
    const z1 = snap(e.z1, outer.z0, outer.z1)
    return s.call('create_room', {
      levelId,
      name,
      polygon: [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ].map(([x, z]) => [round(x!, 4), round(z!, 4)]),
      wallThickness: 0.15,
      doors: [{ wallIndex: doorEdge, t: doorT, width: 1.0, height: 2.4, style: 'modern' }],
    })
  }
  const hall = (z0: number): Extent => ({ x0: -6, x1: 6, z0, z1: 2 })
  // The guest wing's partition stands behind the first main-block pier, clear of the glass.
  const wingPartition = L1.x0 + pairs(facts.str('frontPiersL1'))[2]![1] / 2
  const wingOuter: Extent = { ...wing, x1: wingPartition }
  // Polygon edge 2 runs (x1, z1) -> (x0, z1): the side facing the front.
  await room(level1, 'Stair hall', hall(L1.z0), L1, t1, 2)
  await room(level1, 'Kitchen', { x0: L1.x0, x1: -6, z0: L1.z0, z1: wing.z0 }, L1, t1, 2)
  await room(level1, 'Guest wing', wingOuter, { ...wingOuter, x1: Number.NaN }, t1, 1, 0.3)
  await room(level2, 'Stair hall', hall(L2.z0), L2, t2, 2)
  await room(level2, 'Bedroom', { x0: L2.x0, x1: -6, z0: L2.z0, z1: -8 }, L2, t2, 2)
  await room(level2, 'Primary suite', { x0: 6, x1: L2.x1, z0: L2.z0, z1: -6 }, L2, t2, 2)
  await room(level3, 'Stair hall', hall(L3.z0), L3, t3, 2)
  await room(level3, 'Bunk room', { x0: L3.x0, x1: -6, z0: L3.z0, z1: -8 }, L3, t3, 2)
  const zoneNames: [string, string][] = [
    [level1, 'Great room'],
    [level2, 'Upper hall'],
    [level3, 'Family room'],
  ]
  for (const [levelId, name] of zoneNames) {
    // The shell's own zone can survive as a copy of the first room cut from it: drop copies.
    const zones = (await s.call('get_zones', { levelId })).zones as {
      id: string
      name: string
      areaSqMeters: number
    }[]
    const isShell = (z: { name: string }) => z.name.startsWith('Level') || /^Room \d+$/.test(z.name)
    const copies = zones.filter(
      (z) =>
        isShell(z) &&
        zones.some((o) => !isShell(o) && Math.abs(o.areaSqMeters - z.areaSqMeters) < 0.05),
    )
    if (copies.length > 0)
      await s.call('apply_patch', { patches: copies.map((z) => ({ op: 'delete', id: z.id })) })
    const unnamed = zones.filter((z) => isShell(z) && !copies.includes(z))
    if (unnamed.length !== 1)
      throw new Error(`${name}: expected one remaining zone, got ${unnamed.length}`)
    await s.call('apply_patch', {
      patches: [
        {
          op: 'update',
          id: unnamed[0]!.id,
          data: { name, metadata: { basis: 'invented interior' } },
        },
      ],
    })
  }

  // Glass between the piers, as tall as each wall allows.
  const front1 = spansFromPiers(
    [wing.x0, L1.z1],
    [L1.x1, L1.z1],
    pairs(facts.str('frontPiersL1')),
    panelFt,
  )
  // The entry: the left part of the first glass run right of centre becomes a glass door.
  const entryIdx = front1.findIndex((g) => g.a[0] > 0)
  const entry = front1[entryIdx]!
  front1.splice(
    entryIdx,
    1,
    { ...entry, b: [entry.a[0] + 4.5, entry.a[1]], panels: 1, door: true },
    {
      ...entry,
      a: [entry.a[0] + 4.5, entry.a[1]],
      panels: Math.max(1, Math.round((entry.b[0] - entry.a[0] - 4.5) / panelFt)),
    },
  )
  const facades: { levelId: string; t: number; spans: GlassSpan[] }[] = [
    {
      levelId: level1,
      t: t1,
      spans: [
        ...front1,
        ...spansFromPiers([L1.x1, L1.z1], [L1.x1, L1.z0], pairs(facts.str('sidePiersL1')), panelFt),
        ...inventedSpans(invented, 'L1 back', L1.z0, panelFt),
        ...inventedSpans(invented, 'wing back', wing.z0, panelFt),
        ...inventedSpans(invented, 'wing left', wing.x0, panelFt),
      ],
    },
    {
      levelId: level2,
      t: t2,
      spans: [
        ...spansFromPiers(
          [L2.x0, L2.z1],
          [L2.x1, L2.z1],
          pairs(facts.str('frontPiersL2')),
          panelFt,
        ),
        ...spansFromPiers([L2.x1, L2.z1], [L2.x1, L2.z0], pairs(facts.str('sidePiersL2')), panelFt),
        ...inventedSpans(invented, 'L2 back', L2.z0, panelFt),
        ...inventedSpans(invented, 'L2 left', L2.x0, panelFt),
      ],
    },
    {
      levelId: level3,
      t: t3,
      spans: [
        ...spansFromPiers(
          [L3.x0, L3.z1],
          [L3.x1, L3.z1],
          pairs(facts.str('frontPiersL3')),
          panelFt,
        ),
        ...spansFromPiers([L3.x1, L3.z1], [L3.x1, L3.z0], pairs(facts.str('sidePiersL3')), panelFt),
        ...inventedSpans(invented, 'L3 back', L3.z0, panelFt),
        ...inventedSpans(invented, 'L3 left', L3.x0, panelFt),
      ],
    },
  ]
  const openingPatches: Record<string, unknown>[] = []
  let windowCount = 0
  let paneCount = 0
  let doorCount = 0
  for (const f of facades) {
    const walls = (await s.call('get_walls', { levelId: f.levelId })).walls as WallInfo[]
    for (const span of f.spans) {
      const { wall, lo, hi } = hostWall(walls, span, f.t + 0.1)
      const margin = 0.05
      const width = hi - lo - 2 * margin
      const center = (lo + hi) / 2
      const placement = { wallId: wall.id, t: round(center / wall.length, 5) }
      if (span.door) {
        const { result } = await tallOpening(
          s,
          'add_door',
          { ...placement, width: round(width), doorType: 'hinged', style: 'glass' },
          Math.min(wall.resolvedHeight - head, 3.0),
        )
        doorCount++
        openingPatches.push({
          op: 'update',
          id: result.doorId,
          data: {
            name: 'Front entry',
            slots: { frame: MAT.bronze, panel: MAT.bronze, glass: MAT.glass },
            metadata: { basis: 'entry position is an estimate' },
          },
        })
        continue
      }
      const { result } = await tallOpening(
        s,
        'add_window',
        { ...placement, width: round(width), sillHeight: 0, columns: span.panels },
        wall.resolvedHeight - head,
      )
      windowCount++
      paneCount += span.panels
      openingPatches.push({
        op: 'update',
        id: result.windowId,
        data: {
          slots: { frame: MAT.bronze, glass: MAT.glass },
          frameThickness: 0.06,
          frameDepth: 0.1,
          columnDividerThickness: 0.05,
          sill: false,
          metadata: { basis: span.basis },
        },
      })
    }
  }
  await s.call('apply_patch', { patches: openingPatches })

  // Stairs: two flights side by side in the stair hall.
  const stairW = m(3.6)
  await s.call('create_stair', {
    levelId: level1,
    toLevelId: level2,
    x: round(-stairW / 2 - 0.3),
    z: round(m(L1.z0) + t1 / 2 + 0.6),
    rotation: 0,
    width: stairW,
    materialPreset: 'library:wood-woodplank48',
    name: 'Stair, level 1 to 2',
  })
  await s.call('create_stair', {
    levelId: level2,
    toLevelId: level3,
    x: round(stairW / 2 + 0.3),
    z: round(m(2) - 0.075 - 0.7),
    rotation: 180,
    width: stairW,
    materialPreset: 'library:wood-woodplank48',
    name: 'Stair, level 2 to 3',
  })

  // Frameless glass rails on the slab edges (fence nodes: bronze cap, glass infill).
  const inner = 0.12
  const rail = (levelId: string, name: string, a: Pt, b: Pt) => ({
    op: 'create',
    parentId: levelId,
    node: {
      type: 'fence',
      name,
      start: a,
      end: b,
      height: railH,
      thickness: 0.03,
      style: 'privacy',
      baseStyle: 'floating',
      baseHeight: 0,
      groundClearance: 0.05,
      postSize: 0.05,
      postCap: 'none',
      topRailHeight: 0.035,
      slots: { posts: MAT.bronze, infill: MAT.glass, rail: MAT.bronze },
      metadata: { basis: 'frameless glass rail (hero photo); height is an estimate' },
    },
  })
  const s1 = { x0: m(slab1.x0), x1: m(slab1.x1), z0: m(slab1.z0), z1: m(slab1.z1) }
  const s2 = { x0: m(slab2.x0), x1: m(slab2.x1), z0: m(slab2.z0), z1: m(slab2.z1) }
  const wd = { x0: m(wingDeck.x0), x1: m(wingDeck.x1), z1: m(wingDeck.z1) }
  const r = (v: number) => round(v, 3)
  await s.call('apply_patch', {
    patches: [
      rail(
        level2,
        'Level 2 rail, front',
        [r(s1.x0 + inner), r(s1.z1 - inner)],
        [r(s1.x1 - inner), r(s1.z1 - inner)],
      ),
      rail(
        level2,
        'Level 2 rail, side',
        [r(s1.x1 - inner), r(s1.z1 - inner)],
        [r(s1.x1 - inner), r(s1.z0 + inner)],
      ),
      rail(
        level2,
        'Wing deck rail',
        [r(wd.x0 + inner), r(wd.z1 - inner)],
        [r(wd.x1), r(wd.z1 - inner)],
      ),
      rail(
        level3,
        'Level 3 rail, front',
        [r(s2.x0 + inner), r(s2.z1 - inner)],
        [r(s2.x1 - inner), r(s2.z1 - inner)],
      ),
      rail(
        level3,
        'Level 3 rail, side',
        [r(s2.x1 - inner), r(s2.z1 - inner)],
        [r(s2.x1 - inner), r(s2.z0 + inner)],
      ),
    ],
  })

  // The flat roof: bronze fascia, cedar soffit, charcoal membrane.
  const roofW = m(roof.x1 - roof.x0)
  const roofD = m(roof.z1 - roof.z0)
  const roofC: Pt = [m((roof.x0 + roof.x1) / 2), m((roof.z0 + roof.z1) / 2)]
  const roofBaseAbove = m(roof.top) - m(h1 + h2 + h3)
  const deckWall = 0.1
  const kneeWall = 0.05
  const roofRes = await s.call('create_roof', {
    levelId: level3,
    roofLevelLabel: 'Roof',
    center: [roofC[0], round(roofBaseAbove - kneeWall, 4), roofC[1]],
    width: round(roofW - deckWall, 4),
    depth: round(roofD - deckWall, 4),
    roofType: 'flat',
    pitch: 0,
    wallHeight: kneeWall,
    wallThickness: deckWall,
    overhang: 0,
    name: 'Roof',
  })
  const shingle = 0.03
  // The photo shows no gutters on the fascia: remove the ones the roof creates by default.
  const gutterIds = () =>
    s
      .call('get_scene')
      .then((sc) =>
        (Object.values(sc.nodes) as { id: string; type: string }[])
          .filter((n) => n.type === 'gutter' || n.type === 'downspout')
          .map((n) => n.id),
      )
  await s.call('apply_patch', {
    patches: [
      {
        op: 'update',
        id: roofRes.roofId,
        data: {
          // Flat roof slots: top = membrane, edge = the deck underside, wall = deck sides.
          topMaterialPreset: MAT.roof,
          edgeMaterialPreset: MAT.cedar,
          wallMaterialPreset: MAT.bronze,
          metadata: {
            basis:
              'read from the hero photo (earlier reading): low-slope roof modelled flat, 8-12 ft cedar soffits',
          },
        },
      },
    ],
  })
  await s.call('apply_patch', {
    patches: [
      {
        op: 'update',
        id: roofRes.roofSegmentId,
        data: {
          deckThickness: round(m(roof.thick) - shingle, 4),
          shingleThickness: shingle,
          wallShell: 'omit',
          fascia: false,
        },
      },
    ],
  })

  const gutters = await gutterIds()
  if (gutters.length > 0)
    await s.call('apply_patch', { patches: gutters.map((id) => ({ op: 'delete', id })) })

  // Stone chimneys on the roof segment, their tops at the heights read from the photo.
  const chimneyPatches = (['chimney1', 'chimney2'] as const).map((key, i) => {
    const [size, , x, z, top] = numbers(facts.str(key)) as number[]
    return {
      op: 'create',
      parentId: roofRes.roofSegmentId,
      node: {
        type: 'chimney',
        name: i === 0 ? 'Stone chimney (east)' : 'Stone chimney (west)',
        roofSegmentId: roofRes.roofSegmentId,
        position: [round(m(x!) - roofC[0], 4), 0, round(m(z!) - roofC[1], 4)],
        width: m(size!),
        depth: m(size!),
        // body top = segment knee wall + heightAboveRidge above the roof's own origin
        heightAboveRidge: round(
          m(top!) - m(h1 + h2 + h3) - (roofBaseAbove - kneeWall) - kneeWall,
          4,
        ),
        capShape: 'flat',
        capOverhang: 0.06,
        capThickness: 0.1,
        flueCount: 1,
        flueShape: 'square',
        // A chimney reads only its own material fields, not scene: refs, so it carries the
        // sandstone inline.
        material: SANDSTONE.material,
        topMaterialPreset: MAT.bronze,
        metadata: { basis: 'read from the hero photo (earlier reading)' },
      },
    }
  })
  await s.call('apply_patch', { patches: chimneyPatches })

  // Grade: lawn, stone terraces, the boulder retaining wall.
  const footprintHole = l1Outline.map(mp)
  const terraceF = extentOf(facts.str('terraceFront'))
  const terraceS = extentOf(facts.str('terraceSide'))
  await s.call('apply_patch', {
    patches: [
      {
        op: 'create',
        parentId: level1,
        node: {
          type: 'slab',
          name: 'Lawn',
          polygon: rectM(lawn),
          holes: [footprintHole],
          elevation: 0.02,
          thickness: 0.02,
          slots: { surface: LAWN, side: LAWN },
          metadata: { basis: 'estimate: lawn beyond the terrace (hero photo)' },
        },
      },
      ...[
        ['Front terrace', terraceF],
        ['Side terrace', terraceS],
      ].map(([name, e]) => ({
        op: 'create',
        parentId: level1,
        node: {
          type: 'slab',
          name,
          polygon: rectM(e as Extent),
          elevation: 0.04,
          thickness: 0.04,
          slots: { surface: MAT.pavers, side: MAT.stone },
          metadata: { basis: 'read from the hero photo (earlier reading)' },
        },
      })),
    ],
  })
  const [rx, rz0, rz1, rt, rh] = numbers(facts.str('retainingWall')) as number[]
  const retaining = await s.call('add_wall', {
    levelId: level1,
    start: [m(rx!), m(rz0!)],
    end: [m(rx!), m(rz1!)],
    thickness: m(rt!),
    height: m(rh!),
  })

  // Wall finishes: stone outside, plaster inside, stone both sides on the retaining wall.
  const nodes = Object.values((await s.call('get_scene')).nodes) as {
    id: string
    type: string
    frontSide?: string
    backSide?: string
  }[]
  const wallPatches = nodes
    .filter((n) => n.type === 'wall')
    .map((w) => {
      const stoneBoth = w.id === retaining.wallId
      const a = stoneBoth || w.frontSide === 'exterior' ? MAT.stone : MAT.plaster
      const b = stoneBoth || w.backSide === 'exterior' ? MAT.stone : MAT.plaster
      return {
        op: 'update',
        id: w.id,
        data: {
          slots: { a, b },
          ...(stoneBoth
            ? {
                name: 'Boulder retaining wall',
                metadata: { basis: 'estimate (hero photo shows boulders)' },
              }
            : {}),
        },
      }
    })
  await s.call('apply_patch', { patches: wallPatches })

  // Gross floor area: the outer footprint of each storey.
  const area = (e: Extent) => (e.x1 - e.x0) * (e.z1 - e.z0)
  const gfaSf = {
    level1: area(L1) + area(wing),
    level2: area(L2),
    level3: area(L3),
  }
  const gfa = gfaSf.level1 + gfaSf.level2 + gfaSf.level3
  return {
    file: 'red-mountain.json',
    title: 'Red Mountain residence',
    stats: {
      'Gross floor area (model)': `${gfa.toLocaleString('en-US')} SF / ${Math.round(gfa * FT * FT)} m2 (L1 ${gfaSf.level1.toLocaleString('en-US')}, L2 ${gfaSf.level2.toLocaleString('en-US')}, L3 ${gfaSf.level3.toLocaleString('en-US')} SF; outer footprints, no published area to compare)`,
      'Height to roof base': `${roof.top} ft (${m(roof.top)} m)`,
      'Glass runs / panes': `${windowCount} windows, ${paneCount} panes, ${doorCount} glass entry door`,
      'Glass rails': '5 runs on the level 2 and 3 slabs and the wing deck',
      Chimneys: 2,
      Stairs: '2 flights (invented position)',
    },
    notes: [
      '`verify_scene` and `validate_scene` run on the finished scene; their results are in the table above.',
    ],
  }
}

// ---------------------------------------------------------------- cameras

/** Render viewpoints, read in feet in the scene's plan frame and written in metres. */
const CAMERAS_FT: Record<string, { position: number[]; target: number[]; fov: number }> = {
  hero: { position: [96, 5.5, 88], target: [-4, 19, -4], fov: 52 },
  front: { position: [-2, 19, 185], target: [-2, 18, 0], fov: 42 },
  side: { position: [210, 19, -1], target: [0, 18, -1], fov: 42 },
  back: { position: [-6, 19, -190], target: [-6, 18, 0], fov: 42 },
  aerial: { position: [150, 125, 175], target: [-8, 14, -2], fov: 45 },
  top: { position: [-8, 340, 0.5], target: [-8, 0, 0], fov: 40 },
}

// ---------------------------------------------------------------- main

const dir = dirname(fileURLToPath(import.meta.url))
const facts = new Facts(join(dir, 'facts.json'))
const s = await openSession('Rebuild Red Mountain from its facts')
const output = await buildRedMountain(s, facts)
const validated = await s.call('validate_scene')
const verified = await s.call('verify_scene')
const { json } = await s.call('export_json', { pretty: true })
await s.close()
const scene = JSON.parse(json)
scene.materials = { ...(scene.materials ?? {}), [SANDSTONE.id]: SANDSTONE }
const loadCheck = validateBuildJson(scene)
const nodeTypes: Record<string, number> = {}
for (const n of Object.values(scene.nodes) as { type: string }[])
  nodeTypes[n.type] = (nodeTypes[n.type] ?? 0) + 1
writeFileSync(join(dir, output.file), `${JSON.stringify(scene, null, 2)}\n`)

const cameras = Object.fromEntries(
  Object.entries(CAMERAS_FT).map(([k, c]) => [
    k,
    { position: c.position.map(m), target: c.target.map(m), fov: c.fov },
  ]),
)
writeFileSync(join(dir, 'cameras.json'), `${JSON.stringify(cameras, null, 2)}\n`)

const issues = verified.issues as { type: string; message: string }[]
const check: SceneCheck = {
  output,
  nodeCount: Object.keys(scene.nodes).length,
  nodeTypes,
  validateScene: {
    valid: validated.valid,
    errors: validated.errors.length,
    warnings: validated.warnings?.length ?? 0,
  },
  verifyScene: {
    hasIssues: verified.hasIssues,
    issues: issues.map((i) => `${i.type}: ${i.message}`),
  },
  buildJson: {
    ok: loadCheck.ok,
    errors: loadCheck.errors.length,
    warnings: loadCheck.warnings.length,
  },
  toolCalls: { ...s.calls },
}
const md = renderFactsMd(facts, 'red-mountain', [check])
  .replace(
    'Generated by examples/woodmont-portfolio/build.ts from red-mountain/facts.json',
    'Generated by examples/red-mountain/build.ts from facts.json',
  )
  .replace(
    'belong to Woodmont Properties and their publishers',
    'belong to Hendrickson Construction',
  )
writeFileSync(join(dir, 'facts.md'), md)

console.log(
  `red-mountain.json: ${check.nodeCount} nodes ${JSON.stringify(nodeTypes)}\n` +
    `validate_scene ${check.validateScene.valid ? 'valid' : 'INVALID'} (${check.validateScene.errors} errors, ${check.validateScene.warnings} warnings)\n` +
    `validateBuildJson ${loadCheck.ok ? 'ok' : 'FAILED'} (${loadCheck.errors.length} errors, ${loadCheck.warnings.length} warnings)\n` +
    `verify_scene ${verified.hasIssues ? issues.map((i) => i.message).join(' | ') : 'no issues'}`,
)
if (!loadCheck.ok) console.log(JSON.stringify(loadCheck.errors.slice(0, 5), null, 2))
if (!check.validateScene.valid || !loadCheck.ok) process.exit(1)
