// Helpers for pulling chord sheets out of Ultimate Guitar tab pages.
// Shared by the server-side /api/fetch-tab route and the browser fallback.

export interface UltimateGuitarTab {
  artist: string
  song: string
  content: string
}

type JsonObject = Record<string, unknown>

export function isUltimateGuitarUrl(input: string): boolean {
  try {
    const url = new URL(input.trim())
    const host = url.hostname.toLowerCase()
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      (host === "ultimate-guitar.com" || host.endsWith(".ultimate-guitar.com"))
    )
  } catch {
    return false
  }
}

// Canonicalize to the desktop tab URL (strips tracking params, mobile hosts, etc.)
export function normalizeUltimateGuitarUrl(input: string): string {
  const url = new URL(input.trim())
  url.protocol = "https:"
  if (url.hostname === "ultimate-guitar.com" || url.hostname.startsWith("m.")) {
    url.hostname = "tabs.ultimate-guitar.com"
  }
  url.search = ""
  url.hash = ""
  return url.toString()
}

// Pull every URL out of a blob of pasted text. Handles links separated by
// newlines, spaces, commas, or glued together (single-line inputs drop newlines).
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/.+?(?=https?:\/\/|[\s,]|$)/g) || []
  return matches.map(url => url.replace(/[)>\]"'.]+$/, "")).filter(Boolean)
}

const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X"
      const value = Number.parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity
    }
    return namedEntities[code.toLowerCase()] ?? entity
  })
}

function getPath(obj: unknown, path: string[]): unknown {
  let current = obj
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as JsonObject)[key]
  }
  return current
}

function collectStrings(obj: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(obj)) {
    obj.forEach(item => collectStrings(item, key, out))
  } else if (obj && typeof obj === "object") {
    for (const [entryKey, value] of Object.entries(obj as JsonObject)) {
      if (entryKey === key && typeof value === "string") out.push(value)
      else if (value && typeof value === "object") collectStrings(value, key, out)
    }
  }
  return out
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

// The page store holds many "content" keys (comments, promos, etc). Prefer the
// documented wiki_tab path, then the candidate that actually looks like a chord sheet.
export function extractTabFromStore(store: unknown): UltimateGuitarTab | null {
  const data = getPath(store, ["store", "page", "data"]) ?? getPath(store, ["page", "data"]) ?? store

  const directContent = firstString(
    getPath(data, ["tab_view", "wiki_tab", "content"]),
    getPath(data, ["wiki_tab", "content"])
  )

  let content = directContent
  if (!content) {
    const candidates = collectStrings(data, "content")
    content =
      candidates
        .filter(text => text.includes("[ch]") || text.includes("[tab]"))
        .sort((a, b) => b.length - a.length)[0] || ""
  }

  if (!content) return null

  const song = firstString(
    getPath(data, ["tab", "song_name"]),
    collectStrings(data, "song_name")[0]
  )
  const artist = firstString(
    getPath(data, ["tab", "artist_name"]),
    collectStrings(data, "artist_name")[0]
  )

  return {
    artist: artist || "Unknown Artist",
    song: song || "Unknown Song",
    content: content.replace(/\r\n/g, "\n"),
  }
}

export function extractTabFromHtml(html: string): UltimateGuitarTab | null {
  const storeMatch =
    html.match(/class="js-store"[^>]*?data-content="([^"]*)"/) ||
    html.match(/data-content="([^"]*)"[^>]*?class="js-store"/)

  if (storeMatch) {
    try {
      const tab = extractTabFromStore(JSON.parse(decodeHtmlEntities(storeMatch[1])))
      if (tab) return tab
    } catch {
      // fall through to the legacy inline-script format
    }
  }

  const legacyMatch = html.match(/window\.UGAPP\.store\.page\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>)/)
  if (legacyMatch) {
    try {
      return extractTabFromStore({ page: JSON.parse(legacyMatch[1]) })
    } catch {
      return null
    }
  }

  return null
}
