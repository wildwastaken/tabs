import type { NextApiRequest, NextApiResponse } from "next"
import type {
  SavedSetlist,
  SavedSetlistSettings,
  SavedSetlistSong,
} from "../../types/setlist"
import {
  describeDbError,
  getDbPool,
  isEditPasswordValid,
  toIsoString,
  type PgPoolLike,
} from "../../lib/db"
import {
  MAX_CHORDS_LENGTH,
  MAX_TEXT_LENGTH,
  parseJsonArray,
  parseJsonObject,
  sanitizeMonoFont,
  sanitizeNoteBoxes,
  sanitizeText,
  sanitizeTransposeStep,
} from "../../lib/validation"

const MAX_SETLISTS = 1000
const MAX_SONGS_PER_SETLIST = 60

interface SetlistRow extends Record<string, unknown> {
  id: string
  name: string
  songs: unknown
  settings: unknown
  created_at: string | Date
  updated_at: string | Date
}

function sanitizeId(input: unknown): string {
  const id = typeof input === "string" ? input.trim() : ""
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : ""
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeSetlistSongs(rawSongs: unknown): SavedSetlistSong[] {
  return parseJsonArray(rawSongs)
    .slice(0, MAX_SONGS_PER_SETLIST)
    .map(song => parseJsonObject(song))
    .map(song => ({
      uri: sanitizeText(song.uri, 500),
      artist: sanitizeText(song.artist, MAX_TEXT_LENGTH) || "Unknown Artist",
      song: sanitizeText(song.song, MAX_TEXT_LENGTH) || "Untitled Song",
      chords: sanitizeText(song.chords, MAX_CHORDS_LENGTH),
      transposeStep: sanitizeTransposeStep(song.transposeStep),
    }))
    .filter(song => song.chords.length > 0)
}

function sanitizeSettings(rawSettings: unknown): SavedSetlistSettings {
  const settings = parseJsonObject(rawSettings)
  const fontSize =
    typeof settings.fontSize === "number" && Number.isFinite(settings.fontSize)
      ? Math.max(6, Math.min(20, settings.fontSize))
      : 10

  return {
    fontSize,
    autoLinebreak: settings.autoLinebreak === true,
    monoFont: sanitizeMonoFont(settings.monoFont),
    noteBoxes: sanitizeNoteBoxes(settings.noteBoxes),
  }
}

function mapRow(row: SetlistRow): SavedSetlist {
  const createdAt = toIsoString(row.created_at)
  return {
    id: row.id,
    name: sanitizeText(row.name, 120) || "Untitled setlist",
    createdAt,
    updatedAt: toIsoString(row.updated_at, createdAt),
    songs: sanitizeSetlistSongs(row.songs),
    settings: sanitizeSettings(row.settings),
  }
}

const COLUMNS = "id, name, songs, settings, created_at, updated_at"

async function listSetlists(pool: PgPoolLike): Promise<SavedSetlist[]> {
  const result = await pool.query<SetlistRow>(
    `SELECT ${COLUMNS} FROM setlists ORDER BY updated_at DESC LIMIT $1`,
    [MAX_SETLISTS]
  )
  return result.rows.map(mapRow)
}

function readBody(req: NextApiRequest): Record<string, unknown> {
  return req.body && typeof req.body === "object" ? req.body : {}
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store")

  try {
    if (req.method === "GET") {
      const pool = await getDbPool()
      return res.status(200).json({ setlists: await listSetlists(pool) })
    }

    if (req.method === "POST") {
      const body = readBody(req)
      const songs = sanitizeSetlistSongs(body.songs)
      if (songs.length === 0) {
        return res.status(400).json({ error: "A setlist needs at least one song." })
      }

      // Callers may supply an id and creation date (used when uploading
      // setlists that were previously saved only in a browser).
      const id = sanitizeId(body.id) || createId()
      const now = Date.now()
      const pastDate = (input: unknown, fallback: number) => {
        const time = typeof input === "string" ? Date.parse(input) : NaN
        return Number.isFinite(time) && time <= now ? time : fallback
      }
      const createdTime = pastDate(body.createdAt, now)
      const createdAt = new Date(createdTime).toISOString()
      const updatedAt = new Date(Math.max(createdTime, pastDate(body.updatedAt, createdTime))).toISOString()

      const pool = await getDbPool()
      const result = await pool.query<SetlistRow>(
        `INSERT INTO setlists (id, name, songs, settings, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          id,
          sanitizeText(body.name, 120) || "Untitled setlist",
          JSON.stringify(songs),
          JSON.stringify(sanitizeSettings(body.settings)),
          createdAt,
          updatedAt,
        ]
      )
      if (!result.rows[0]) {
        return res.status(409).json({ error: "A setlist with this id already exists." })
      }
      return res.status(201).json({ setlist: mapRow(result.rows[0]) })
    }

    if (req.method === "PUT") {
      const body = readBody(req)
      const id = sanitizeId(body.id)
      if (!id) return res.status(400).json({ error: "Setlist id is required." })

      const songs = sanitizeSetlistSongs(body.songs)
      if (songs.length === 0) {
        return res.status(400).json({ error: "A setlist needs at least one song." })
      }

      const pool = await getDbPool()
      const result = await pool.query<SetlistRow>(
        `UPDATE setlists SET name = $2, songs = $3::jsonb, settings = $4::jsonb, updated_at = NOW()
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [
          id,
          sanitizeText(body.name, 120) || "Untitled setlist",
          JSON.stringify(songs),
          JSON.stringify(sanitizeSettings(body.settings)),
        ]
      )
      if (!result.rows[0]) {
        return res.status(404).json({ error: "Setlist not found. It may have been deleted." })
      }
      return res.status(200).json({ setlist: mapRow(result.rows[0]) })
    }

    if (req.method === "DELETE") {
      const body = readBody(req)
      const id = sanitizeId(body.id)
      if (!id) return res.status(400).json({ error: "Setlist id is required." })
      if (!isEditPasswordValid(body.password)) {
        return res.status(401).json({ error: "Wrong edit/delete password." })
      }

      const pool = await getDbPool()
      const result = await pool.query<{ id: string }>(
        "DELETE FROM setlists WHERE id = $1 RETURNING id",
        [id]
      )
      if (!result.rows[0]) return res.status(404).json({ error: "Setlist not found." })
      return res.status(200).json({ ok: true, id })
    }

    res.setHeader("Allow", "GET,POST,PUT,DELETE")
    return res.status(405).json({ error: "Method not allowed" })
  } catch (error) {
    console.error(`setlists ${req.method} failed:`, error)
    return res.status(500).json({ error: describeDbError(error) })
  }
}
