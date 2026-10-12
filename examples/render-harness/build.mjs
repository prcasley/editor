// Bundles the harness straight from the workspace packages' TypeScript sources, so
// no package needs a dist build first. `@pascal-app/<pkg>/<sub>` resolves through
// the package's own `exports` map, with ./dist/*.js swapped for ./src/*.ts(x).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild-wasm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

const pascalSources = {
  name: 'pascal-sources',
  setup(b) {
    b.onResolve({ filter: /^@pascal-app\/[^/]+(\/.*)?$/ }, (args) => {
      const [, pkg, sub] = args.path.match(/^@pascal-app\/([^/]+)(\/.*)?$/)
      const pkgDir = join(root, 'packages', pkg)
      if (!existsSync(join(pkgDir, 'package.json'))) return undefined
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
      const entry = manifest.exports?.[sub ? `.${sub}` : '.']
      const target = typeof entry === 'string' ? entry : (entry?.import ?? entry?.default)
      if (!target) throw new Error(`no export for ${args.path}`)
      const base = join(pkgDir, target.replace('./dist/', './src/').replace(/\.js$/, ''))
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
      ]) {
        if (existsSync(candidate)) return { path: candidate }
      }
      throw new Error(`cannot map ${args.path} -> ${base}`)
    })
  },
}

// Node-only or prebuilt-worker imports that a static render never executes
// (PDF export, the geometry-script worker bundle) resolve to an empty module.
const emptyShims = {
  name: 'empty-shims',
  setup(b) {
    b.onResolve({ filter: /^(util|stream|@pascal-app\/geometry-script\/sandbox)$/ }, (args) => ({
      path: args.path,
      namespace: 'empty-shim',
    }))
    b.onLoad({ filter: /.*/, namespace: 'empty-shim' }, () => ({
      contents: 'export default {}',
      loader: 'js',
    }))
  },
}

await build({
  entryPoints: [join(here, 'src/main.tsx')],
  bundle: true,
  format: 'esm',
  outfile: join(here, 'dist/main.js'),
  jsx: 'automatic',
  target: 'es2022',
  loader: { '.wasm': 'file', '.glsl': 'text', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  // A few dependencies read other `process.env` keys at module load.
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
  plugins: [emptyShims, pascalSources],
  logLevel: 'warning',
})
console.log('built', join(here, 'dist/main.js'))
