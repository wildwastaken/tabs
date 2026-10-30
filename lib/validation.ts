// Input validation shared by the API routes.

import type { MonoFontOption, PositionedNoteBox } from "../types/setlist"

export const MAX_TEXT_LENGTH = 250
export const MAX_NOTES_LENGTH = 6000
export const MAX_CHORDS_LENGTH = 40000

export const ALLOWED_MONO_FONTS: MonoFontOption[] = [
  "roboto-mono",
  "courier-new",
  "consolas",
  "menlo",
]

export function sanitizeText(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return ""
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, maxLength)
}

export function sanitizeMonoFont(input: unknown): MonoFontOption {
  return typeof input === "string" && ALLOWED_MONO_FONTS.includes(input as MonoFontOption)
    ? (input as MonoFontOption)
    : "roboto-mono"
}

export function sanitizeTransposeStep(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input)
    ? Math.max(-12, Math.min(12, Math.round(input)))
    : 0
}

export function sanitizeNoteBoxes(rawNoteBoxes: unknown): PositionedNoteBox[] {
  if (!Array.isArray(rawNoteBoxes)) return []

  return rawNoteBoxes
    .slice(0, 120)
    .map(entry => (entry && typeof entry === "object" ? entry : {}))
    .map(entry => {
      const note = entry as Record<string, unknown>
      const page =
        typeof note.page === "number" && Number.isFinite(note.page)
          ? Math.max(1, Math.min(999, Math.round(note.page)))
          : 1

      const clampPercent = (value: unknown, fallback: number): number =>
        typeof value === "number" && Number.isFinite(value)
          ? Math.max(0, Math.min(1, value))
          : fallback

      return {
        id:
          sanitizeText(note.id, 80) ||
          `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        page,
        x: clampPercent(note.x, 0.65),
        y: clampPercent(note.y, 0.1),
        width: clampPercent(note.width, 0.25),
        height: clampPercent(note.height, 0.2),
        text: sanitizeText(note.text, MAX_NOTES_LENGTH),
      }
    })
}

export function parseJsonObject(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {}
  }

  return {}
}

export function parseJsonArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed)) return parsed
    } catch {}
  }

  return []
}
