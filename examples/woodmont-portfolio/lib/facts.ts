// A property's facts: every number the scene uses, each one either quoted from a
// public source, derived from sourced numbers, or labelled an estimate with its
// reason. Loading refuses a fact with no basis, so nothing unlabelled reaches a scene.
import { readFileSync } from 'node:fs'

export type Source = { id: string; title: string; publisher: string; date: string; url: string }
export type Image = { url: string; caption: string; credit: string }
export type Fact = {
  label: string
  value: number | string
  unit?: string
  sources?: string[]
  quote?: string
  derivation?: string
  estimate?: string
}
export type FactsFile = {
  name: string
  type: string
  location: string
  summary: string
  sources: Source[]
  images?: Image[]
  facts: Record<string, Fact>
  notes?: string[]
}

export type Basis = 'sourced' | 'derived' | 'estimate'

export function basisOf(f: Fact): Basis {
  if (f.estimate) return 'estimate'
  if (f.derivation) return 'derived'
  return 'sourced'
}

export class Facts {
  readonly file: FactsFile
  private readonly used = new Set<string>()

  constructor(path: string) {
    this.file = JSON.parse(readFileSync(path, 'utf8')) as FactsFile
    const ids = new Set(this.file.sources.map((s) => s.id))
    for (const [key, f] of Object.entries(this.file.facts)) {
      const cited = f.sources ?? []
      for (const id of cited) if (!ids.has(id)) throw new Error(`${key}: unknown source ${id}`)
      if (f.estimate) continue
      if (cited.length === 0) throw new Error(`${key}: neither a source nor an estimate`)
      if (!f.quote && !f.derivation) throw new Error(`${key}: a sourced fact needs its quote`)
    }
  }

  num(key: string): number {
    const v = this.get(key).value
    if (typeof v !== 'number') throw new Error(`${key} is not a number`)
    return v
  }

  str(key: string): string {
    return String(this.get(key).value)
  }

  /** "9 x 10 ft" style values as their two numbers. */
  dims(key: string): [number, number] {
    const m = this.str(key).match(/([\d.]+)\s*x\s*([\d.]+)/)
    if (!m) throw new Error(`${key} is not "a x b"`)
    return [Number(m[1]), Number(m[2])]
  }

  get(key: string): Fact {
    const f = this.file.facts[key]
    if (!f) throw new Error(`no fact ${key}`)
    this.used.add(key)
    return f
  }

  /** Facts the build never read: listed in facts.md as context, not as modelled values. */
  unused(): string[] {
    return Object.keys(this.file.facts).filter((k) => !this.used.has(k))
  }

  isUsed(key: string): boolean {
    return this.used.has(key)
  }
}
