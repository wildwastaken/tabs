import type { NextApiRequest, NextApiResponse } from "next"
import { promises as fs } from "fs"
import path from "path"
import type {
  MonoFontOption,
  PositionedNoteBox,
  PublicTabEntry,
  PublicTabsDb,
} from "../../types/setlist"

const DATA_FILE_PATH = path.join(process.cwd(), "data", "public-tabs.json")
const DB_CONNECTION_URL =
  process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || ""
const DELETE_PASSWORD = (process.env.TABS_DELETE_PASSWORD || "").trim()
const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_PUBLISH_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1474522347028480070/NjgvqHikQDt-psacDoJNthq9TOdInj9PX11BpFTtl3Z8d4N_ykxyVyUj6ODzIY2hreW1"

const MAX_TABS = 300
const MAX_SONGS_PER_TAB = 40
const MAX_TEXT_LENGTH = 250
const MAX_NOTES_LENGTH = 6000
const MAX_CHORDS_LENGTH = 40000
const ALLOWED_MONO_FONTS: MonoFontOption[] = [
  "roboto-mono",
  "courier-new",
  "consolas",
  "menlo",
]

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

interface PublicTabRow extends Record<string, unknown> {
  id: string
  publisher_name: string
  setlist_title: string
  published_at: string | Date
  notes: string
  export_settings: unknown
  songs: unknown
}

interface PgQueryResult<Row extends Record<string, unknown>> {
  rows: Row[]
}

interface PgPoolLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
    params?: unknown[]
  ): Promise<PgQueryResult<Row>>
}

const defaultDb: PublicTabsDb = { version: 1, tabs: [] }

let dbPoolPromise: Promise<PgPoolLike | null> | null = null
let warnedDbFallback = false

function sanitizeText(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return ""
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, maxLength)
}

function sanitizeSongs(rawSongs: unknown): PublicTabEntry["songs"] {
  if (!Array.isArray(rawSongs)) return []

  return rawSongs
    .slice(0, MAX_SONGS_PER_TAB)
    .map((song): PublishPayloadSong => (song && typeof song === "object" ? song : {}))
    .map(song => {
      const transposeStep =
        typeof song.transposeStep === "number" && Number.isFinite(song.transposeStep)
          ? Math.max(-12, Math.min(12, Math.round(song.transposeStep)))
          : 0

      return {
        artist: sanitizeText(song.artist, MAX_TEXT_LENGTH) || "Unknown Artist",
        song: sanitizeText(song.song, MAX_TEXT_LENGTH) || "Untitled Song",
        transposedChords: sanitizeText(song.transposedChords, MAX_CHORDS_LENGTH),
        transposeStep,
      }
    })
    .filter(song => song.transposedChords.length > 0)
}

function sanitizeNoteBoxes(rawNoteBoxes: unknown): PositionedNoteBox[] {
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

function parseJsonObject(input: unknown): Record<string, unknown> {
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

function parseJsonArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed)) return parsed
    } catch {}
  }

  return []
}

async function ensureDbSchema(pool: PgPoolLike): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS public_tabs (
      id TEXT PRIMARY KEY,
      publisher_name TEXT NOT NULL,
      setlist_title TEXT NOT NULL,
      published_at TIMESTAMPTZ NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      export_settings JSONB NOT NULL,
      songs JSONB NOT NULL
    )`
  )
}

async function getDbPool(): Promise<PgPoolLike | null> {
  if (!DB_CONNECTION_URL) return null

  if (!dbPoolPromise) {
    dbPoolPromise = (async () => {
      try {
        const requireFn = eval("require") as NodeRequire
        const pgModule = requireFn("pg") as {
          Pool: new (config: Record<string, unknown>) => PgPoolLike
        }

        const pool = new pgModule.Pool({
          connectionString: DB_CONNECTION_URL,
          ssl: { rejectUnauthorized: false },
        })

        await ensureDbSchema(pool)
        return pool
      } catch (error) {
        if (!warnedDbFallback) {
          warnedDbFallback = true
          console.error(
            "DB connection unavailable, falling back to file storage. Ensure `pg` is installed in production.",
            error
          )
        }
        return null
      }
    })()
  }

  return dbPoolPromise
}

function mapDbRowToPublicTabEntry(row: PublicTabRow): PublicTabEntry {
  const exportSettingsRaw = parseJsonObject(row.export_settings)
  const sanitizedSongs = sanitizeSongs(parseJsonArray(row.songs))

  const rawMonoFont = exportSettingsRaw.monoFont
  const monoFont: MonoFontOption =
    typeof rawMonoFont === "string" &&
    ALLOWED_MONO_FONTS.includes(rawMonoFont as MonoFontOption)
      ? (rawMonoFont as MonoFontOption)
      : "roboto-mono"

  return {
    id: sanitizeText(row.id, 120),
    publisherName: sanitizeText(row.publisher_name, 80) || "Anonymous",
    setlistTitle: sanitizeText(row.setlist_title, 120) || "Untitled",
    publishedAt:
      row.published_at instanceof Date
        ? row.published_at.toISOString()
        : String(row.published_at || new Date().toISOString()),
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
    `SELECT id, publisher_name, setlist_title, published_at, notes, export_settings, songs
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

async function deleteTabFromDb(pool: PgPoolLike, id: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    "DELETE FROM public_tabs WHERE id = $1 RETURNING id",
    [id]
  )
  return result.rows.length > 0
}

async function readDb(): Promise<PublicTabsDb> {
  try {
    const fileContents = await fs.readFile(DATA_FILE_PATH, "utf8")
    const parsed = JSON.parse(fileContents)

    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as PublicTabsDb).tabs)
    ) {
      return {
        version:
          typeof (parsed as PublicTabsDb).version === "number"
            ? (parsed as PublicTabsDb).version
            : 1,
        tabs: (parsed as PublicTabsDb).tabs,
      }
    }

    return defaultDb
  } catch {
    return defaultDb
  }
}

async function writeDb(db: PublicTabsDb): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE_PATH), { recursive: true })
  await fs.writeFile(DATA_FILE_PATH, JSON.stringify(db, null, 2), "utf8")
}

async function listTabsFromFile(): Promise<PublicTabEntry[]> {
  const db = await readDb()
  return db.tabs
}

async function insertTabIntoFile(entry: PublicTabEntry): Promise<void> {
  const db = await readDb()
  const updatedDb: PublicTabsDb = {
    version: 1,
    tabs: [entry, ...db.tabs].slice(0, MAX_TABS),
  }
  await writeDb(updatedDb)
}

async function deleteTabFromFile(id: string): Promise<boolean> {
  const db = await readDb()
  const remainingTabs = db.tabs.filter(tab => tab.id !== id)
  if (remainingTabs.length === db.tabs.length) return false

  await writeDb({
    version: db.version || 1,
    tabs: remainingTabs,
  })

  return true
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
      const body = await response.text()
      console.error(
        `Discord webhook failed (${response.status}):`,
        body.slice(0, 600)
      )
    }
  } catch (error) {
    console.error("Failed to send Discord publish log:", error)
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<void> {
  if (req.method === "GET") {
    try {
      const pool = await getDbPool()
      const tabs = pool ? await listTabsFromDb(pool) : await listTabsFromFile()
      res.status(200).json({ tabs })
    } catch (error) {
      console.error("Failed to load public tabs:", error)
      res.status(500).json({ error: "Failed to load public tabs." })
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

    const rawMonoFont = payload.exportSettings?.monoFont
    const monoFont: MonoFontOption =
      typeof rawMonoFont === "string" &&
      ALLOWED_MONO_FONTS.includes(rawMonoFont as MonoFontOption)
        ? (rawMonoFont as MonoFontOption)
        : "roboto-mono"

    const noteBoxes = sanitizeNoteBoxes(payload.exportSettings?.noteBoxes)

    const newEntry: PublicTabEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      publisherName,
      setlistTitle,
      publishedAt: new Date().toISOString(),
      notes,
      exportSettings: {
        monoFont,
        noteBoxes,
      },
      songs,
    }

    try {
      const pool = await getDbPool()
      if (pool) {
        await insertTabIntoDb(pool, newEntry)
      } else {
        await insertTabIntoFile(newEntry)
      }

      await sendPublishLogToDiscord(payload, newEntry)

      res.status(201).json({ tab: newEntry })
    } catch (error) {
      console.error("Failed to persist public tab:", error)
      res.status(500).json({
        error:
          "Failed to persist public tab data. Verify DB configuration or file write permissions.",
      })
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

    if (DELETE_PASSWORD && password !== DELETE_PASSWORD) {
      res.status(401).json({ error: "Invalid delete password." })
      return
    }

    try {
      const pool = await getDbPool()
      const deleted = pool
        ? await deleteTabFromDb(pool, id)
        : await deleteTabFromFile(id)

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

  res.setHeader("Allow", "GET,POST,DELETE")
  res.status(405).json({ error: "Method not allowed" })
}
