// Alpha 78 Logistics Center, Alpha NJ: a cross-dock warehouse from its published
// counts; its depth is an estimate and its length follows from the published area.
import type { Facts } from '../lib/facts'
import { ft, round } from '../lib/geometry'
import { buildWarehouse } from '../lib/industrial'
import type { PascalSession } from '../lib/session'
import type { SceneOutput } from '../lib/types'

export async function buildIndustrial(s: PascalSession, facts: Facts): Promise<SceneOutput> {
  const L = ft(facts.num('buildingLengthFt'))
  const D = ft(facts.num('buildingDepthFt'))
  const docks = facts.num('docks')
  const driveIns = facts.num('driveIns')
  const trailers = facts.num('trailerStalls')
  const [dockW, dockH] = facts.dims('dockDoor')
  const [driveW, driveH] = facts.dims('driveInDoor')
  const [trailerW, trailerD] = facts.dims('trailerStall')
  facts.get('buildingSf')
  facts.get('crossDock')
  facts.get('dockSplit')
  facts.get('carModule')
  facts.get('siteShape')
  facts.get('officeLocation')

  const r = await buildWarehouse(s, {
    siteName: 'Alpha 78 Logistics Center, Alpha NJ (site massing, schematic layout)',
    buildingName: 'Alpha 78 Logistics Center',
    address: { street: '5 Edge Road', city: 'Alpha', state: 'NJ' },
    lengthM: L,
    depthM: D,
    siteAcres: facts.num('siteAcres'),
    wallHeightM: facts.num('eaveHeight'),
    dockHighM: facts.num('dockHigh'),
    wallThicknessM: facts.num('wallThickness'),
    dockSides: 'both',
    spaces: [
      {
        name: 'Warehouse',
        x0: -L / 2,
        x1: L / 2,
        docks: Math.ceil(docks / 2),
        driveIns: Math.ceil(driveIns / 2),
      },
    ],
    northDocks: { docks: Math.floor(docks / 2), driveIns: Math.floor(driveIns / 2) },
    dockSpacingM: ft(facts.num('dockSpacingFt')),
    dockDoor: { width: ft(dockW), height: ft(dockH) },
    driveInDoor: { width: ft(driveW), height: ft(driveH) },
    truckCourtM: ft(facts.num('truckCourtFt')),
    trailerStalls: { south: Math.ceil(trailers / 2), north: Math.floor(trailers / 2) },
    trailerStall: { width: ft(trailerW), depth: ft(trailerD) },
    carStalls: { north: 0, ends: facts.num('carStalls') },
    office: { sqm: facts.num('officeSf') * 0.09290304 },
    buildingMetadata: {
      areaSf: facts.num('buildingSf'),
      clearHeightFt: facts.num('clearHeight'),
      dimensions: `${facts.num('buildingLengthFt')} x ${facts.num('buildingDepthFt')} ft (estimate)`,
      loading: 'cross-dock',
      sprinklers: facts.str('esfr'),
      location: facts.str('location'),
    },
    siteMetadata: {},
  })

  return {
    file: 'site-massing.json',
    title: 'Site massing',
    stats: {
      Building: `${round(L, 1)} x ${round(D, 1)} m (${facts.num('buildingLengthFt')} x ${facts.num('buildingDepthFt')} ft, depth estimated), ${Math.round((L * D) / 0.09290304).toLocaleString('en-US')} SF modelled`,
      'Dock doors / drive-ins modelled': `${r.docks} / ${r.driveIns} (published ${docks} / ${driveIns})`,
      'Wall height': `${facts.num('eaveHeight')} m above a ${facts.num('dockHigh')} m dock-high floor (estimates)`,
      'Truck courts': `2 x ${facts.num('truckCourtFt')} ft (published depth)`,
      'Trailer stalls / car stalls': `${trailers} / ${facts.num('carStalls')} (published)`,
      'Site outline': `${round(r.siteW)} x ${round(r.siteD)} m = ${facts.num('siteAcres')} acres (shape schematic)`,
    },
    notes: [
      "`verify_scene`'s `zones_no_ceilings` comes from the site zones (truck courts, parking, outline) on the grade level, which have no ceilings by design.",
    ],
  }
}
