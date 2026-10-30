// Shared Postgres access for the API routes (public tabs + setlists).

import { timingSafeEqual } from "node:crypto"

export const DB_CONNECTION_URL =
  process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || ""
const EDIT_PASSWORD = (process.env.TABS_DELETE_PASSWORD || "").trim()

interface PgQueryResult<Row extends Record<string, unknown>> {
  rows: Row[]
}

export interface PgPoolLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
    params?: unknown[]
  ): Promise<PgQueryResult<Row>>
}

let dbPoolPromise: Promise<PgPoolLike> | null = null

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
  await pool.query(
    "ALTER TABLE public_tabs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ"
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS setlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      songs JSONB NOT NULL,
      settings JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  )
}

export async function getDbPool(): Promise<PgPoolLike> {
  if (!DB_CONNECTION_URL) {
    throw new Error(
      "Missing DB connection string. Set NETLIFY_DATABASE_URL or DATABASE_URL."
    )
  }

  if (!dbPoolPromise) {
    dbPoolPromise = (async () => {
      try {
        // A plain require (not eval'd) so the build traces pg into the
        // serverless function; Vercel only ships files it can trace.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pgModule = require("pg") as {
          Pool: new (config: Record<string, unknown>) => PgPoolLike
        }

        const pool = new pgModule.Pool({
          connectionString: DB_CONNECTION_URL,
          ssl: { rejectUnauthorized: false },
        })

        await ensureDbSchema(pool)
        return pool
      } catch (error) {
        dbPoolPromise = null
        throw error
      }
    })()
  }

  return dbPoolPromise
}

// User-facing reason for a database failure. Never includes the connection string.
export function describeDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : ""

  if (!DB_CONNECTION_URL) {
    return "Database isn't configured: set NETLIFY_DATABASE_URL (or DATABASE_URL) for this deployment and redeploy."
  }
  if (/Cannot find module ['"]pg['"]/.test(message)) {
    return "Database driver (pg) is missing from this deployment."
  }
  if (code === "28P01" || /password authentication failed/i.test(message)) {
    return "Database rejected the login. Check the NETLIFY_DATABASE_URL value."
  }
  return `Couldn't connect to the database${code ? ` (${code})` : ""}. Check NETLIFY_DATABASE_URL.`
}

// The edit/delete password (TABS_DELETE_PASSWORD). If it isn't set, anyone may edit.
export function isEditPasswordValid(input: unknown): boolean {
  if (!EDIT_PASSWORD) return true
  if (typeof input !== "string") return false
  const given = Buffer.from(input.trim())
  const expected = Buffer.from(EDIT_PASSWORD)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function toIsoString(value: unknown, fallback = new Date().toISOString()): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string" && value) return value
  return fallback
}
