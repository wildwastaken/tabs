import type { NextApiRequest, NextApiResponse } from "next"
import type { PublicTabEntry } from "../../types/setlist"
import {
  describeDbError,
  getDbPool,
  isEditPasswordValid,
  toIsoString,
  type PgPoolLike,
} from "../../lib/db"
import {
  MAX_CHORDS_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_TEXT_LENGTH,
  parseJsonArray,
  parseJsonObject,
  sanitizeMonoFont,
  sanitizeNoteBoxes,
  sanitizeText,
  sanitizeTransposeStep,
} from "../../lib/validation"

const DISCORD_WEBHOOK_URL = (process.env.DISCORD_PUBLISH_WEBHOOK_URL || "").trim()

const MAX_TABS = 1000
const MAX_SONGS_PER_TAB = 40

interface PublishPayloadSong {
  artist?: unknown
  song?: unknown
  transposedChords?: unknown
  transposeStep?: unknown
}

interface PublishPayload {
  publisherName?: unknown
  setlistTitle?: unknown
  notes?: unknown
  exportSettings?: {
    monoFont?: unknown
    noteBoxes?: unknown
  }
  songs?: unknown
}

interface DeletePayload {
  id?: unknown
  password?: unknown
}

interface UpdatePayload extends DeletePayload {
  publisherName?: unknown
  setlistTitle?: unknown
  songs?: unknown
}

interface PublicTabRow extends Record<string, unknown> {
  id: string
  publisher_name: string
  setlist_title: string
  published_at: string | Date
  updated_at: string | Date | null
  notes: string
  export_settings: unknown
  songs: unknown
}

function sanitizeSongs(rawSongs: unknown): PublicTabEntry["songs"] {
  if (!Array.isArray(rawSongs)) return []

  return rawSongs
    .slice(0, MAX_SONGS_PER_TAB)
    .map((song): PublishPayloadSong => (song && typeof song === "object" ? song : {}))
    .map(song => {
      const transposeStep = sanitizeTransposeStep(song.transposeStep)

      return {
        artist: sanitizeText(song.artist, MAX_TEXT_LENGTH) || "Unknown Artist",
        song: sanitizeText(song.song, MAX_TEXT_LENGTH) || "Untitled Song",
        transposedChords: sanitizeText(song.transposedChords, MAX_CHORDS_LENGTH),
        transposeStep,
      }
    })
    .filter(song => song.transposedChords.length > 0)
}

function mapDbRowToPublicTabEntry(row: PublicTabRow): PublicTabEntry {
  const exportSettingsRaw = parseJsonObject(row.export_settings)
  const sanitizedSongs = sanitizeSongs(parseJsonArray(row.songs))

  const monoFont = sanitizeMonoFont(exportSettingsRaw.monoFont)
  const publishedAt = toIsoString(row.published_at)

  return {
    id: sanitizeText(row.id, 120),
    publisherName: sanitizeText(row.publisher_name, 80) || "Anonymous",
    setlistTitle: sanitizeText(row.setlist_title, 120) || "Untitled",
    publishedAt,
    updatedAt: toIsoString(row.updated_at, publishedAt),
    notes: sanitizeText(row.notes, MAX_NOTES_LENGTH),
    exportSettings: {
      monoFont,
      noteBoxes: sanitizeNoteBoxes(exportSettingsRaw.noteBoxes),
    },
    songs: sanitizedSongs,
  }
}

async function listTabsFromDb(pool: PgPoolLike): Promise<PublicTabEntry[]> {
  const result = await pool.query<PublicTabRow>(
    `SELECT id, publisher_name, setlist_title, published_at, updated_at, notes, export_settings, songs
     FROM public_tabs
     ORDER BY published_at DESC
     LIMIT $1`,
    [MAX_TABS]
  )

  return result.rows.map(mapDbRowToPublicTabEntry)
}

async function insertTabIntoDb(
  pool: PgPoolLike,
  entry: PublicTabEntry
): Promise<void> {
  await pool.query(
    `INSERT INTO public_tabs (
      id,
      publisher_name,
      setlist_title,
      published_at,
      notes,
      export_settings,
      songs
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      entry.id,
      entry.publisherName,
      entry.setlistTitle,
      entry.publishedAt,
      entry.notes || "",
      JSON.stringify(entry.exportSettings),
      JSON.stringify(entry.songs),
    ]
  )
}

async function updateTabInDb(
  pool: PgPoolLike,
  id: string,
  changes: { publisherName?: string; setlistTitle?: string; songs?: PublicTabEntry["songs"] }
): Promise<PublicTabEntry | null> {
  const result = await pool.query<PublicTabRow>(
    `UPDATE public_tabs SET
       publisher_name = COALESCE($2, publisher_name),
       setlist_title = COALESCE($3, setlist_title),
       songs = COALESCE($4::jsonb, songs),
       updated_at = NOW()
     WHERE id = $1
     RETURNING id, publisher_name, setlist_title, published_at, updated_at, notes, export_settings, songs`,
    [
      id,
      changes.publisherName ?? null,
      changes.setlistTitle ?? null,
      changes.songs ? JSON.stringify(changes.songs) : null,
    ]
  )
  return result.rows[0] ? mapDbRowToPublicTabEntry(result.rows[0]) : null
}

async function deleteTabFromDb(pool: PgPoolLike, id: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    "DELETE FROM public_tabs WHERE id = $1 RETURNING id",
    [id]
  )
  return result.rows.length > 0
}

async function sendPublishLogToDiscord(
  rawPayload: PublishPayload,
  entry: PublicTabEntry
): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return

  try {
    const logPayload = {
      receivedAt: new Date().toISOString(),
      rawPayload,
      sanitizedEntry: entry,
    }

    const form = new FormData()
    form.append(
      "payload_json",
      JSON.stringify({
        content: `Published tab: ${entry.setlistTitle} | publisher: ${entry.publisherName} | songs: ${entry.songs.length}`,
        allowed_mentions: { parse: [] },
      })
    )
    form.append(
      "file",
      new Blob([JSON.stringify(logPayload, null, 2)], {
        type: "application/json",
      }),
      `published-tab-${entry.id}.json`
    )

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      body: form,
    })

    if (!response.ok) {
      console.error(`Discord webhook failed (${response.status})`)
    }
  } catch {
    // Fetch errors can contain the request URL, including the webhook token.
    console.error("Failed to send Discord publish log")
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<void> {
  if (req.method === "GET") {
    try {
      const pool = await getDbPool()
      const tabs = await listTabsFromDb(pool)
      res.status(200).json({ tabs })
    } catch (error) {
      console.error("Failed to load public tabs:", error)
      res.status(500).json({ error: describeDbError(error) })
    }
    return
  }

  if (req.method === "POST") {
    const payload: PublishPayload =
      req.body && typeof req.body === "object" ? req.body : {}

    const songs = sanitizeSongs(payload.songs)
    if (songs.length === 0) {
      res.status(400).json({
        error: "Setlist must include at least one song with tab content.",
      })
      return
    }

    const publisherName = sanitizeText(payload.publisherName, 80) || "Anonymous"
    const setlistTitle =
      sanitizeText(payload.setlistTitle, 120) ||
      (songs.length === 1
        ? `${songs[0].artist} - ${songs[0].song}`
        : `Setlist (${songs.length} songs)`)
    const notes = sanitizeText(payload.notes, MAX_NOTES_LENGTH)

    const monoFont = sanitizeMonoFont(payload.exportSettings?.monoFont)

    const noteBoxes = sanitizeNoteBoxes(payload.exportSettings?.noteBoxes)

    const newEntry: PublicTabEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      publisherName,
      setlistTitle,
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes,
      exportSettings: {
        monoFont,
        noteBoxes,
      },
      songs,
    }

    try {
      const pool = await getDbPool()
      await insertTabIntoDb(pool, newEntry)

      await sendPublishLogToDiscord(payload, newEntry)

      res.status(201).json({ tab: newEntry })
    } catch (error) {
      console.error("Failed to persist public tab:", error)
      res.status(500).json({ error: describeDbError(error) })
    }
    return
  }

  if (req.method === "DELETE") {
    const payload: DeletePayload =
      req.body && typeof req.body === "object" ? req.body : {}

    const id = sanitizeText(payload.id, 120)
    const password =
      typeof payload.password === "string" ? payload.password.trim() : ""

    if (!id) {
      res.status(400).json({ error: "Tab id is required." })
      return
    }

    if (!isEditPasswordValid(password)) {
      res.status(401).json({ error: "Wrong edit/delete password." })
      return
    }

    try {
      const pool = await getDbPool()
      const deleted = await deleteTabFromDb(pool, id)

      if (!deleted) {
        res.status(404).json({ error: "Tab not found." })
        return
      }

      res.status(200).json({ ok: true, id })
    } catch (error) {
      console.error("Failed deleting tab:", error)
      res.status(500).json({ error: "Failed to delete tab." })
    }
    return
  }

  if (req.method === "PUT") {
    const payload: UpdatePayload =
      req.body && typeof req.body === "object" ? req.body : {}

    const id = sanitizeText(payload.id, 120)
    if (!id) {
      res.status(400).json({ error: "Tab id is required." })
      return
    }

    if (!isEditPasswordValid(payload.password)) {
      res.status(401).json({ error: "Wrong edit/delete password." })
      return
    }

    const songs = payload.songs === undefined ? undefined : sanitizeSongs(payload.songs)
    if (songs && songs.length === 0) {
      res.status(400).json({ error: "A tab needs at least one song with chords." })
      return
    }

    try {
      const pool = await getDbPool()
      const updated = await updateTabInDb(pool, id, {
        publisherName:
          payload.publisherName === undefined
            ? undefined
            : sanitizeText(payload.publisherName, 80) || "Anonymous",
        setlistTitle:
          payload.setlistTitle === undefined
            ? undefined
            : sanitizeText(payload.setlistTitle, 120) || undefined,
        songs,
      })

      if (!updated) {
        res.status(404).json({ error: "Tab not found." })
        return
      }

      res.status(200).json({ tab: updated })
    } catch (error) {
      console.error("Failed updating tab:", error)
      res.status(500).json({ error: describeDbError(error) })
    }
    return
  }

  res.setHeader("Allow", "GET,POST,PUT,DELETE")
  res.status(405).json({ error: "Method not allowed" })
}
