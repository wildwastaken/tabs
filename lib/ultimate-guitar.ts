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

export interface ImportedTabPayload {
  song?: string
  artist?: string
  content?: string
  url?: string
}

// Bookmarklet the user runs on an Ultimate Guitar page in their own browser.
// It reads the tab from the page they already have open and hands it to the
// app through the URL fragment (never sent to any server).
export function buildSendToTabsBookmarklet(appOrigin: string): string {
  const source = `(function(){
var song="",artist="",content="";
try{
var el=document.querySelector(".js-store");
var d=JSON.parse(el.getAttribute("data-content"));
var p=(d.store||d).page.data;
content=p.tab_view.wiki_tab.content;
song=p.tab.song_name;artist=p.tab.artist_name;
}catch(e){}
if(!content){
var pre=document.querySelector("pre");
if(pre)content=pre.innerText;
var h=document.querySelector("h1");
if(h)song=h.innerText.replace(/\\s+(chords|tab|tabs|ukulele|bass)\\s*$/i,"");
}
if(!content){alert("Could not find chords on this page. Open a chords/tab page on Ultimate Guitar first.");return;}
var json=JSON.stringify({song:song,artist:artist,content:content,url:location.href.split(/[?#]/)[0]});
var b64=btoa(unescape(encodeURIComponent(json))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
window.open(${JSON.stringify(appOrigin)}+"/#import="+b64,"tabs-app");
})();`
  return `javascript:${encodeURIComponent(source.replace(/\n/g, ""))}`
}

export function decodeImportPayload(hash: string): ImportedTabPayload | null {
  const match = hash.match(/^#import=([A-Za-z0-9_-]+)$/)
  if (!match) return null
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as ImportedTabPayload
    return typeof payload.content === "string" && payload.content.trim() ? payload : null
  } catch {
    return null
  }
}
