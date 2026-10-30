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
  nbsp: "\u00a0",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  prime: "\u2032",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  bull: "\u2022",
  middot: "\u00b7",
  deg: "\u00b0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  sharp: "\u266f",
  flat: "\u266d",
  natur: "\u266e",
  times: "\u00d7",
  szlig: "\u00df",
}

// Accented letters: &eacute; &Uuml; &ntilde; ...
const accentMarks: Record<string, string> = {
  acute: "\u0301",
  grave: "\u0300",
  circ: "\u0302",
  tilde: "\u0303",
  uml: "\u0308",
  cedil: "\u0327",
  ring: "\u030a",
}

function decodeNamedEntity(name: string): string | undefined {
  if (namedEntities[name] !== undefined) return namedEntities[name]
  if (namedEntities[name.toLowerCase()] !== undefined && /^[A-Z]+$/.test(name)) {
    return namedEntities[name.toLowerCase()]
  }
  const accentMatch = name.match(/^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring)$/)
  if (accentMatch) return (accentMatch[1] + accentMarks[accentMatch[2]]).normalize("NFC")
  return undefined
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X"
      const value = Number.parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : entity
    }
    return decodeNamedEntity(code) ?? entity
  })
}

// Ultimate Guitar stores lyrics with HTML entities (e.g. "can&rsquo;t") inside
// its JSON. Decode them, and swap typographic punctuation for plain ASCII of
// the same width so chord columns stay aligned and PDF fallback fonts render it.
export function cleanTabText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
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
    artist: cleanTabText(artist) || "Unknown Artist",
    song: cleanTabText(song) || "Unknown Song",
    content: cleanTabText(content),
  }
}

export function extractTabFromHtml(html: string): UltimateGuitarTab | null {
  // Any element whose class list includes js-store, with data-content in any position.
  const storeTags = html.match(/<[a-z]+\b[^>]*\bjs-store\b[^>]*>/gi) || []
  for (const tag of storeTags) {
    const contentMatch = tag.match(/\bdata-content=(?:"([^"]*)"|'([^']*)')/)
    if (!contentMatch) continue
    try {
      const tab = extractTabFromStore(
        JSON.parse(decodeHtmlEntities(contentMatch[1] ?? contentMatch[2]))
      )
      if (tab) return tab
    } catch {
      // try the next candidate / legacy inline-script format
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
