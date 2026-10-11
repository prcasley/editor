import { type AnyNode, BuildingNode, LevelNode, SiteNode, WallNode } from '../../schema'
import type { AgentToolCase, SceneGraph } from './cases'

/**
 * `draft_building_from_brief`: a building from what photos show. The scenes are the editor's
 * empty start (a site, a building, one empty level), a scene with nothing at all, and a building
 * that already holds a wall. The briefs are a 10 × 8 m two-storey gable house with its front door
 * and windows, and variations of it.
 */

type Nodes = Readonly<Record<string, AnyNode>>

function emptyStart(): SceneGraph {
  const level = LevelNode.parse({ id: 'level_start', parentId: 'building_start', level: 0 })
  const building = BuildingNode.parse({
    id: 'building_start',
    parentId: 'site_start',
    children: [level.id],
  })
  const site = SiteNode.parse({ id: 'site_start', children: [building.id] })
  return {
    nodes: { [site.id]: site, [building.id]: building, [level.id]: level },
    rootNodeIds: [site.id],
  }
}

const nothing = (): SceneGraph => ({ nodes: {}, rootNodeIds: [] })

function builtStart(): SceneGraph {
  const { nodes, rootNodeIds } = emptyStart()
  const wall = WallNode.parse({
    id: 'wall_kept',
    parentId: 'level_start',
    start: [0, 0],
    end: [4, 0],
  })
  const level = nodes.level_start as LevelNode
  return {
    nodes: { ...nodes, [wall.id]: wall, level_start: { ...level, children: [wall.id] } },
    rootNodeIds,
  }
}

const house = {
  name: 'Maple St',
  footprint: {
    shape: 'rectangle',
    width: { value: 10, source: 'measured', basis: 'county parcel sketch' },
    depth: 8,
  },
  stories: [{ height: { value: 3, confidence: 0.6, basis: 'door head at 2.1 m' } }, { height: 2.8 }],
  wallMaterial: 'siding-lap-white',
  roof: { type: 'gable', pitch: 35, material: 'roof-greyshingles' },
  facades: [
    {
      facade: 'front',
      material: 'flooring-rusticbrick',
      openings: [
        { kind: 'door', width: 1, style: 'paneled-glass' },
        { kind: 'window', count: 2, spacing: 6, width: 1.2, height: 1.4 },
        { kind: 'window', count: 3, stories: [1], width: 1, height: 1.2 },
      ],
    },
    { facade: 'back', openings: [{ kind: 'window', count: 2, stories: [0, 1] }] },
  ],
  knownFloorArea: { value: 160, source: 'measured', basis: 'listing' },
}

/** The scene holds this many nodes of each type. */
const holds = (expected: Record<string, number>) => (nodes: Nodes) =>
  Object.entries(expected).flatMap(([type, count]) => {
    const found = Object.values(nodes).filter((node) => node.type === type).length
    return found === count ? [] : [`${count} ${type} expected, ${found} found`]
  })

const byType = <T extends AnyNode['type']>(nodes: Nodes, type: T) =>
  Object.values(nodes).filter((node): node is Extract<AnyNode, { type: T }> => node.type === type)

export const DRAFT_BUILDING_CASES: AgentToolCase[] = [
  {
    name: 'a two-storey gable house fills the empty start: levels, walls, openings, roof, finishes',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: house,
    expect: {
      result: {
        ok: true,
        buildingId: 'building_start',
        replacedLevelIds: ['level_start'],
        counts: { levels: 2, walls: 8, doors: 1, windows: 9, balconies: 0 },
        floorArea: { grossSqMeters: 160, knownSqMeters: 160, check: 'consistent' },
        paintedWalls: 8,
      },
      absent: ['level_start'],
      after: { building_start: { name: 'Maple St' } },
      contains: {
        estimates: [
          { field: 'footprint.depth', value: 8, source: 'estimated' },
          { field: 'stories[0].height', value: 3, confidence: 0.6, basis: 'door head at 2.1 m' },
          { field: 'wallThickness', value: 0.25, source: 'default' },
          { field: 'facades[0].openings[0].height', value: 2.1, source: 'default' },
          { field: 'facades[1].openings[0].spacing', value: 5, source: 'default' },
        ],
      },
      lacks: {
        estimates: [{ field: 'footprint.width' }, { field: 'knownFloorArea' }],
      },
      check: (result, nodes) => {
        const problems = holds({ level: 2, wall: 8, door: 1, window: 9, roof: 1, 'roof-segment': 1 })(
          nodes,
        )
        const levels = byType(nodes, 'level').sort((a, b) => a.level - b.level)
        if (levels.map((level) => level.height).join() !== '3,2.8')
          problems.push(`storey heights ${levels.map((level) => level.height).join()}`)
        const segment = byType(nodes, 'roof-segment')[0]
        if (
          segment?.roofType !== 'gable' ||
          segment.pitch !== 35 ||
          Math.abs(segment.width - 9.75) > 1e-9 ||
          Math.abs(segment.depth - 7.75) > 1e-9
        )
          problems.push('a 35° gable over the 9.75 × 7.75 m wall centrelines')
        const roof = byType(nodes, 'roof')[0]
        if (!roof || roof.parentId !== levels[1]?.id || roof.support.kind !== 'walls')
          problems.push('the roof stands on the top storey, following its walls')
        if (roof?.topMaterialPreset !== 'library:roof-greyshingles') problems.push('roofing')
        // The front is the wall along z = +3.875 (the outside face at +4); its finish is brick.
        const front = byType(nodes, 'wall').filter(
          (wall) => Math.abs(wall.start[1] - 3.875) < 1e-9 && Math.abs(wall.end[1] - 3.875) < 1e-9,
        )
        // Face a is the wall's front side, on its +normal (-dz, dx): outside (+z) when it runs +x.
        const outsideFace = (wall: (typeof front)[number]) =>
          wall.end[0] > wall.start[0] ? 'a' : 'b'
        if (
          front.length !== 2 ||
          !front.every((wall) => wall.slots?.[outsideFace(wall)] === 'library:flooring-rusticbrick')
        )
          problems.push('the front walls are brick on their outside face')
        // The door is centred on the front: at x = 0, the middle of the wall.
        const door = byType(nodes, 'door')[0]
        const host = door && nodes[door.parentId ?? '']
        if (host?.type !== 'wall' || Math.abs(door!.position[0] - 9.75 / 2) > 1e-6)
          problems.push(`door centred on the front wall, at ${door?.position[0]}`)
        const brief = (nodes.building_start?.metadata as { buildingBrief?: { estimates?: unknown[] } })
          .buildingBrief
        if (brief?.estimates?.length !== (result.estimates as unknown[]).length)
          problems.push('the building keeps the brief and its estimates')
        return problems
      },
    },
  },
  {
    name: 'an L-shaped footprint on a scene with nothing: a site, a building, a flat roof over its bounds',
    tool: 'draft_building_from_brief',
    scene: nothing,
    input: {
      footprint: {
        shape: 'polygon',
        points: [
          [0, 0],
          [10, 0],
          [10, -4],
          [4, -4],
          [4, -8],
          [0, -8],
        ],
        source: 'measured',
      },
      stories: [{}],
      roof: { type: 'flat' },
      facades: [{ facade: 0, openings: [{ kind: 'door' }] }],
      knownFloorArea: 120,
    },
    expect: {
      result: {
        ok: true,
        counts: { levels: 1, walls: 6, doors: 1, windows: 0 },
        floorArea: { footprintSqMeters: 56, check: 'mismatch', differencePercent: -53.3 },
      },
      contains: {
        estimates: [
          { field: 'stories[0].height', value: 3, source: 'default' },
          { field: 'knownFloorArea', value: 120, source: 'estimated' },
        ],
      },
      lacks: { estimates: [{ field: 'footprint.points' }, { field: 'roof.pitch' }] },
      mentions: ['bounding rectangle'],
      check: (result, nodes) => [
        ...holds({ site: 1, building: 1, level: 1, wall: 6, roof: 1 })(nodes),
        ...(result.siteId ? [] : ['siteId of the new site']),
        ...(byType(nodes, 'roof-segment')[0]?.roofType === 'flat' ? [] : ['a flat roof']),
      ],
    },
  },
  {
    name: 'a balcony upstairs and a terrace at the back are outdoor rooms against their facades',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: {
      ...house,
      balconies: [
        { facade: 'front', story: 1, width: 3, depth: 1.2 },
        { facade: 'back', story: 0, width: 6, depth: 3, offset: 4 },
      ],
    },
    expect: {
      result: { ok: true, counts: { balconies: 2 } },
      contains: {
        balconies: [
          { field: 'balconies[0]', story: 1, facade: 0 },
          { field: 'balconies[1]', story: 0, facade: 2 },
        ],
        estimates: [{ field: 'balconies[0].offset', value: 5, source: 'default' }],
      },
      check: (_result, nodes) => {
        const outdoor = byType(nodes, 'zone').filter((zone) => zone.name === 'Balcony' || zone.name === 'Terrace')
        const balcony = outdoor.find((zone) => zone.name === 'Balcony')
        const zs = balcony?.polygon.map(([, z]) => z) ?? []
        return [
          ...(outdoor.length === 2 ? [] : [`2 outdoor rooms expected, ${outdoor.length} found`]),
          // From the front wall's centreline (z 3.875) out to 1.2 m past its outside face (z 4).
          ...(Math.abs(Math.min(...zs) - 3.875) < 1e-9 && Math.abs(Math.max(...zs) - 5.2) < 1e-9
            ? []
            : [`balcony spans z ${Math.min(...zs)}..${Math.max(...zs)}`]),
        ]
      },
    },
  },
  {
    name: 'the ground floor stands on its foundation when the entry is up some steps',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: { ...house, grade: { foundationHeight: 0.6, steps: [{ facade: 'back', drop: 1.2 }] } },
    expect: {
      result: { ok: true, foundationHeight: 0.6 },
      contains: { estimates: [{ field: 'grade.steps[0].drop', value: 1.2 }] },
      mentions: ['the ground falls 1.2 m along facade 2'],
      check: (_result, nodes) => {
        const ground = byType(nodes, 'level').find((level) => level.level === 0)
        const plate = byType(nodes, 'slab').find(
          (slab) => slab.parentId === ground?.id && slab.plateRole === 'base',
        )
        return plate?.foundation?.type === 'solid' ? [] : ['a solid foundation under the ground plate']
      },
    },
  },
  {
    name: 'an opening the editor would refuse is skipped and named by its place in the brief',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: {
      ...house,
      facades: [
        {
          facade: 'left',
          openings: [{ kind: 'window', windowType: 'casement', style: 'grid' }],
        },
      ],
    },
    expect: {
      result: { ok: true, counts: { windows: 0 } },
      contains: {
        skippedOpenings: [
          { field: 'facades[0].openings[0] #1 on storey 0', code: 'style_needs_fixed_window' },
        ],
      },
    },
  },
  {
    name: 'a building that holds something is not drawn over',
    tool: 'draft_building_from_brief',
    scene: builtStart,
    input: house,
    expect: { refusal: 'building_not_empty', mentions: ['clear_scene'] },
  },
  {
    name: 'a facade named on a polygon footprint is refused with the edge to use',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: {
      ...house,
      footprint: {
        shape: 'polygon',
        points: [
          [0, 0],
          [6, 0],
          [6, -6],
        ],
      },
    },
    expect: { refusal: 'facade_name_needs_rectangle', mentions: ['edge index (0–2)'] },
  },
  {
    name: 'an edge index past the footprint is refused',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: { ...house, facades: [{ facade: 4 }] },
    expect: { refusal: 'facade_not_found', mentions: ['edges 0–3'] },
  },
  {
    name: 'windows on a storey the brief does not have are refused',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: {
      ...house,
      facades: [{ facade: 'front', openings: [{ kind: 'window', stories: [2] }] }],
    },
    expect: { refusal: 'story_out_of_range', mentions: ['the brief has 2 (0–1)'] },
  },
  {
    name: 'more windows than the facade holds are refused with the span they need',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: {
      ...house,
      facades: [{ facade: 'right', openings: [{ kind: 'window', count: 6, width: 1.5 }] }],
    },
    expect: { refusal: 'openings_do_not_fit', mentions: ['would overlap', 'facade is 8 m long'] },
  },
  {
    name: 'a balcony wider than its facade is refused',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: { ...house, balconies: [{ facade: 'left', story: 1, width: 9, depth: 1 }] },
    expect: { refusal: 'balcony_off_facade' },
  },
  {
    name: 'a material the library does not hold is refused with the nearest ones',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: { ...house, wallMaterial: 'vinyl siding' },
    expect: { refusal: 'unknown_material', mentions: ['wallMaterial', 'siding-batten'] },
  },
  {
    name: 'walls thicker than the footprint leaves room for are refused',
    tool: 'draft_building_from_brief',
    scene: emptyStart,
    input: { ...house, footprint: { shape: 'rectangle', width: 0.2, depth: 6 }, facades: [] },
    expect: { refusal: 'footprint_too_small' },
  },
]
