// Builds a drawing set (plan sheets from Pascal's own floor-plan pipeline, plus
// image sheets for elevations) and writes it with the editor's sheet PDF writer.
import type {
  AnyNode,
  AnyNodeId,
  ConstructionDrawingType,
  FloorplanGeometry,
} from '@pascal-app/core'
import { collectSheetGeometry, exportSheetsToPdf, type SheetPdfPage } from '@pascal-app/editor'
import { DEFAULT_FLOORPLAN_ANNOTATION_VISIBILITY } from '../../../packages/editor/src/lib/floorplan/annotation-visibility'

type Rect = { x: number; y: number; w: number; h: number }

export type SheetSpec = {
  project: { name: string; location: string; lines: string[]; issued: string; stamp: string }
  sheet: { widthIn: number; heightIn: number }
  pages: (
    | {
        kind: 'plan'
        number: string
        title: string
        drawingTitle: string
        levelName: string
        drawingType: ConstructionDrawingType
        scaleLabel: string
        /** Plan metres per sheet inch, e.g. 1.6256 for 3/16" = 1'-0". */
        metresPerInch: number
      }
    | {
        kind: 'images'
        number: string
        title: string
        images: {
          dataUrl: string
          rect: Rect
          label: string
          scaleLabel: string
          index: number
          /** World heights at the image's bottom and top edges, for datum lines. */
          frame?: { yMinM: number; yMaxM: number }
          datums?: { label: string; elevM: number }[]
        }[]
      }
  )[]
}

const INK = '#111111'
const GREY = '#6b6b6b'
const TITLE_X = 31.4

function text(
  x: number,
  y: number,
  value: string,
  fontSize: number,
  extra: Partial<Extract<FloorplanGeometry, { kind: 'text' }>> = {},
): FloorplanGeometry {
  return { kind: 'text', x, y, text: value, fontSize, fill: INK, fontFamily: 'sans', ...extra }
}
function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w = 0.012,
  stroke = INK,
): FloorplanGeometry {
  return { kind: 'line', x1, y1, x2, y2, stroke, strokeWidth: w }
}

/** Border and title block in sheet inches, in the layout of a typical architect's sheet. */
function plate(spec: SheetSpec, number: string, title: string): FloorplanGeometry[] {
  const { widthIn: W, heightIn: H } = spec.sheet
  const p = spec.project
  const g: FloorplanGeometry[] = [
    {
      kind: 'rect',
      x: 0.4,
      y: 0.4,
      width: W - 0.8,
      height: H - 0.8,
      stroke: INK,
      strokeWidth: 0.02,
      fill: 'none',
    },
    line(TITLE_X - 0.2, 0.4, TITLE_X - 0.2, H - 0.4, 0.015),
    { kind: 'rect', x: TITLE_X, y: 0.7, width: 1.6, height: 1.6, fill: '#3a3a3a' },
    text(TITLE_X + 0.8, 1.42, 'AI', 0.62, {
      fill: '#ffffff',
      textAnchor: 'middle',
      fontWeight: 700,
    }),
    text(TITLE_X + 0.8, 1.98, 'INFERRED', 0.2, {
      fill: '#ffffff',
      textAnchor: 'middle',
      fontWeight: 700,
    }),
    text(TITLE_X, 2.75, 'PASCAL MODEL + CLAUDE', 0.15, { fontWeight: 700 }),
    text(TITLE_X, 3.0, 'Public-photo reconstruction', 0.12, { fill: GREY }),
    line(TITLE_X, 3.35, W - 0.6, 3.35),
    text(TITLE_X, 3.75, 'PROJECT NAME', 0.13, { fontWeight: 700 }),
    text(TITLE_X, 4.05, p.name, 0.15),
    text(TITLE_X, 4.3, p.location, 0.13),
    ...p.lines.map((l, i) => text(TITLE_X, 4.6 + i * 0.24, l, 0.11, { fill: GREY })),
    line(TITLE_X, 5.9, W - 0.6, 5.9),
    text(TITLE_X + 1.8, 15.6, 'SET ISSUE DATES', 0.12, { textAnchor: 'middle' }),
    text(TITLE_X + 0.3, 15.95, 'ISSUE:', 0.11),
    text(TITLE_X + 2.6, 15.95, 'DATE:', 0.11),
    text(TITLE_X, 16.25, 'Model study', 0.1),
    text(W - 0.6, 16.25, p.issued, 0.1, { textAnchor: 'end' }),
  ]
  for (let i = 0; i < 12; i++)
    g.push(line(TITLE_X, 16.4 + i * 0.16, W - 0.6, 16.4 + i * 0.16, 0.006, GREY))
  g.push(
    text(W - 0.6, 19.6, p.stamp, 0.15, { textAnchor: 'end', fontWeight: 700 }),
    text(TITLE_X + 1.8, 20.5, title.split('\n')[0] ?? title, 0.2, { textAnchor: 'middle' }),
    text(TITLE_X + 1.8, 20.8, title.split('\n')[1] ?? '', 0.2, { textAnchor: 'middle' }),
    text(TITLE_X + 1.8, 22.2, number, 0.55, { textAnchor: 'middle' }),
  )
  return g
}

/** Drawing label: circled index, underlined title, scale (as on the source set). */
function drawingLabel(
  x: number,
  y: number,
  index: number,
  title: string,
  scaleLabel: string,
): FloorplanGeometry[] {
  return [
    { kind: 'circle', cx: x, cy: y, r: 0.24, stroke: INK, strokeWidth: 0.015, fill: 'none' },
    text(x, y + 0.08, String(index), 0.22, { textAnchor: 'middle' }),
    text(x + 0.45, y - 0.05, title, 0.24),
    line(x + 0.4, y + 0.04, x + 0.45 + title.length * 0.165, y + 0.04, 0.012),
    text(x + 0.45, y + 0.3, scaleLabel, 0.12),
  ]
}

/** Feet-and-inches to the nearest 1/8", e.g. 12'-2 3/8". */
function feetInches(m: number): string {
  const totalEighths = Math.round((m / 0.0254) * 8)
  const feet = Math.floor(totalEighths / 96)
  const rest = totalEighths - feet * 96
  const inches = Math.floor(rest / 8)
  let num = rest - inches * 8
  let den = 8
  while (num > 0 && num % 2 === 0) {
    num /= 2
    den /= 2
  }
  return `${feet}'-${inches}${num ? ` ${num}/${den}` : ''}"`
}

/** Level datum: dash-dot line across the drawing with a target symbol and label, as on CCA sheets. */
function datum(rect: Rect, y: number, label: string, elevM: number): FloorplanGeometry[] {
  const x0 = Math.max(0.55, rect.x - 1.2)
  return [
    {
      ...line(x0 + 0.2, y, rect.x + rect.w, y, 0.008, GREY),
      strokeDasharray: '0.25 0.06 0.03 0.06',
    },
    { kind: 'circle', cx: x0, cy: y, r: 0.09, stroke: INK, strokeWidth: 0.012, fill: 'none' },
    {
      kind: 'path',
      d: `M ${x0} ${y - 0.09} A 0.09 0.09 0 0 1 ${x0 + 0.09} ${y} L ${x0} ${y} Z`,
      fill: INK,
    },
    {
      kind: 'path',
      d: `M ${x0} ${y + 0.09} A 0.09 0.09 0 0 1 ${x0 - 0.09} ${y} L ${x0} ${y} Z`,
      fill: INK,
    },
    text(x0 + 0.2, y - 0.06, label, 0.1),
    text(x0 + 0.2, y + 0.13, feetInches(elevM), 0.09),
  ]
}

/** Room name and area at each zone's centroid, in plan metres (drawn in the plan window). */
function roomLabels(nodes: Record<string, AnyNode>, levelId: string): FloorplanGeometry[] {
  const out: FloorplanGeometry[] = []
  for (const n of Object.values(nodes)) {
    if (n.type !== 'zone' || n.parentId !== levelId) continue
    const poly = (n as unknown as { polygon: [number, number][] }).polygon
    if (!poly || poly.length < 3) continue
    let a = 0,
      cx = 0,
      cy = 0
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]!
      const [x2, y2] = poly[(i + 1) % poly.length]!
      const f = x1 * y2 - x2 * y1
      a += f
      cx += (x1 + x2) * f
      cy += (y1 + y2) * f
    }
    if (Math.abs(a) < 1e-6) continue
    cx /= 3 * a
    cy /= 3 * a
    const sf = Math.round(Math.abs(a / 2) * 10.7639)
    out.push(
      text(cx, cy, (n.name ?? '').toUpperCase(), 0.42, { textAnchor: 'middle', fontWeight: 700 }),
      text(cx, cy + 0.6, `${sf.toLocaleString('en-US')} SF`, 0.3, {
        textAnchor: 'middle',
        fill: GREY,
      }),
    )
  }
  return out
}

function northArrow(x: number, y: number): FloorplanGeometry[] {
  return [
    { kind: 'circle', cx: x, cy: y, r: 0.32, stroke: INK, strokeWidth: 0.015, fill: 'none' },
    {
      kind: 'polygon',
      points: [
        [x, y - 0.32],
        [x + 0.12, y + 0.18],
        [x, y + 0.06],
        [x - 0.12, y + 0.18],
      ],
      fill: INK,
    },
    text(x, y - 0.42, 'NORTH', 0.1, { textAnchor: 'middle' }),
  ]
}

function boundsOf(geoms: (FloorplanGeometry | null)[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  const add = (p: readonly [number, number] | readonly number[]) => {
    const [x, y] = p as [number, number]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const walk = (g: FloorplanGeometry | null | undefined) => {
    if (!g) return
    const a = g as Record<string, unknown>
    if (g.kind === 'group') {
      ;(g.children ?? []).forEach(walk)
      return
    }
    if (Array.isArray(a.points)) (a.points as number[][]).forEach(add)
    if (g.kind === 'rect') {
      add([g.x, g.y])
      add([g.x + g.width, g.y + g.height])
    }
    if (g.kind === 'line') {
      add([g.x1, g.y1])
      add([g.x2, g.y2])
    }
    if (g.kind === 'circle') {
      add([g.cx - g.r, g.cy - g.r])
      add([g.cx + g.r, g.cy + g.r])
    }
  }
  geoms.forEach(walk)
  return { minX, minY, maxX, maxY }
}

export async function exportDrawingSet(
  nodes: Record<string, AnyNode>,
  spec: SheetSpec,
  filename: string,
) {
  const levels = Object.values(nodes).filter((n) => n.type === 'level')
  const { widthIn: W, heightIn: H } = spec.sheet
  const area: Rect = { x: 1.0, y: 1.0, w: TITLE_X - 1.8, h: H - 3.2 }
  const pages: SheetPdfPage[] = []
  for (const p of spec.pages) {
    if (p.kind === 'plan') {
      const level = levels.find((l) => l.name === p.levelName)
      if (!level) throw new Error(`no level named ${p.levelName}`)
      const entries = collectSheetGeometry({
        nodes,
        levelId: level.id as AnyNodeId,
        drawingType: p.drawingType,
        annotationVisibility: {
          ...DEFAULT_FLOORPLAN_ANNOTATION_VISIBILITY,
          roofPlan: p.drawingType === 'roof-plan',
        },
        unit: 'imperial',
      })
      const model: FloorplanGeometry = {
        kind: 'group',
        children: entries.flatMap((e) => (e.model ? [e.model] : [])),
      }
      const annotations: FloorplanGeometry = {
        kind: 'group',
        children: [
          ...entries.flatMap((e) => (e.annotations ? [e.annotations] : [])),
          ...(p.drawingType === 'floor-plan' ? roomLabels(nodes, level.id) : []),
        ],
      }
      const b = boundsOf([model])
      const cx = Number.isFinite(b.minX) ? (b.minX + b.maxX) / 2 : 0
      const cy = Number.isFinite(b.minY) ? (b.minY + b.maxY) / 2 : 0
      const vw = area.w * p.metresPerInch
      const vh = area.h * p.metresPerInch
      pages.push({
        number: p.number,
        title: p.title.replace('\n', ' '),
        widthIn: W,
        heightIn: H,
        plate: plate(spec, p.number, p.title),
        windows: [
          {
            rect: area,
            viewport: { x: cx - vw / 2, y: cy - vh / 2, width: vw, height: vh },
            rotationDeg: 0,
            model,
            annotations,
          },
        ],
        overlay: [
          ...drawingLabel(area.x + area.w * 0.45, H - 1.15, 1, p.drawingTitle, p.scaleLabel),
          ...northArrow(area.x + area.w - 0.6, H - 1.3),
        ],
      })
    } else {
      pages.push({
        number: p.number,
        title: p.title.replace('\n', ' '),
        widthIn: W,
        heightIn: H,
        plate: plate(spec, p.number, p.title),
        windows: [],
        overlay: p.images.flatMap((im) => [
          {
            kind: 'image' as const,
            url: im.dataUrl,
            center: [im.rect.x + im.rect.w / 2, im.rect.y + im.rect.h / 2] as [number, number],
            width: im.rect.w,
            height: im.rect.h,
          },
          ...drawingLabel(
            im.rect.x + im.rect.w * 0.5,
            im.rect.y + im.rect.h + 0.55,
            im.index,
            im.label,
            im.scaleLabel,
          ),
          ...(im.frame && im.datums
            ? im.datums.flatMap((d) => {
                const { yMinM, yMaxM } = im.frame!
                const y = im.rect.y + (im.rect.h * (yMaxM - d.elevM)) / (yMaxM - yMinM)
                return datum(im.rect, y, d.label, d.elevM)
              })
            : []),
        ]),
      })
    }
  }
  await exportSheetsToPdf(pages, filename, `${spec.project.name} drawing set`)
}
