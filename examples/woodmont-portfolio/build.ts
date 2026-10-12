// Rebuilds every scene in the Woodmont portfolio from its facts, through the Pascal
// MCP server, and rewrites each property's facts.md from the same numbers.
//
//   bun run --cwd packages/mcp build             # once: the MCP server's dist
//   bun examples/woodmont-portfolio/build.ts      # every property
//   bun examples/woodmont-portfolio/build.ts woodmont-way
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBuildJson } from '@pascal-app/core'
import { buildIndustrial as buildMain111 } from './111-main-street/build'
import { buildIndustrial as buildAlpha78 } from './alpha-78/build'
import { Facts } from './lib/facts'
import { renderFactsMd, type SceneCheck } from './lib/report'
import { openSession, type PascalSession } from './lib/session'
import type { SceneOutput } from './lib/types'
import { buildSiteMassing, buildTypicalBuilding } from './woodmont-way/build'
import { buildSiteDetailed } from './woodmont-way/build-detailed'

type Builder = (s: PascalSession, facts: Facts, dir: string) => Promise<SceneOutput>

const PROPERTIES: { slug: string; scenes: Builder[] }[] = [
  { slug: 'woodmont-way', scenes: [buildSiteMassing, buildTypicalBuilding, buildSiteDetailed] },
  { slug: '111-main-street', scenes: [buildMain111] },
  { slug: 'alpha-78', scenes: [buildAlpha78] },
]

/** verify_scene issues by type, with a count and one example message each. */
function groupIssues(issues: { type: string; message: string }[]): string[] {
  const byType = new Map<string, { n: number; example: string }>()
  for (const i of issues) {
    const g = byType.get(i.type) ?? { n: 0, example: i.message }
    g.n++
    byType.set(i.type, g)
  }
  return [...byType].map(([type, g]) => `${type} x${g.n} (e.g. "${g.example}")`)
}

const root = dirname(fileURLToPath(import.meta.url))
const only = process.argv.slice(2)
let failed = false

for (const property of PROPERTIES) {
  if (only.length > 0 && !only.includes(property.slug)) continue
  const dir = join(root, property.slug)
  const facts = new Facts(join(dir, 'facts.json'))
  const checks: SceneCheck[] = []
  for (const build of property.scenes) {
    const s = await openSession(`Rebuild ${property.slug} from its facts`)
    const output = await build(s, facts, dir)
    const validated = await s.call('validate_scene')
    const verified = await s.call('verify_scene')
    const { json } = await s.call('export_json', { pretty: true })
    await s.close()
    const scene = JSON.parse(json)
    const loadCheck = validateBuildJson(scene)
    const nodeTypes: Record<string, number> = {}
    for (const n of Object.values(scene.nodes) as { type: string }[])
      nodeTypes[n.type] = (nodeTypes[n.type] ?? 0) + 1
    writeFileSync(join(dir, output.file), `${json}\n`)
    const check: SceneCheck = {
      output,
      nodeCount: Object.keys(scene.nodes).length,
      nodeTypes,
      validateScene: {
        valid: validated.valid,
        errors: validated.errors.length,
        warnings: validated.warnings?.length ?? 0,
      },
      verifyScene: { hasIssues: verified.hasIssues, issues: groupIssues(verified.issues) },
      buildJson: {
        ok: loadCheck.ok,
        errors: loadCheck.errors.length,
        warnings: loadCheck.warnings.length,
      },
      toolCalls: { ...s.calls },
    }
    checks.push(check)
    if (!check.validateScene.valid || !check.buildJson.ok) failed = true
    console.log(
      `${property.slug}/${output.file}: ${check.nodeCount} nodes, validate_scene ${
        check.validateScene.valid ? 'valid' : 'INVALID'
      }, load check ${check.buildJson.ok ? 'ok' : 'FAILED'}, verify_scene ${
        check.verifyScene.hasIssues ? check.verifyScene.issues.join(' | ') : 'no issues'
      }`,
    )
    if (!loadCheck.ok) console.log(JSON.stringify(loadCheck.errors.slice(0, 5), null, 2))
  }
  writeFileSync(join(dir, 'facts.md'), renderFactsMd(facts, property.slug, checks))
}

if (failed) process.exit(1)
