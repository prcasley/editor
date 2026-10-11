'use client'

import { getSceneTheme, useViewer } from '@pascal-app/viewer'
import { useEffect, useRef } from 'react'

// A hand-placed zig-zag across a 1000×16 box, stretched to the window width.
const BOLT_PATH =
  'M0 8 L70 6 L110 11 L175 4 L220 9 L290 7 L330 12 L400 5 L450 9 L520 3 L560 10 L640 7 L690 12 L750 5 L800 9 L870 6 L910 11 L1000 8'
const STRIKE_MS = 220
const FADE_MS = 700

/**
 * A lightning strike along the top edge when a save the user asked for lands.
 * Drawn only for scene themes with a `highlight` accent, in its colours; with
 * reduced motion it stays dark.
 */
export function SaveBolt({ strike }: { strike: number }) {
  const highlight = useViewer((state) => getSceneTheme(state.sceneTheme).highlight)
  const svgRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    const path = pathRef.current
    if (strike === 0 || !(svg && path)) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const draw = path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
      duration: STRIKE_MS,
      easing: 'cubic-bezier(0.3, 0, 0.2, 1)',
      fill: 'forwards',
    })
    const flash = svg.animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], {
      duration: FADE_MS,
      easing: 'ease-out',
    })
    return () => {
      draw.cancel()
      flash.cancel()
    }
  }, [strike])

  if (!highlight) return null

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-70 h-4 w-full opacity-0"
      preserveAspectRatio="none"
      ref={svgRef}
      style={{
        filter: `drop-shadow(0 0 3px ${highlight.hovered}) drop-shadow(0 0 8px ${highlight.occluded})`,
      }}
      viewBox="0 0 1000 16"
    >
      <path
        d={BOLT_PATH}
        fill="none"
        pathLength={1}
        ref={pathRef}
        stroke={highlight.selected}
        strokeDasharray="1"
        strokeDashoffset="1"
        strokeLinejoin="bevel"
        strokeWidth={1.5}
      />
    </svg>
  )
}
