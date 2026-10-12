import { validateBuildJson } from '@pascal-app/core'
import { writeFileSync } from 'node:fs'
import { Facts } from '../lib/facts'
import { openSession } from '../lib/session'
import { buildSiteDetailed } from './build-detailed'
const dir = import.meta.dir
const facts = new Facts(`${dir}/facts.json`)
const s = await openSession('dev')
const t0 = performance.now()
const out = await buildSiteDetailed(s, facts, dir)
console.log('built ms', Math.round(performance.now() - t0), out.stats)
const v = await s.call('validate_scene'); console.log('valid', v.valid, JSON.stringify(v.errors.slice(0, 5)))
const ver = await s.call('verify_scene')
const g: Record<string, number> = {}; for (const i of ver.issues) g[i.type] = (g[i.type] ?? 0) + 1
console.log('verify', g, JSON.stringify(ver.issues.filter((i: any) => !['opening_not_on_wall'].includes(i.type)).slice(0, 6)))
const { json } = await s.call('export_json', {})
const scene = JSON.parse(json)
const lc = validateBuildJson(scene); console.log('load', lc.ok, JSON.stringify(lc.errors.slice(0, 3)), lc.warnings.length)
const t: Record<string, number> = {}; for (const n of Object.values(scene.nodes) as any[]) t[n.type] = (t[n.type] ?? 0) + 1
console.log(Object.keys(scene.nodes).length, t, 'calls', Object.values(s.calls).reduce((a, b) => a + b, 0))
writeFileSync('/tmp/claude-0/-home-claude/0373d691-02df-50ae-9974-33695513e668/scratchpad/site-detailed.json', json)
await s.close()
