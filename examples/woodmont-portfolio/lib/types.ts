export type SceneOutput = {
  /** File name inside the property folder. */
  file: string
  title: string
  /** Headline numbers for facts.md; estimates say so in their text. */
  stats: Record<string, string | number>
  /** Why a check reports what it does, when that is expected. */
  notes?: string[]
}
