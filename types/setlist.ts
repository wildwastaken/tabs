export type MonoFontOption =
  | "roboto-mono"
  | "courier-new"
  | "consolas"
  | "menlo"

export interface PositionedNoteBox {
  id: string
  page: number
  x: number
  y: number
  width: number
  height: number
  text: string
}

export interface ExportSettings {
  monoFont: MonoFontOption
  noteBoxes: PositionedNoteBox[]
}

export interface PublicTabSong {
  artist: string
  song: string
  transposedChords: string
  transposeStep: number
}

export interface PublicTabEntry {
  id: string
  publisherName: string
  setlistTitle: string
  publishedAt: string
  notes?: string
  exportSettings: Pick<ExportSettings, "monoFont" | "noteBoxes">
  songs: PublicTabSong[]
}

export interface PublicTabsDb {
  version: number
  tabs: PublicTabEntry[]
}
