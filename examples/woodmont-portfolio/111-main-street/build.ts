// 111 Main Street, South Amboy NJ: a rear-load warehouse whose plan follows from its
// leasing sheet (152,100 SF, a 195 ft deep space, 60 ft speed bay and 56'6" x 45' bays).
import type { Facts } from '../lib/facts'
import { ft, round } from '../lib/geometry'
import { buildWarehouse } from '../lib/industrial'
import type { PascalSession } from '../lib/session'
import type { SceneOutput } from '../lib/types'

export async function buildIndustrial(s: PascalSession, facts: Facts): Promise<SceneOutput> {
  const L = ft(facts.num('buildingLengthFt'))
  const D = ft(facts.num('buildingDepthFt'))
  const availL = ft(facts.num('availableLengthFt'))
  facts.get('buildingSf')
  facts.get('availableSpace')
  facts.get('loading')
  facts.get('siteShape')
  facts.get('availableEnd')
  facts.get('carModule')
  const [dockW, dockH] = facts.dims('dockDoor')
  const [driveW, driveH] = facts.dims('driveInDoor')
  const [trailerW, trailerD] = facts.dims('trailerStall')
  const docks = facts.num('docks')
  const driveIns = facts.num('driveIns')
  const availDocks = facts.num('availableDocks')
  const availDriveIns = facts.num('availableDriveIns')

  // Column lines: end bays, then typical bays, west to east; speed bay at the dock wall, then 45 ft bays.
  const endBay = ft(facts.num('endBayFt'))
  const bay = ft(facts.num('bayWidthFt'))
  const xs: number[] = []
  for (let x = -L / 2 + endBay; x < L / 2 - endBay + 0.01; x += bay) xs.push(x)
  const speed = ft(facts.num('speedBayFt'))
  const bayD = ft(facts.num('bayDepthFt'))
  const zs = [D / 2 - speed, D / 2 - speed - bayD, D / 2 - speed - 2 * bayD]

  const leasedL = L - availL
  const r = await buildWarehouse(s, {
    siteName: '111 Main Street, South Amboy NJ (site massing, schematic layout)',
    buildingName: '111 Main Street warehouse',
    address: { street: '111 Main St', city: 'South Amboy', state: 'NJ' },
    lengthM: L,
    depthM: D,
    siteAcres: facts.num('siteAcres'),
    wallHeightM: facts.num('eaveHeight'),
    dockHighM: facts.num('dockHigh'),
    wallThicknessM: facts.num('wallThickness'),
    dockSides: 'south',
    spaces: [
      {
        name: `Leased space (published 96,000 SF; modelled ${Math.round((leasedL * D) / 0.09290304).toLocaleString('en-US')} SF)`,
        x0: -L / 2,
        x1: L / 2 - availL,
        docks: docks - availDocks,
        driveIns: driveIns - availDriveIns,
      },
      {
        name: `Available space (55,250 SF, 283'-4" x 195')`,
        x0: L / 2 - availL,
        x1: L / 2,
        docks: availDocks,
        driveIns: availDriveIns,
      },
    ],
    dockSpacingM: ft(facts.num('dockSpacingFt')),
    dockDoor: { width: ft(dockW), height: ft(dockH) },
    driveInDoor: { width: ft(driveW), height: ft(driveH) },
    truckCourtM: ft(facts.num('truckCourtFt')),
    trailerStalls: { south: facts.num('trailerStalls'), north: 0 },
    trailerStall: { width: ft(trailerW), depth: ft(trailerD) },
    carStalls: { north: facts.num('carStalls'), ends: 0 },
    columns: { xs, zs, size: facts.num('columnSize') },
    buildingMetadata: {
      areaSf: facts.num('buildingSf'),
      clearHeightFt: facts.num('clearHeight'),
      dimensions: '780 x 195 ft (derived from the leasing sheet)',
      knockoutPanels: facts.num('knockouts'),
      sprinklers: facts.str('esfr'),
      location: facts.str('location'),
    },
    siteMetadata: {},
  })

  return {
    file: 'site-massing.json',
    title: 'Site massing',
    stats: {
      Building: `${round(L, 1)} x ${round(D, 1)} m (780 x 195 ft, derived), ${Math.round((L * D) / 0.09290304).toLocaleString('en-US')} SF modelled`,
      'Dock doors / drive-ins modelled': `${r.docks} / ${r.driveIns} (published 25 / 2)`,
      'Columns modelled': `${xs.length * zs.length} (published bays; end bays estimated)`,
      'Wall height': `${facts.num('eaveHeight')} m above a ${facts.num('dockHigh')} m dock-high floor (estimates)`,
      'Site outline': `${round(r.siteW)} x ${round(r.siteD)} m = ${facts.num('siteAcres')} acres (shape schematic)`,
      'Trailer stalls / car stalls': `${facts.num('trailerStalls')} (published) / ${facts.num('carStalls')} (estimate)`,
    },
    notes: [
      "`verify_scene`'s `zones_no_ceilings` comes from the site zones (truck courts, parking, outline) on the grade level, which have no ceilings by design.",
    ],
  }
}
