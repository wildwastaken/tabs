declare module "chord-magic/dist/chord-magic.cjs.js" {
  export interface ParsedChord {
    root: string
    quality?: string
    suspended?: string
    extended?: string
    added?: string
    overridingRoot?: string
    [key: string]: unknown
  }

  export interface PrintOptions {
    naming?: string[]
  }

  export function parse(input: string, options?: Record<string, unknown>): ParsedChord
  export function transpose(chord: ParsedChord, semitones: number): ParsedChord
  export function prettyPrint(chord: ParsedChord, options?: PrintOptions): string
}
