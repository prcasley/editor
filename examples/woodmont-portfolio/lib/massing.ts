// Site-massing building blocks, each one a sequence of Pascal MCP tool calls.
import { buildingFrame, type Pt } from './geometry'
import type { PascalSession } from './session'

export type Provenance = { refs: { ns?: string; id: string; role?: 'primary' }[] }

export type SceneRoot = { siteId: string; gradeBuildingId: string; gradeLevelId: string }

/**
 * Names the default site, building and level the server starts with. The default
 * building becomes the site-works holder: one grade level for paving, pools and
 * site zones, which Pascal keeps on a level like everything else.
 */
export async function startScene(
  s: PascalSession,
  site: { name: string; polygon: Pt[]; address?: Record<string, string>; metadata: object },
): Promise<SceneRoot> {
  const scene = await s.call('get_scene')
  const nodes = Object.values(scene.nodes) as { id: string; type: string }[]
  const siteId = nodes.find((n) => n.type === 'site')!.id
  const gradeBuildingId = nodes.find((n) => n.type === 'building')!.id
  const gradeLevelId = nodes.find((n) => n.type === 'level')!.id
  await s.call('apply_patch', {
    patches: [
      {
        op: 'update',
        id: siteId,
        data: {
          name: site.name,
          polygon: { type: 'polygon', points: site.polygon },
          ...(site.address ? { address: site.address } : {}),
          metadata: site.metadata,
        },
      },
      {
        op: 'update',
        id: gradeBuildingId,
        data: { name: 'Site works (grade)', metadata: { role: 'site-works' } },
      },
      { op: 'update', id: gradeLevelId, data: { name: 'Grade', height: 0.5 } },
    ],
  })
  return { siteId, gradeBuildingId, gradeLevelId }
}

export type MassSpec = {
  name: string
  /** Footprint in the site frame (metres, x east, z south). */
  footprint: Pt[]
  stories: number
  floorToFloor: number
  /** Height of the ground floor above grade (a dock-high warehouse floor, for example). */
  baseElevation?: number
  wallThickness?: number
  roof?: { type: 'hip' | 'gable' | 'flat'; pitch?: number; overhang?: number; material?: string }
  provenance?: Provenance
  metadata: Record<string, unknown>
}

export type Mass = {
  buildingId: string
  levelIds: string[]
  frame: ReturnType<typeof buildingFrame>
  roofId?: string
}

/** A building as a stack of story shells on its footprint, with an optional roof. */
export async function addMass(
  s: PascalSession,
  siteId: string,
  spec: MassSpec,
  idSeed: string,
): Promise<Mass> {
  const frame = buildingFrame(spec.footprint)
  const buildingId = `building_${idSeed}`
  await s.call('apply_patch', {
    patches: [
      {
        op: 'create',
        parentId: siteId,
        node: {
          type: 'building',
          id: buildingId,
          name: spec.name,
          position: [frame.position[0], spec.baseElevation ?? 0, frame.position[2]],
          rotation: [0, frame.rotationY, 0],
          metadata: spec.metadata,
          ...(spec.provenance ? { provenance: spec.provenance } : {}),
        },
      },
    ],
  })
  const levelIds: string[] = []
  for (let i = 0; i < spec.stories; i++) {
    const lv = await s.call('add_level', {
      buildingId,
      height: spec.floorToFloor,
      name: i === 0 ? 'Ground floor' : `Floor ${i + 1}`,
    })
    levelIds.push(lv.levelId)
    await s.call('create_story_shell', {
      levelId: lv.levelId,
      footprint: frame.local,
      wallThickness: spec.wallThickness ?? 0.3,
      namePrefix: spec.name,
    })
  }
  let roofId: string | undefined
  if (spec.roof) {
    const roof = await s.call('create_roof', {
      levelId: levelIds[levelIds.length - 1],
      width: frame.width + 2 * (spec.roof.overhang ?? 0),
      depth: frame.depth + 2 * (spec.roof.overhang ?? 0),
      roofType: spec.roof.type,
      ...(spec.roof.pitch !== undefined ? { pitch: spec.roof.pitch } : {}),
      overhang: 0,
      ...(spec.roof.material ? { materialPreset: spec.roof.material } : {}),
      name: `${spec.name} roof`,
    })
    roofId = roof.roofId
  }
  return { buildingId, levelIds, frame, roofId }
}

export type SlabSpec = {
  name: string
  polygon: Pt[]
  color: string
  elevation?: number
  thickness?: number
  recessed?: boolean
  metadata: Record<string, unknown>
}

/** Flat site surfaces (paving, pools, courts) on the grade level, in one atomic patch. */
export async function addSlabs(s: PascalSession, levelId: string, slabs: SlabSpec[]) {
  if (slabs.length === 0) return
  await s.call('apply_patch', {
    patches: slabs.map((sl) => ({
      op: 'create',
      parentId: levelId,
      node: {
        type: 'slab',
        name: sl.name,
        polygon: sl.polygon,
        elevation: sl.elevation ?? 0.02,
        thickness: sl.thickness ?? 0.02,
        ...(sl.recessed ? { recessed: true } : {}),
        slots: { surface: sl.color },
        metadata: sl.metadata,
      },
    })),
  })
}

/** Named site zones (parking fields, courts, the parcel outline) on the grade level. */
export async function addZones(
  s: PascalSession,
  levelId: string,
  zones: { label: string; polygon: Pt[]; properties: Record<string, unknown> }[],
) {
  for (const z of zones) await s.call('set_zone', { levelId, ...z })
}
