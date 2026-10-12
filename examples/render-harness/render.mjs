// Renders a Pascal build file from named cameras with Pascal's own viewer in headless
// Chromium (WebGL2 fallback on SwiftShader when no WebGPU adapter exists).
//
//   node examples/render-harness/render.mjs <scene.json> <cameras.json> <out-dir> \
//     [--theme twilight] [--size 1600x900] [--only hero,front] [--postfx]
//
// cameras.json: { "<name>": { "position": [x,y,z], "target": [x,y,z], "fov": 45, "theme"?: "..." } }
// (an array of { name, ... } also works). Library materials, HDRIs and item models are
// served from apps/editor/public; the KTX2 basis transcoder from three's own copy.
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const [scenePath, camerasPath, outDir] = args.filter(
  (a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'),
)
if (!scenePath || !camerasPath || !outDir) {
  console.error(
    'usage: render.mjs <scene.json> <cameras.json> <out-dir> [--theme id] [--size WxH] [--only a,b] [--postfx]',
  )
  process.exit(1)
}
const [width, height] = flag('size', '1600x900').split('x').map(Number)
const only = flag('only', '')?.split(',').filter(Boolean)
const defaultTheme = flag('theme', 'verdant')
const postFx = args.includes('--postfx')
// Also save Pascal's own GLB export of the scene (after the first good frame).
const glbPath = flag('glb', null)
let glbDone = false
// Also write a drawing set: --sheets spec.json --sheets-out set.pdf (see src/sheets.ts).
const sheetsSpec = flag('sheets', null)
const sheetsOut = flag('sheets-out', null)
let sheetsDone = false

const rawCams = JSON.parse(readFileSync(camerasPath, 'utf8'))
const cameras = (
  Array.isArray(rawCams) ? rawCams : Object.entries(rawCams).map(([name, c]) => ({ name, ...c }))
).filter((c) => !only?.length || only.includes(c.name))

const publicDir = join(root, 'apps/editor/public')
const basisDir = join(root, 'node_modules/three/examples/jsm/libs/basis')
const types = {
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.ttf': 'font/ttf',
}
const page = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%;background:#000;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/dist/main.js"></script></body></html>`

// Map every catalog `/material/<cat>/<slug>/<slug>_<map>_512.ktx2` to the local
// `.webp` of the same map, or null when the repo doesn't ship that map.
const MAP_ALIASES = {
  basecolor: ['basecolor', 'diffuse', 'albedo', 'color'],
  normal: ['normal'],
  roughness: ['roughness'],
  ao: ['ambientocclusion', 'ao'],
  metallic: ['metallic', 'metalness'],
  displacement: ['displacement', 'height'],
}
function textureMap() {
  const src = readFileSync(join(root, 'packages/core/src/material-library.ts'), 'utf8')
  const out = {}
  for (const [, url, folderPath, kind] of src.matchAll(
    /'((\/material\/[^']+\/)[^/']+_([a-z]+)_512\.ktx2)'/g,
  )) {
    const folder = join(publicDir, folderPath)
    const aliases = MAP_ALIASES[kind] ?? [kind]
    const files = existsSync(folder) ? readdirSync(folder) : []
    const hit = files.find((f) => {
      const name = f.toLowerCase().replace(/\.(webp|png|jpg)$/, '')
      return aliases.some((a) => name.endsWith(`_${a}`) || name.endsWith(`_${a}_512`))
    })
    out[url] = hit ? `${folderPath}${hit}` : null
  }
  return out
}
const textureMapJson = JSON.stringify(textureMap())

function send(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page)
  if (url === '/scene.json') return send(res, resolve(scenePath))
  if (url === '/texture-map.json')
    return res.writeHead(200, { 'content-type': 'application/json' }).end(textureMapJson)
  if (url === '/sheets.json' && sheetsSpec) return send(res, resolve(sheetsSpec))
  // The PDF writer resolves its fonts next to its own module, i.e. next to the bundle.
  if (url.startsWith('/dist/pdf-fonts/'))
    return send(res, join(root, 'packages/editor/src/lib/floorplan', url.slice(6)))
  if (url.startsWith('/dist/')) return send(res, join(here, url))
  if (url.startsWith('/basis/')) return send(res, join(basisDir, url.slice(7)))
  return send(res, join(publicDir, url))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
})
const blocked = new Set()
for (const cam of cameras) {
  const t0 = Date.now()
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  const tab = await ctx.newPage()
  let fatal
  const fatalError = new Promise((r) => {
    fatal = r
  })
  tab.on('pageerror', async (e) => {
    console.log(`  [${cam.name}] pageerror: ${String(e).slice(0, 200)}`)
    // An error before the scene mounted means nothing will ever render.
    const nodes = await tab.evaluate(() => window.__harness?.nodes ?? 0).catch(() => 0)
    if (!nodes) fatal({ error: `page error before load: ${String(e).slice(0, 120)}` })
  })
  await tab.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (u.origin === origin) return route.continue()
    // The viewer fetches its KTX2 transcoder from a CDN; answer it with three's local copy.
    const m = u.pathname.match(/\/basis\/(basis_transcoder\.(js|wasm))$/)
    if (m) return route.fulfill({ path: join(basisDir, m[1]) })
    if (
      u.pathname.startsWith('/material/') ||
      u.pathname.startsWith('/hdri/') ||
      u.pathname.startsWith('/items/')
    ) {
      const local = join(publicDir, u.pathname)
      if (existsSync(local)) return route.fulfill({ path: local })
    }
    blocked.add(u.origin + u.pathname)
    return route.abort()
  })
  const c = [...cam.position, ...cam.target, cam.fov ?? 45].join(',')
  const theme = cam.theme ?? defaultTheme
  await tab.goto(`${origin}/?scene=/scene.json&cam=${c}&theme=${theme}&postfx=${postFx ? 1 : 0}`)
  const state = await Promise.race([
    fatalError,
    tab
      .waitForFunction(() => window.__harness?.ready || window.__harness?.error, null, {
        timeout: 600_000,
        polling: 1000,
      })
      .then(() => tab.evaluate(() => window.__harness))
      .catch((e) => ({ error: `timeout: ${e.message.slice(0, 80)}` })),
  ])
  const out = join(outDir, `${cam.name}.png`)
  await tab.screenshot({ path: out, timeout: 300_000 })
  if (glbPath && !state.error && !glbDone) {
    const b64 = await tab
      .evaluate(() => window.__exportGlb())
      .catch((e) => {
        console.log(`  glb export failed: ${String(e).slice(0, 200)}`)
        return null
      })
    if (b64) {
      writeFileSync(glbPath, Buffer.from(b64, 'base64'))
      glbDone = true
      console.log(`  glb -> ${glbPath} (${(statSync(glbPath).size / 1e6).toFixed(1)} MB)`)
    }
  }
  if (sheetsSpec && sheetsOut && !state.error && !sheetsDone) {
    try {
      const [download] = await Promise.all([
        tab.waitForEvent('download', { timeout: 300_000 }),
        tab.evaluate(() => window.__exportDrawingSet()),
      ])
      await download.saveAs(sheetsOut)
      sheetsDone = true
      console.log(
        `  drawing set -> ${sheetsOut} (${(statSync(sheetsOut).size / 1e6).toFixed(1)} MB)`,
      )
    } catch (e) {
      console.log(`  drawing set failed: ${String(e).slice(0, 300)}`)
    }
  }
  console.log(
    `${cam.name}: ${state.error ? `ERROR ${state.error}` : 'ok'} nodes=${state.nodes ?? '?'} ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out}`,
  )
  await ctx.close()
}
await browser.close()
server.close()
if (blocked.size)
  console.log(
    `blocked external requests (${blocked.size}):\n  ${[...blocked].slice(0, 15).join('\n  ')}`,
  )
