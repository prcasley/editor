// Mounts Pascal's own <Viewer> on one saved build file and frames one camera, so a
// headless browser can screenshot it. Query: ?scene=<url>&cam=<x,y,z,tx,ty,tz,fov>
// &theme=<scene theme id>&postfx=0|1
import { type AnyNodeDefinition, nodeRegistry, registerNode, useScene } from '@pascal-app/core'
import { exportSceneToGlb } from '@pascal-app/editor'
import { builtinPlugin } from '@pascal-app/nodes'
import { useViewer, Viewer } from '@pascal-app/viewer'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PerspectiveCamera } from 'three'
import { MATERIAL_CATALOG } from '../../../packages/core/src/material-library'

// Catalog finishes point at `_512.ktx2` maps on the assets CDN. Offline, the
// same finishes ship in apps/editor/public as `.webp`; the render script sends
// the ktx2 → webp mapping it found on disk, and maps it could not find are
// dropped so the finish falls back to its colour rather than a failed load.
async function useLocalTextures() {
  const map: Record<string, string | null> = await fetch('/texture-map.json').then((r) => r.json())
  for (const item of MATERIAL_CATALOG) {
    const maps = item.preset.maps as Record<string, string | undefined>
    for (const [key, url] of Object.entries(maps)) {
      if (!url || !(url in map)) continue
      const local = map[url]
      if (local) maps[key] = local
      else delete maps[key]
    }
  }
}

for (const def of builtinPlugin.nodes ?? []) {
  if (!nodeRegistry.has((def as AnyNodeDefinition).kind)) registerNode(def as AnyNodeDefinition)
}

const params = new URLSearchParams(location.search)
const cam = (params.get('cam') ?? '40,30,40,0,0,0,45').split(',').map(Number)
const theme = params.get('theme') ?? 'verdant'
const postFx = params.get('postfx') === '1'

declare global {
  interface Window {
    __harness: { ready: boolean; error: string | null; nodes: number }
    __exportGlb?: () => Promise<string>
  }
}
window.__harness = { ready: false, error: null, nodes: 0 }

function FixedCamera() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  useFrame(() => {
    camera.position.set(cam[0]!, cam[1]!, cam[2]!)
    camera.fov = cam[6]!
    camera.far = 5000
    camera.near = 0.3
    camera.updateProjectionMatrix()
    camera.lookAt(cam[3]!, cam[4]!, cam[5]!)
  })
  return null
}

// Exposes Pascal's own GLB export (what the editor's Export button runs) so the
// render script can save the built geometry, e.g. to light it in another scene.
function GlbExportHook() {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    window.__exportGlb = async () => {
      const group = scene.getObjectByName('scene-renderer')
      if (!group) throw new Error('scene-renderer group not found')
      useViewer.getState().setExporting(true)
      await new Promise((r) => setTimeout(r, 1500))
      const buffer = await exportSceneToGlb(group, useScene.getState().nodes, {
        textures: 'embed',
        onlyVisible: true,
        timeoutMs: 600_000,
      })
      useViewer.getState().setExporting(false)
      const bytes = new Uint8Array(buffer)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      return btoa(binary)
    }
  }, [scene])
  return null
}

function App() {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const url = params.get('scene')
    if (!url) return
    useLocalTextures()
      .then(() => fetch(url))
      .then((r) => r.json())
      .then((json) => {
        const v = useViewer.getState()
        v.showSceneTheme(theme)
        v.setShadows(true)
        v.setTextures(true)
        useScene.getState().setScene(json.nodes, json.rootNodeIds, {
          collections: json.collections,
          materials: json.materials,
        })
        window.__harness.nodes = Object.keys(json.nodes).length
        setLoaded(true)
      })
      .catch((e) => {
        window.__harness.error = String(e)
      })
  }, [])
  if (!loaded) return null
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Viewer
        disablePostFx={!postFx}
        sceneReadyKey="scene"
        sceneReadyMaxWaitMs={240_000}
        onSceneReadyChange={(ready) => {
          if (ready) setTimeout(() => (window.__harness.ready = true), 4000)
        }}
        onRenderError={(e) => {
          window.__harness.error = String(e)
        }}
      >
        <FixedCamera />
        <GlbExportHook />
      </Viewer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
