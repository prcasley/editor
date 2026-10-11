import { z } from 'zod'
import { DOOR_STYLES, WINDOW_STYLES } from '../building/opening-style-presets'
import { DoorType, WindowType } from '../schema/nodes/opening-types'
import { measurement } from './measurement'
import { NodeId } from './node-id'

// A building as an agent read it from photos, before any geometry: the footprint, the storeys,
// the roof, and what each facade shows. Every number says where it came from, because most of
// them are estimates, and an estimate must never pass for a measurement later.

/** Where a number came from. A bare number in a brief counts as `estimated`. */
export const BRIEF_VALUE_SOURCES = ['measured', 'estimated', 'default'] as const
export type BriefValueSource = (typeof BRIEF_VALUE_SOURCES)[number]

const provenance = {
  source: z
    .enum(BRIEF_VALUE_SOURCES)
    .optional()
    .describe(
      'measured: taped, surveyed or read from a drawing, listing or record; estimated (the default): judged from a photo; default: a standard value assumed without evidence (a 2.1 m door you could not see).',
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('How sure, 0..1: 0.9 = read off a scale reference, 0.5 = rough guess.'),
  basis: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe('How it was found, e.g. "scaled from the 2.1 m front door in photo 1".'),
}

type Kind = Parameters<typeof measurement>[0]

/**
 * A number of the brief: either the value alone (an estimate) or the value with its source,
 * confidence and basis. Parses to `{ value, source?, confidence?, basis? }` or a number.
 */
function sourced(kind: Kind, unit: string, options: Parameters<typeof measurement>[2] = {}) {
  const value = measurement(kind, unit, options)
  return z.union([value, z.object({ value, ...provenance })])
}

const length = (description: string, options: { min?: number } = {}) =>
  sourced('length', 'm', {
    description,
    ...(options.min === undefined ? { positive: true } : { min: options.min }),
  })

/** A facade: by name on a rectangle (front, right, back, left), or by footprint edge index. */
export const FacadeRef = z
  .union([z.enum(['front', 'right', 'back', 'left']), z.number().int().min(0)])
  .describe(
    'A facade: front, right, back or left on a rectangle (as seen standing outside it); on a polygon, the edge index i (edge i runs from point i to point i + 1).',
  )

const storyIndexes = z
  .array(z.number().int().min(0))
  .min(1)
  .optional()
  .describe('The storeys it repeats on, 0 = ground (default [0]): [1, 2] for the two upper floors.')

const layout = {
  count: z.number().int().min(1).optional().describe('How many on each listed storey (default 1).'),
  offset: length(
    "Distance from the facade's left corner (seen from outside) to the centre of the first one. Default: the group is centred on the facade.",
    { min: 0 },
  ).optional(),
  spacing: length(
    'Centre-to-centre distance between neighbours. Default: the facade split into equal bays, one per opening.',
  ).optional(),
}

const doorGroup = z.object({
  kind: z.literal('door'),
  stories: storyIndexes,
  ...layout,
  width: length(
    'Door width (default 0.9 m; a garage door about 2.4 m single, 4.9 m double).',
  ).optional(),
  height: length('Door height (default 2.1 m).').optional(),
  doorType: DoorType.optional().describe('How it opens, e.g. garage-sectional, double, sliding.'),
  style: z.enum(DOOR_STYLES).optional().describe('The look of the leaf, as in add_door.'),
})

const windowGroup = z.object({
  kind: z.literal('window'),
  stories: storyIndexes,
  ...layout,
  width: length('Window width (default 1.5 m).').optional(),
  height: length('Window height (default 1.5 m).').optional(),
  sillHeight: length('Floor to the bottom of the window (default 0.9 m).', { min: 0 }).optional(),
  windowType: WindowType.optional().describe('How it opens, e.g. double-hung, casement, sliding.'),
  style: z
    .enum(WINDOW_STYLES)
    .optional()
    .describe('Panes of a Fixed window, as in add_window; leave it out with a windowType.'),
})

export const BriefOpeningGroup = z.discriminatedUnion('kind', [doorGroup, windowGroup])

export const BriefFacade = z.object({
  facade: FacadeRef,
  material: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Cladding of this facade, a library material (e.g. "flooring-rusticbrick", "concrete-stucco", "siding-lap-white"); default: the brief\'s wallMaterial.',
    ),
  openings: z.array(BriefOpeningGroup).optional().describe('Its doors and windows, as groups.'),
})

export const BriefBalcony = z.object({
  facade: FacadeRef,
  story: z
    .number()
    .int()
    .min(0)
    .describe('The storey its floor is on: 0 makes a ground terrace, 1+ a balcony.'),
  width: length('Width along the facade.'),
  depth: length('How far it projects from the facade.'),
  offset: length(
    "Distance from the facade's left corner (seen from outside) to its centre. Default: centred.",
    { min: 0 },
  ).optional(),
  name: z.string().min(1).max(120).optional(),
})

const point = z.array(z.number().finite()).length(2)

export const BuildingBrief = {
  name: z.string().min(1).max(120).optional().describe('Name of the building.'),
  buildingId: NodeId.optional().describe(
    "An empty building to build in (its empty levels are replaced). Default: the scene's only building when it is empty, else a new site and building on a scene that has none.",
  ),
  footprint: z
    .discriminatedUnion('shape', [
      z.object({
        shape: z.literal('rectangle'),
        width: length('Outside width of the front facade.'),
        depth: length('Outside depth, front to back.'),
      }),
      z.object({
        shape: z.literal('polygon'),
        points: z
          .array(point)
          .min(3)
          .describe(
            'Outside corners as [x, z] in metres, front edge first (points 0 → 1), anticlockwise on a north-up plan so that each edge runs left to right seen from outside.',
          ),
        ...provenance,
      }),
    ])
    .describe(
      'The outside of the walls, in plan. A rectangle is centred on the origin with its front facing +z (south on the plan).',
    ),
  stories: z
    .array(
      z.object({
        name: z.string().min(1).max(120).optional(),
        height: length('Floor-to-floor height (default 3.0 m).').optional(),
      }),
    )
    .min(1)
    .describe('The storeys from the ground up; one entry each, even when they are alike.'),
  wallThickness: length('Exterior wall thickness (default 0.25 m).').optional(),
  wallMaterial: z
    .string()
    .min(1)
    .optional()
    .describe('Cladding of every facade that names none, a library material.'),
  grade: z
    .object({
      foundationHeight: length(
        'Height of the ground-floor top above the ground at the front: the steps up to the entry door (0 = level with the ground).',
        { min: 0 },
      ).optional(),
      steps: z
        .array(
          z.object({
            facade: FacadeRef,
            drop: length(
              'How much lower the ground is along this facade than at the front (a walk-out basement at the back).',
            ),
          }),
        )
        .optional()
        .describe('Where the ground falls away from the front. Recorded, not yet modelled.'),
    })
    .optional(),
  roof: z.object({
    type: z.enum(['flat', 'gable', 'hip', 'shed']),
    pitch: sourced('angle', 'deg', {
      min: 0,
      max: 85,
      description: 'Slope in degrees (default gable 35, hip 30, shed 10).',
    }).optional(),
    overhang: length('Eave overhang past the walls (default 0.3 m; flat 0).', {
      min: 0,
    }).optional(),
    ridge: z
      .enum(['along-front', 'across-front'])
      .optional()
      .describe(
        'Gable: along-front (default) puts the gable ends on the sides; across-front puts a gable end on the front.',
      ),
    lowSide: z
      .enum(['front', 'right', 'back', 'left'])
      .optional()
      .describe('Shed: the facade under its low edge (default front).'),
    material: z
      .string()
      .min(1)
      .optional()
      .describe('Roofing, a library material (e.g. "roof-greyshingles", "roof-claytiles").'),
  }),
  facades: z
    .array(BriefFacade)
    .optional()
    .describe('What each facade shows; one entry per facade.'),
  balconies: z.array(BriefBalcony).optional(),
  knownFloorArea: sourced('area', 'm2', {
    positive: true,
    description:
      'Gross floor area from a listing, plan or record, to check the brief against (all storeys, outside dimensions).',
  }).optional(),
}

export type BuildingBriefInput = z.output<z.ZodObject<typeof BuildingBrief>>

export const draftBuildingFromBriefTool = {
  name: 'draft_building_from_brief',
  title: 'Draft building from brief',
  description:
    "Build an editable building from a brief of what photos show, in one undo step: a level per storey, a room shell per storey over the footprint (walls, the zone; floor plates and ceilings derived), doors and windows per facade with add_door's and add_window's rules, balconies and terraces as outdoor rooms, a roof on the top storey's walls, and the facade and roof materials. Every number may be a bare value (an estimate) or { value, source: measured | estimated | default, confidence, basis }; the answer lists every value that was estimated or defaulted in estimates, and the building keeps the brief in its metadata. It checks the gross floor area against knownFloorArea when given. An opening that cannot be placed is skipped and listed in skippedOpenings with its code. Refusals: building_not_empty, building_required, building_not_found, not_a_building, facade_not_found, facade_name_needs_rectangle, story_out_of_range, openings_do_not_fit, balcony_off_facade, footprint_too_small, invalid_polygon, unknown_material. Then call verify_scene and view_scene to compare with the photos.",
  input: BuildingBrief,
}
