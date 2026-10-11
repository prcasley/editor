import type { BriefValueSource, BuildingBriefInput } from '../agent-tools/building-brief'
import { isAgentRefusal, refuse } from '../agent-tools/refusal'
import { WALL_OPENING_DEFAULTS } from '../building/wall-openings'
import {
  type AnyNode,
  BuildingNode,
  LevelNode,
  RoofNode,
  RoofSegmentNode,
  SiteNode,
  type WallNode,
} from '../schema'
import { resolveWallExteriorSide } from '../systems/wall/wall-assembly'
import { applySceneChanges, mergeSceneChanges } from './apply-changes'
import { type CreateRoomInput, createRoom, edgeProjection } from './create-room'
import { requireMaterialRef } from './material-refs'
import { polygonArea, type Vec2 } from './plan-geometry'
import { ROOM_OPERATIONS } from './room-structure'
import { levelsOf } from './scene-queries'
import type {
  AgentContext,
  AgentOperation,
  AgentOperationOutcome,
  SceneChanges,
  SceneNodes,
} from './types'

/** What a brief assumes where it says nothing; every use is reported as a default. */
export const BRIEF_DEFAULTS = {
  storyHeight: 3,
  wallThickness: 0.25,
  foundationHeight: 0,
  pitch: { flat: 0, gable: 35, hip: 30, shed: 10 },
  overhang: { flat: 0, gable: 0.3, hip: 0.3, shed: 0.3 },
} as const

/** A gross floor area within this fraction of the known figure agrees with it. */
const FLOOR_AREA_TOLERANCE = 0.1

type Unit = 'm' | 'deg' | 'm2'
type Sourced =
  | number
  | { value: number; source?: BriefValueSource; confidence?: number; basis?: string }

/** A value the model rests on that nobody measured: estimated from a photo, or assumed. */
export type BriefAssumption = {
  field: string
  value: number
  unit: Unit
  source: Exclude<BriefValueSource, 'measured'>
  confidence?: number
  basis?: string
}

/** Reads the brief's numbers and keeps every one that was not measured. */
class Ledger {
  readonly assumptions: BriefAssumption[] = []

  read(field: string, raw: Sourced | undefined, unit: Unit, fallback: number, basis?: string) {
    if (raw === undefined) {
      this.assumptions.push({
        field,
        // A derived default (a bay spacing) is reported to the tenth of a millimetre.
        value: Math.round(fallback * 1e4) / 1e4,
        unit,
        source: 'default',
        ...(basis ? { basis } : {}),
      })
      return fallback
    }
    const entry = typeof raw === 'number' ? { value: raw } : raw
    const source = entry.source ?? 'estimated'
    if (source !== 'measured')
      this.assumptions.push({
        field,
        value: entry.value,
        unit,
        source,
        ...(entry.confidence === undefined ? {} : { confidence: entry.confidence }),
        ...(entry.basis ? { basis: entry.basis } : {}),
      })
    return entry.value
  }

  readOptional(field: string, raw: Sourced | undefined, unit: Unit) {
    return raw === undefined ? undefined : this.read(field, raw, unit, 0)
  }
}

const FACADE_NAMES = ['front', 'right', 'back', 'left'] as const

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k]
const unit = (a: Vec2): Vec2 => scale(a, 1 / Math.hypot(a[0], a[1]))
const metres = (value: number) => `${Math.round(value * 100) / 100} m`

function signedArea(points: readonly Vec2[]) {
  let area = 0
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]!
    area += a[0] * b[1] - b[0] * a[1]
  })
  return area / 2
}

/**
 * The footprint's plan geometry. A brief gives the outside of the walls; walls are drawn on their
 * centreline, half a thickness in. Edge i is facade i; `leftToRight` says whether edge i runs from
 * the left corner to the right one seen from outside (the brief's winding), and `outward` is each
 * edge's outward unit normal.
 */
function footprintGeometry(outside: Vec2[], thickness: number) {
  const n = outside.length
  // Negative signed area: anticlockwise on a north-up plan (north is −z), the brief's winding.
  const leftToRight = signedArea(outside) < 0
  const outward = outside.map((a, i) => {
    const [dx, dz] = unit(sub(outside[(i + 1) % n]!, a))
    return (leftToRight ? [-dz, dx] : [dz, -dx]) as Vec2
  })
  // Each corner moves to where its two edges' offset lines meet (a mitre); parallel neighbours
  // just move along their shared normal.
  const inset = thickness / 2
  const centreline = outside.map((corner, i) => {
    const before = outward[(i - 1 + n) % n]!
    const after = outward[i]!
    const cos = before[0] * after[0] + before[1] * after[1]
    const bisector = add(before, after)
    const mitre = 1 + cos < 1e-9 ? after : scale(bisector, 1 / (1 + cos))
    return sub(corner, scale(mitre, inset))
  })
  const collapsed = centreline.some((a, i) => {
    const b = centreline[(i + 1) % n]!
    const before = sub(outside[(i + 1) % n]!, outside[i]!)
    const after = sub(b, a)
    return before[0] * after[0] + before[1] * after[1] <= 1e-9
  })
  if (collapsed)
    refuse(
      'footprint_too_small',
      `With ${metres(thickness)} walls the footprint leaves no room inside: a facade is shorter than the wall thickness.`,
      { wallThickness: thickness },
    )
  return { outside, centreline, outward, leftToRight }
}

type Footprint = ReturnType<typeof footprintGeometry>

/** A point `along` metres from facade `edge`'s left corner (seen from outside), on its outside. */
function facadePoint(footprint: Footprint, edge: number, along: number): Vec2 {
  const { outside, leftToRight } = footprint
  const start = outside[edge]!
  const end = outside[(edge + 1) % outside.length]!
  const length = Math.hypot(end[0] - start[0], end[1] - start[1])
  const fromStart = leftToRight ? along : length - along
  return add(start, scale(unit(sub(end, start)), fromStart))
}

const facadeLength = ({ outside }: Footprint, edge: number) => {
  const a = outside[edge]!
  const b = outside[(edge + 1) % outside.length]!
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** Where a point of the outside face lands on the wall centreline of the same edge. */
function centrelineAt({ centreline }: Footprint, edge: number, point: Vec2) {
  const a = centreline[edge]!
  const b = centreline[(edge + 1) % centreline.length]!
  const { t } = edgeProjection(a, b, point)
  return { t, point: add(a, scale(sub(b, a), t)) }
}

type OpeningSpec = NonNullable<CreateRoomInput['doors']>[number]
type StoryOpenings = {
  doors: OpeningSpec[]
  windows: OpeningSpec[]
  doorFields: string[]
  windowFields: string[]
}

type Story = { name: string; height: number; levelName?: string }

type ResolvedBuilding = {
  building: BuildingNode
  changes: SceneChanges
  siteId?: string
  replacedLevelIds: string[]
}

/** The building to fill: the one named, else the scene's only one, else a new one. */
function resolveBuilding(nodes: SceneNodes, brief: BuildingBriefInput): ResolvedBuilding {
  const buildings = Object.values(nodes).filter(
    (node): node is BuildingNode => node.type === 'building',
  )
  let building: BuildingNode | undefined
  if (brief.buildingId) {
    const node = nodes[brief.buildingId]
    if (!node)
      refuse('building_not_found', `Building not found: ${brief.buildingId}.`, {
        buildingId: brief.buildingId,
      })
    if (node.type !== 'building')
      refuse('not_a_building', `Node ${brief.buildingId} is a ${node.type}, not a building.`, {
        buildingId: brief.buildingId,
      })
    building = node
  } else if (buildings.length === 1) building = buildings[0]
  else if (buildings.length > 1)
    refuse(
      'building_required',
      `The scene has ${buildings.length} buildings; name an empty one with buildingId, or clear_scene to start over.`,
      { buildingIds: buildings.map(({ id }) => id) },
    )

  if (!building) {
    const standing = Object.values(nodes).find((node) => node.type === 'site')
    const site = standing ? null : SiteNode.parse({ children: [] })
    const siteId = standing?.id ?? site!.id
    const created = BuildingNode.parse({
      parentId: siteId,
      children: [],
      ...(brief.name ? { name: brief.name } : {}),
    })
    return {
      building: created,
      ...(site ? { siteId: site.id } : {}),
      replacedLevelIds: [],
      changes: {
        create: [...(site ? [{ node: site }] : []), { node: created, parentId: siteId }],
      },
    }
  }

  const levels = levelsOf(nodes).filter(
    (level) => level.parentId === building.id || building.children.includes(level.id),
  )
  const others = building.children.filter((id) => nodes[id]?.type !== 'level')
  const filled = levels.filter((level) => level.children.length > 0)
  if (filled.length || others.length)
    refuse(
      'building_not_empty',
      `Building ${building.name ?? building.id} already holds ${filled.length ? `content on ${filled.map((level) => level.name ?? `level ${level.level}`).join(', ')}` : `${others.length} unit or system node(s)`}. A draft goes in an empty building: clear_scene to start over (when the person asked), or name an empty building with buildingId.`,
      { buildingId: building.id },
    )
  return {
    building,
    replacedLevelIds: levels.map(({ id }) => id),
    changes: {
      delete: levels.map(({ id }) => id),
      ...(brief.name ? { update: [{ id: building.id, data: { name: brief.name } }] } : {}),
    },
  }
}

/** The face of a wall the reconciler found outside: `a` is its front side, `b` its back. */
function outsideFace(wall: WallNode): 'a' | 'b' | null {
  const side = resolveWallExteriorSide(wall)
  return side === 1 ? 'a' : side === -1 ? 'b' : null
}

const nonEmpty = (changes: Required<SceneChanges>) =>
  changes.create.length || changes.update.length || changes.delete.length ? changes : undefined

/**
 * `draft_building_from_brief`: a building from what photos show, through the editor's own
 * commands — a room shell per storey (create_room), its openings with add_door's and add_window's
 * rules, balconies as outdoor rooms, a roof on the top storey's walls as the editor's room roof
 * sits, then, once the host has derived the floors, the facade finishes and the ground floor's
 * foundation. One outcome, so one undo step; every value nobody measured is in `estimates`.
 */
export const draftBuildingFromBrief: AgentOperation<BuildingBriefInput> = (
  nodes,
  brief,
  context,
) => {
  const ledger = new Ledger()
  const limitations: string[] = []

  // ── Plan geometry ──────────────────────────────────────────────────────────
  const thickness = ledger.read(
    'wallThickness',
    brief.wallThickness,
    'm',
    BRIEF_DEFAULTS.wallThickness,
  )
  let outside: Vec2[]
  if (brief.footprint.shape === 'rectangle') {
    const w = ledger.read('footprint.width', brief.footprint.width, 'm', 0) / 2
    const d = ledger.read('footprint.depth', brief.footprint.depth, 'm', 0) / 2
    outside = [
      [-w, d],
      [w, d],
      [w, -d],
      [-w, -d],
    ]
  } else {
    const { points, source = 'estimated', confidence, basis } = brief.footprint
    outside = points.map(([x, z]) => [x!, z!])
    if (source !== 'measured')
      ledger.assumptions.push({
        field: 'footprint.points',
        value: Math.round(polygonArea(outside) * 100) / 100,
        unit: 'm2',
        source,
        ...(confidence === undefined ? {} : { confidence }),
        basis: basis ?? 'outline area of the given corners',
      })
  }
  const footprint = footprintGeometry(outside, thickness)
  const facadeCount = outside.length

  const facadeIndex = (ref: string | number, field: string) => {
    if (typeof ref === 'string') {
      if (brief.footprint.shape !== 'rectangle')
        refuse(
          'facade_name_needs_rectangle',
          `${field}: "${ref}" names a facade of a rectangle; on a polygon footprint give the edge index (0–${facadeCount - 1}).`,
          { field },
        )
      return FACADE_NAMES.indexOf(ref as (typeof FACADE_NAMES)[number])
    }
    if (ref >= facadeCount)
      refuse(
        'facade_not_found',
        `${field}: the footprint has ${facadeCount} facades (edges 0–${facadeCount - 1}); there is no edge ${ref}.`,
        { field, facade: ref },
      )
    return ref
  }

  const stories: Story[] = brief.stories.map((story, i) => ({
    name: story.name ?? (i === 0 ? 'Ground floor' : `Floor ${i}`),
    ...(story.name ? { levelName: story.name } : {}),
    height: ledger.read(`stories[${i}].height`, story.height, 'm', BRIEF_DEFAULTS.storyHeight),
  }))
  const storyIndex = (story: number, field: string) => {
    if (story >= stories.length)
      refuse(
        'story_out_of_range',
        `${field}: storey ${story} does not exist; the brief has ${stories.length} (0–${stories.length - 1}).`,
        { field, story },
      )
    return story
  }

  // ── Finishes, refused before anything is built ─────────────────────────────
  const wallFinish = brief.wallMaterial
    ? requireMaterialRef(brief.wallMaterial, 'wallMaterial', 'wall')
    : undefined
  const facadeFinish: (string | undefined)[] = outside.map(() => wallFinish)
  const roofFinish = brief.roof.material
    ? requireMaterialRef(brief.roof.material, 'roof.material', 'roof')
    : undefined

  // ── Openings, laid out along each facade's outside ─────────────────────────
  const perStory: StoryOpenings[] = stories.map(() => ({
    doors: [],
    windows: [],
    doorFields: [],
    windowFields: [],
  }))
  for (const [fi, facade] of (brief.facades ?? []).entries()) {
    const edge = facadeIndex(facade.facade, `facades[${fi}].facade`)
    if (facade.material)
      facadeFinish[edge] = requireMaterialRef(facade.material, `facades[${fi}].material`, 'wall')
    const length = facadeLength(footprint, edge)
    for (const [gi, group] of (facade.openings ?? []).entries()) {
      const field = `facades[${fi}].openings[${gi}]`
      const defaults = WALL_OPENING_DEFAULTS[group.kind]
      const count = group.count ?? 1
      const width = ledger.read(`${field}.width`, group.width, 'm', defaults.width)
      const height = ledger.read(`${field}.height`, group.height, 'm', defaults.height)
      const sillHeight =
        group.kind === 'window'
          ? ledger.read(
              `${field}.sillHeight`,
              group.sillHeight,
              'm',
              WALL_OPENING_DEFAULTS.window.sillHeight,
            )
          : undefined
      const spacing =
        count === 1 && group.spacing === undefined
          ? 0
          : ledger.read(
              `${field}.spacing`,
              group.spacing,
              'm',
              length / count,
              'equal bays across the facade',
            )
      const offset = ledger.read(
        `${field}.offset`,
        group.offset,
        'm',
        (length - (count - 1) * spacing) / 2,
        'group centred on the facade',
      )
      const first = offset - width / 2
      const last = offset + (count - 1) * spacing + width / 2
      if (first < -1e-6 || last > length + 1e-6 || (count > 1 && spacing < width - 1e-6))
        refuse(
          'openings_do_not_fit',
          `${field}: ${count} ${group.kind}${count === 1 ? '' : 's'} ${metres(width)} wide${count > 1 ? ` at ${metres(spacing)} centres` : ''} from ${metres(offset)} span ${metres(first)} to ${metres(last)}, but the facade is ${metres(length)} long${count > 1 && spacing < width ? ' and they would overlap' : ''}. Recount the bays or re-estimate the sizes.`,
          { field, facadeLength: length },
        )
      for (const story of group.stories ?? [0]) {
        const s = storyIndex(story, `${field}.stories`)
        for (let k = 0; k < count; k++) {
          const { t } = centrelineAt(
            footprint,
            edge,
            facadePoint(footprint, edge, offset + k * spacing),
          )
          const spec: OpeningSpec = {
            wallIndex: edge,
            t: Math.min(1, Math.max(0, t)),
            width,
            height,
            ...(sillHeight === undefined ? {} : { sillHeight }),
            ...(group.style ? { style: group.style } : {}),
            ...(group.kind === 'door' && group.doorType ? { doorType: group.doorType } : {}),
            ...(group.kind === 'window' && group.windowType
              ? { windowType: group.windowType }
              : {}),
          }
          const label = `${field} #${k + 1} on storey ${s}`
          if (group.kind === 'door') {
            perStory[s]!.doors.push(spec)
            perStory[s]!.doorFields.push(label)
          } else {
            perStory[s]!.windows.push(spec)
            perStory[s]!.windowFields.push(label)
          }
        }
      }
    }
  }

  // ── Balconies and terraces: outdoor rooms against the facade ───────────────
  const balconies = (brief.balconies ?? []).map((balcony, bi) => {
    const field = `balconies[${bi}]`
    const edge = facadeIndex(balcony.facade, `${field}.facade`)
    const story = storyIndex(balcony.story, `${field}.story`)
    const length = facadeLength(footprint, edge)
    const width = ledger.read(`${field}.width`, balcony.width, 'm', 0)
    const depth = ledger.read(`${field}.depth`, balcony.depth, 'm', 0)
    const offset = ledger.read(
      `${field}.offset`,
      balcony.offset,
      'm',
      length / 2,
      'centred on the facade',
    )
    if (offset - width / 2 < -1e-6 || offset + width / 2 > length + 1e-6)
      refuse(
        'balcony_off_facade',
        `${field}: ${metres(width)} wide centred at ${metres(offset)} runs past the ${metres(length)} facade.`,
        { field, facadeLength: length },
      )
    // Its inner edge is the wall's centreline, so the wall bounds it; its depth counts from the
    // wall's outside face.
    const reach = scale(footprint.outward[edge]!, depth + thickness / 2)
    const a = centrelineAt(footprint, edge, facadePoint(footprint, edge, offset - width / 2)).point
    const b = centrelineAt(footprint, edge, facadePoint(footprint, edge, offset + width / 2)).point
    return {
      field,
      story,
      edge,
      name: balcony.name ?? (story === 0 ? 'Terrace' : 'Balcony'),
      polygon: [a, b, add(b, reach), add(a, reach)],
    }
  })

  // ── Ground and roof figures ────────────────────────────────────────────────
  const foundationHeight = ledger.read(
    'grade.foundationHeight',
    brief.grade?.foundationHeight,
    'm',
    BRIEF_DEFAULTS.foundationHeight,
  )
  for (const [si, step] of (brief.grade?.steps ?? []).entries()) {
    const edge = facadeIndex(step.facade, `grade.steps[${si}].facade`)
    const drop = ledger.read(`grade.steps[${si}].drop`, step.drop, 'm', 0)
    limitations.push(
      `grade.steps[${si}]: the ground falls ${metres(drop)} along facade ${edge}; the ground is not shaped, so it is recorded only.`,
    )
  }
  const roofType = brief.roof.type
  const pitch =
    roofType === 'flat'
      ? 0
      : ledger.read('roof.pitch', brief.roof.pitch, 'deg', BRIEF_DEFAULTS.pitch[roofType])
  const overhang = ledger.read(
    'roof.overhang',
    brief.roof.overhang,
    'm',
    BRIEF_DEFAULTS.overhang[roofType],
  )
  const knownFloorArea = ledger.readOptional('knownFloorArea', brief.knownFloorArea, 'm2')

  // ── The building, its levels, a room shell per storey ──────────────────────
  const target = resolveBuilding(nodes, brief)
  const building = target.building
  const levels = stories.map((story, i) =>
    LevelNode.parse({
      parentId: building.id,
      level: i,
      height: story.height,
      children: [],
      ...(story.levelName ? { name: story.levelName } : {}),
    }),
  )
  const sets: SceneChanges[] = [
    target.changes,
    { create: levels.map((level) => ({ node: level, parentId: building.id })) },
  ]
  let scene = applySceneChanges(nodes, mergeSceneChanges(sets))
  const build = (input: CreateRoomInput) => {
    const outcome = createRoom(scene, input, context)
    scene = applySceneChanges(scene, outcome.changes)
    if (outcome.changes) sets.push(outcome.changes)
    return outcome
  }

  const skippedOpenings: { field: string; code: string; message: string }[] = []
  const rooms = stories.map((story, i) => {
    const openings = perStory[i]!
    const outcome = build({
      levelId: levels[i]!.id,
      name: story.name,
      polygon: footprint.centreline,
      wallThickness: thickness,
      doors: openings.doors,
      windows: openings.windows,
    })
    const result = outcome.result as {
      zoneId: string
      wallIds: (string | null)[]
      doorIds: string[]
      windowIds: string[]
      skippedOpenings?: { kind: 'door' | 'window'; index: number; code: string; message: string }[]
    }
    for (const skipped of result.skippedOpenings ?? [])
      skippedOpenings.push({
        field: (skipped.kind === 'door' ? openings.doorFields : openings.windowFields)[
          skipped.index
        ]!,
        code: skipped.code,
        message: skipped.message,
      })
    return { outcome, result, levelId: levels[i]!.id }
  })

  const balconyRooms = balconies.map((balcony) => ({
    ...balcony,
    outcome: build({
      levelId: levels[balcony.story]!.id,
      name: balcony.name,
      polygon: balcony.polygon,
      outdoor: true,
    }),
  }))

  // ── The roof, on the top storey's walls, in the front's frame ──────────────
  const top = levels.at(-1)!
  const front = footprint.outward[0]!
  // The roof's local +z is the front's outward normal; local +x runs along the front.
  const rotation = Math.atan2(front[0], front[1])
  const local = footprint.centreline.map(([x, z]) => [
    x * Math.cos(rotation) - z * Math.sin(rotation),
    x * Math.sin(rotation) + z * Math.cos(rotation),
  ])
  const xs = local.map(([x]) => x!)
  const zs = local.map(([, z]) => z!)
  const [minX, maxX, minZ, maxZ] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...zs),
    Math.max(...zs),
  ]
  const along = maxX - minX
  const across = maxZ - minZ
  const [cx, cz] = [(minX + maxX) / 2, (minZ + maxZ) / 2]
  const centre: Vec2 = [
    cx * Math.cos(rotation) + cz * Math.sin(rotation),
    -cx * Math.sin(rotation) + cz * Math.cos(rotation),
  ]
  if (Math.abs(polygonArea(footprint.centreline) - along * across) > 0.01 * along * across)
    limitations.push(
      `roof: the footprint is not a rectangle; the ${roofType} roof covers its bounding rectangle (${metres(along)} × ${metres(across)}). Trim or reshape it in the editor.`,
    )
  // A segment's gable ridge and a shed's slope run along its local x; turning it a quarter
  // swaps which side of the footprint its width spans.
  const turn =
    roofType === 'gable' && brief.roof.ridge === 'across-front'
      ? Math.PI / 2
      : roofType === 'shed'
        ? { front: 0, right: Math.PI / 2, back: Math.PI, left: -Math.PI / 2 }[
            brief.roof.lowSide ?? 'front'
          ]
        : 0
  const quarter = Math.abs(Math.sin(turn)) > 0.5
  const segment = RoofSegmentNode.parse({
    roofType,
    width: quarter ? across : along,
    depth: quarter ? along : across,
    pitch,
    overhang,
    wallHeight: 0,
    position: [0, 0, 0],
    rotation: turn,
  })
  const roof = RoofNode.parse({
    name: 'Roof',
    position: [centre[0], top.height ?? BRIEF_DEFAULTS.storyHeight, centre[1]],
    rotation,
    support: { kind: 'walls' },
    children: [segment.id],
    ...(roofFinish ? { topMaterialPreset: roofFinish } : {}),
  })
  sets.push({
    create: [
      { node: roof, parentId: top.id },
      { node: segment, parentId: roof.id },
    ],
  })

  // ── What the brief claims against what was built ───────────────────────────
  const footprintArea = polygonArea(outside)
  const grossArea = footprintArea * stories.length
  const round = (value: number) => Math.round(value * 100) / 100
  const floorArea = (() => {
    const modelled = { footprintSqMeters: round(footprintArea), grossSqMeters: round(grossArea) }
    if (knownFloorArea === undefined)
      return {
        ...modelled,
        check: 'not_given' as const,
        message: 'No known floor area to check against; ask for one (a listing, plan or record).',
      }
    const difference = (grossArea - knownFloorArea) / knownFloorArea
    const agrees = Math.abs(difference) <= FLOOR_AREA_TOLERANCE
    return {
      ...modelled,
      knownSqMeters: round(knownFloorArea),
      differencePercent: Math.round(difference * 1000) / 10,
      check: agrees ? ('consistent' as const) : ('mismatch' as const),
      message: agrees
        ? `The modelled gross area is within ${FLOOR_AREA_TOLERANCE * 100}% of the known figure.`
        : `The modelled gross area (${round(grossArea)} m², outside dimensions × ${stories.length} storeys) is ${Math.abs(Math.round(difference * 100))}% ${difference > 0 ? 'above' : 'below'} the known ${round(knownFloorArea)} m². Re-check the footprint and the storey count, and whether the figure leaves out a basement, garage or attic.`,
    }
  })()

  const estimates = ledger.assumptions
  // The building keeps what it was drafted from, so a later session can tell its estimates from
  // its measurements. Values only: the target building's id is not kept.
  const { buildingId: _target, ...kept } = brief
  const buildingRecord = {
    ...building.metadata,
    buildingBrief: { brief: kept, estimates },
  }
  sets.push({ update: [{ id: building.id, data: { metadata: buildingRecord } }] })

  const result = {
    ok: true,
    buildingId: building.id,
    ...(target.siteId ? { siteId: target.siteId } : {}),
    ...(target.replacedLevelIds.length ? { replacedLevelIds: target.replacedLevelIds } : {}),
    levelIds: levels.map(({ id }) => id),
    stories: rooms.map(({ result: room, levelId }, i) => ({
      levelId,
      name: stories[i]!.name,
      height: stories[i]!.height,
      zoneId: room.zoneId,
      wallIds: room.wallIds,
      doorIds: room.doorIds,
      windowIds: room.windowIds,
    })),
    balconies: balconyRooms.map(({ field, story, edge, outcome }) => ({
      field,
      story,
      facade: edge,
      zoneId: (outcome.result as { zoneId: string }).zoneId,
    })),
    roofId: roof.id,
    roofSegmentId: segment.id,
    counts: {
      levels: levels.length,
      walls: rooms.reduce((sum, { result: room }) => sum + room.wallIds.filter(Boolean).length, 0),
      doors: rooms.reduce((sum, { result: room }) => sum + room.doorIds.length, 0),
      windows: rooms.reduce((sum, { result: room }) => sum + room.windowIds.length, 0),
      balconies: balconyRooms.length,
    },
    floorArea,
    estimates,
    ...(skippedOpenings.length ? { skippedOpenings } : {}),
    ...(limitations.length ? { limitations } : {}),
  }

  const outcomes: AgentOperationOutcome[] = [
    ...rooms.map(({ outcome }) => outcome),
    ...balconyRooms.map(({ outcome }) => outcome),
  ]
  return {
    result: { ...result, message: summary(result, estimates.length) },
    changes: mergeSceneChanges(sets),
    afterReconcile: (derived) =>
      settle(derived, { result, outcomes, rooms, facadeFinish, foundationHeight, context }),
  }
}

type Built = {
  counts: { levels: number; walls: number; doors: number; windows: number; balconies: number }
  skippedOpenings?: unknown[]
}

const plural = (count: number, noun: string, many = `${noun}s`) =>
  `${count} ${count === 1 ? noun : many}`

function summary(result: Built, estimates: number) {
  const { counts } = result
  return [
    `Drafted ${plural(counts.levels, 'storey')}: ${plural(counts.walls, 'wall')}, ${plural(counts.doors, 'door')}, ${plural(counts.windows, 'window')}${counts.balconies ? `, ${plural(counts.balconies, 'balcony or terrace', 'balconies or terraces')}` : ''} and a roof`,
    `${plural(estimates, 'value')} estimated or assumed (see estimates)`,
    ...(result.skippedOpenings?.length
      ? [`${plural(result.skippedOpenings.length, 'opening')} skipped (see skippedOpenings)`]
      : []),
  ].join('; ')
}

/**
 * Once the host has derived the floors and ceilings and told each wall its outside: the rooms'
 * own follow-ups (doors on outside walls face out), the facade finishes on the outside faces, and
 * the ground floor raised on its foundation.
 */
function settle(
  derived: SceneNodes,
  {
    result,
    outcomes,
    rooms,
    facadeFinish,
    foundationHeight,
    context,
  }: {
    result: Record<string, unknown> & Built & { limitations?: string[] }
    outcomes: AgentOperationOutcome[]
    rooms: { result: { zoneId: string; wallIds: (string | null)[] }; levelId: string }[]
    facadeFinish: (string | undefined)[]
    foundationHeight: number
    context: AgentContext
  },
) {
  const limitations = [...(result.limitations ?? [])]
  const settled = outcomes.map((outcome) => outcome.afterReconcile?.(derived))
  const sets: SceneChanges[] = settled.flatMap((entry) => (entry?.changes ? [entry.changes] : []))

  const painted: { id: string; data: Partial<AnyNode> }[] = []
  for (const { result: room } of rooms)
    room.wallIds.forEach((wallId, edge) => {
      const finish = facadeFinish[edge]
      const wall = wallId ? derived[wallId] : undefined
      if (!finish || wall?.type !== 'wall') return
      const face = outsideFace(wall)
      if (!face) {
        limitations.push(`Wall ${wall.id} has no known outside face; its finish was not painted.`)
        return
      }
      painted.push({ id: wall.id, data: { slots: { ...wall.slots, [face]: finish } } })
    })
  if (painted.length) sets.push({ update: painted })

  let raised: number | null = null
  const groundZoneId = rooms[0]!.result.zoneId
  if (foundationHeight > 0) {
    const plate = Object.values(derived).find(
      (node) =>
        node.type === 'slab' &&
        node.parentId === rooms[0]!.levelId &&
        node.plateRole === 'base' &&
        node.zoneIds?.includes(groundZoneId),
    )
    try {
      if (!plate) refuse('no_floor_plate', 'The ground floor has no derived floor plate.')
      const outcome = ROOM_OPERATIONS.set_floor_foundation(
        derived,
        { slabId: plate.id, patch: { foundationHeight } },
        context,
      )
      const conflicts = (outcome.result as { conflicts?: { message: string }[] }).conflicts
      if (conflicts?.length)
        refuse('foundation_conflict', conflicts.map((c) => c.message).join(' '))
      if (outcome.changes) sets.push(outcome.changes)
      raised = foundationHeight
    } catch (error) {
      if (!isAgentRefusal(error)) throw error
      limitations.push(
        `grade.foundationHeight: the ground floor was left on the ground (${error.message})`,
      )
    }
  }

  const stories = (result.stories as Record<string, unknown>[]).map((story, i) => {
    const derivedRoom = settled[i]?.result as { slabId?: string | null; ceilingId?: string | null }
    return {
      ...story,
      slabId: derivedRoom?.slabId ?? null,
      ceilingId: derivedRoom?.ceilingId ?? null,
    }
  })
  const merged = nonEmpty(mergeSceneChanges(sets))
  const answer = {
    ...result,
    stories,
    foundationHeight: raised ?? 0,
    paintedWalls: painted.length,
    ...(limitations.length ? { limitations } : {}),
  }
  return {
    result: { ...answer, message: summary(answer, (result.estimates as unknown[]).length) },
    ...(merged ? { changes: merged } : {}),
  }
}
