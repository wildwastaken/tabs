"use client"

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import {
  parse,
  transpose,
  prettyPrint,
} from "chord-magic/dist/chord-magic.cjs.js"
import generatePDF from "../lib/generate-pdf"
import generateDocx from "../lib/generate-docx"
import {
  extractTabFromHtml,
  extractUrls,
  isUltimateGuitarUrl,
  cleanTabText,
  normalizeUltimateGuitarUrl,
  type UltimateGuitarTab,
} from "../lib/ultimate-guitar"
import type {
  ExportSettings,
  MonoFontOption,
  PositionedNoteBox,
  PublicTabEntry,
  SavedSetlist,
  SavedSetlistSettings,
} from "../types/setlist"
import { Input } from "../components/ui/input"
import { Slider } from "../components/ui/slider"
import { Checkbox } from "../components/ui/checkbox"
import { Label } from "../components/ui/label"
import { Button } from "../components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../components/ui/card"
import { Separator } from "../components/ui/separator"
import { Dialog, DialogContent } from "../components/ui/dialog"
import { FullScreenPDFViewer } from "../components/FullScreenPDFViewer"
import { cn } from "../lib/utils"
import { Select } from "radix-ui"
import {
  FileText,
  FileDown,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Music2,
  Maximize,
  Plus,
  Minus,
  Trash2,
  List,
  Copy,
  Check,
  FileType,
  Globe,
  Upload,
  RefreshCw,
  Edit3,
  Eye,
  Save,
  FolderOpen,
  FilePlus2,
  ListPlus,
  Search,
  ClipboardPaste,
  Link as LinkIcon,
  X,
  SlidersHorizontal,
  StickyNote,
  Library,
  Maximize2,
  Minimize2,
  GripVertical,
  ArrowUpDown,
  KeyRound,
} from "lucide-react"

const MIN_NOTE_BOX_DIMENSION = 0.02
// Setlists saved before they moved to the shared database (uploaded on request).
const SAVED_SETLISTS_STORAGE_KEY = "tabs.savedSetlists.v1"
const EDIT_PASSWORD_STORAGE_KEY = "tabs.editPassword.v1"
const SETLIST_SORT_STORAGE_KEY = "tabs.sort.setlists.v1"
const SONG_SORT_STORAGE_KEY = "tabs.sort.songs.v1"
const ADD_MODE_STORAGE_KEY = "tabs.addSongsMode.v1"
const WORKING_SETLIST_STORAGE_KEY = "tabs.workingSetlist.v1"

// Browser-side fallbacks, used only if our own /api/fetch-tab route fails.
const CLIENT_PROXIES: Array<(url: string) => string> = [
  url => `https://api.codetabs.com/v1/proxy/?quest=${url}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
]

type WorkspaceView = "editor" | "saved" | "published"

type SortMode = "added" | "modified" | "name"
const SORT_MODES: SortMode[] = ["added", "modified", "name"]
const SORT_LABELS: Record<SortMode, string> = {
  added: "Date added",
  modified: "Date modified",
  name: "Name",
}

type AddSongsMode = "library" | "link" | "paste"
const ADD_SONGS_MODES: AddSongsMode[] = ["library", "link", "paste"]

type PasswordStatus = "none" | "checking" | "valid" | "invalid"

interface SongData {
  id: string
  uri: string
  artist: string
  song: string
  chords: string
  transposedChords: string
  transposeStep: number
}

interface ParsedPastedSong {
  artist: string
  song: string
  chords: string
}

interface PublicTabsResponse {
  tabs: PublicTabEntry[]
}

interface WorkingSetlist {
  name: string
  savedSetlistId: string | null
  songs: Array<Omit<SongData, "transposedChords">>
  settings: SavedSetlistSettings
}

// Deterministic serialization (fixed key order, no derived fields) so that
// syncing between browser tabs settles instead of echoing writes back and forth.
function serializeWorkingSetlist(
  name: string,
  savedSetlistId: string | null,
  songs: SongData[],
  settings: SavedSetlistSettings
): string {
  const working: WorkingSetlist = {
    name,
    savedSetlistId,
    songs: songs.map(({ id, uri, artist, song, chords, transposeStep }) => ({
      id,
      uri,
      artist,
      song,
      chords,
      transposeStep,
    })),
    settings: {
      fontSize: settings.fontSize,
      autoLinebreak: settings.autoLinebreak,
      monoFont: settings.monoFont,
      noteBoxes: settings.noteBoxes,
    },
  }
  return JSON.stringify(working)
}

// Newest first for dates, A→Z for names.
function sortItems<T>(
  items: T[],
  mode: SortMode,
  keys: { added: (item: T) => string; modified: (item: T) => string; name: (item: T) => string }
): T[] {
  const sorted = [...items]
  if (mode === "name") {
    sorted.sort((a, b) =>
      keys.name(a).localeCompare(keys.name(b), undefined, { sensitivity: "base", numeric: true })
    )
  } else {
    const key = keys[mode]
    sorted.sort((a, b) => Date.parse(key(b) || "") - Date.parse(key(a) || ""))
  }
  return sorted
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function apiRequest<T = unknown>(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status)
  }
  return data
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.error(`Failed to write ${key} to localStorage:`, err)
  }
}

function songsFromSaved(saved: SavedSetlist): SongData[] {
  return saved.songs.map(song => ({
    id: createId(),
    uri: song.uri,
    artist: cleanTabText(song.artist),
    song: cleanTabText(song.song),
    chords: cleanTabText(song.chords),
    transposedChords: cleanTabText(song.chords),
    transposeStep: song.transposeStep,
  }))
}

// Stable fingerprint used to detect unsaved changes.
function setlistFingerprint(
  name: string,
  songs: Array<Pick<SongData, "uri" | "artist" | "song" | "chords" | "transposeStep">>,
  settings: SavedSetlistSettings
): string {
  return JSON.stringify({
    name: name.trim(),
    // Cleaned so setlists saved before entity decoding don't show as changed.
    songs: songs.map(({ uri, artist, song, chords, transposeStep }) => [
      uri,
      cleanTabText(artist),
      cleanTabText(song),
      cleanTabText(chords),
      transposeStep,
    ]),
    settings,
  })
}

function formatRelativeTime(isoDate: string): string {
  const diffSeconds = Math.round((Date.now() - new Date(isoDate).getTime()) / 1000)
  if (diffSeconds < 45) return "just now"
  const minutes = Math.round(diffSeconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`
  return new Date(isoDate).toLocaleDateString()
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

async function fetchUltimateGuitarTab(rawUrl: string): Promise<UltimateGuitarTab> {
  const tabUrl = normalizeUltimateGuitarUrl(rawUrl)
  let serverFailure = ""

  try {
    const res = await fetch(`/api/fetch-tab?url=${encodeURIComponent(tabUrl)}`, {
      cache: "no-store",
    })
    const body = (await res.json()) as Partial<UltimateGuitarTab> & {
      sourceUrl?: string
      details?: string
    }
    // Guard against a cached response for a different tab.
    if (res.ok && body.content && body.sourceUrl === tabUrl) {
      return body as UltimateGuitarTab
    }
    serverFailure = body.details || (res.ok ? "response was for a different tab" : `status ${res.status}`)
  } catch (err) {
    serverFailure = err instanceof Error ? err.message : String(err)
  }
  console.warn("Server tab fetch failed, trying browser proxies:", serverFailure)

  for (const buildProxyUrl of CLIENT_PROXIES) {
    try {
      const res = await fetch(buildProxyUrl(tabUrl))
      if (!res.ok) continue
      const tab = extractTabFromHtml(await res.text())
      if (tab) return tab
    } catch {
      // try the next proxy
    }
  }

  throw new Error(serverFailure || "Could not load chords for this link.")
}

// Renders [ch]G[/ch] markup with chord names highlighted for on-screen reading.
function renderChordText(input: string): ReactNode[] {
  const text = cleanTabText(input).replace(/\[tab\]|\[\/tab\]/g, "")
  return text.split(/\[ch\](.*?)\[\/ch\]/g).map((segment, index) =>
    index % 2 === 1 ? (
      <span key={index} className="font-bold text-primary">
        {segment}
      </span>
    ) : (
      segment
    )
  )
}

const metadataLinePattern = /^(Title|Artist|Key|Capo)\s*:\s*(.+)$/i
const chordTokenPattern =
  /^(?:N\.C\.|[A-G](?:#|b)?(?:maj|min|m|dim|aug|sus|add|M)?(?:\d{0,2})?(?:[#b]\d{1,2})*(?:\([^)\s]+\))?(?:\/[A-G](?:#|b)?)?)$/i

const monoFontOptions: Array<{
  value: MonoFontOption
  label: string
  browserStack: string
  exportHint: string
}> = [
  {
    value: "roboto-mono",
    label: "Roboto Mono",
    browserStack: "\"Roboto Mono\", Menlo, Consolas, monospace",
    exportHint: "PDF: Roboto Mono",
  },
  {
    value: "courier-new",
    label: "Courier New",
    browserStack: "\"Courier New\", Courier, monospace",
    exportHint: "PDF: Courier fallback",
  },
  {
    value: "consolas",
    label: "Consolas",
    browserStack: "Consolas, Menlo, monospace",
    exportHint: "PDF: Courier fallback",
  },
  {
    value: "menlo",
    label: "Menlo",
    browserStack: "Menlo, Consolas, monospace",
    exportHint: "PDF: Courier fallback",
  },
]

function getBrowserFontStack(font: MonoFontOption): string {
  return (
    monoFontOptions.find(option => option.value === font)?.browserStack ||
    "\"Roboto Mono\", Menlo, Consolas, monospace"
  )
}

function isChordToken(token: string): boolean {
  const cleaned = token
    .replace(/^[([{'"`]+/, "")
    .replace(/[)\]}'"`.,:;!?]+$/, "")
  if (!cleaned) return false
  return chordTokenPattern.test(cleaned)
}

function isLikelyChordLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return false

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false

  let chordTokenCount = 0
  let lyricTokenCount = 0

  for (const token of tokens) {
    if (/^[|\\/-]+$/.test(token)) continue

    if (isChordToken(token)) {
      chordTokenCount += 1
      continue
    }

    if (/[A-Za-z]/.test(token)) {
      lyricTokenCount += 1
    }
  }

  return chordTokenCount > 0 && lyricTokenCount === 0
}

function chordifyLine(line: string): string {
  return line
    .split(/(\s+)/)
    .map(segment => {
      if (!segment || /^\s+$/.test(segment)) return segment

      const tokenMatch = segment.match(/^([|\\/]*)(.*?)([|\\/]*)$/)
      if (!tokenMatch) return segment

      const [, prefix, core, suffix] = tokenMatch
      if (!core || !isChordToken(core)) return segment

      return `${prefix}[ch]${core}[/ch]${suffix}`
    })
    .join("")
}

function parsePastedSong(rawText: string): ParsedPastedSong {
  const normalizedText = cleanTabText(rawText).trim()
  if (!normalizedText) throw new Error("Paste song text before importing.")

  const lines = normalizedText.split("\n")

  let song = ""
  let artist = ""
  let key = ""
  let capo = ""
  let bodyStartIndex = 0

  while (bodyStartIndex < lines.length) {
    const line = lines[bodyStartIndex].trim()

    if (!line) {
      bodyStartIndex += 1
      continue
    }

    const metadataMatch = line.match(metadataLinePattern)
    if (!metadataMatch) break

    const metadataKey = metadataMatch[1].toLowerCase()
    const metadataValue = metadataMatch[2].trim()

    if (metadataKey === "title" && !song) song = metadataValue
    if (metadataKey === "artist" && !artist) artist = metadataValue
    if (metadataKey === "key" && !key) key = metadataValue
    if (metadataKey === "capo" && !capo) capo = metadataValue

    bodyStartIndex += 1
  }

  const bodyLines = lines.slice(bodyStartIndex)
  if (bodyLines.length === 0) {
    throw new Error("No song body found in pasted text.")
  }

  const processedBodyLines = bodyLines.map(line =>
    isLikelyChordLine(line) ? chordifyLine(line) : line
  )

  const prefixedLines: string[] = []
  if (key) prefixedLines.push(`Key: ${key}`)
  if (capo) prefixedLines.push(`Capo: ${capo}`)
  if (prefixedLines.length > 0) prefixedLines.push("")

  const chords = [...prefixedLines, ...processedBodyLines].join("\n").trim()
  if (!chords) {
    throw new Error("Could not parse song content from pasted text.")
  }

  return {
    artist: artist || "Unknown Artist",
    song: song || "Untitled Song",
    chords,
  }
}

function songToEditableTabText(song: SongData): string {
  const body = song.transposedChords
    .replace(/\[tab\]|\[\/tab\]/g, "")
    .replace(/\[\/?ch\]/g, "")
    .trim()

  const headerLines = [`Title: ${song.song}`, `Artist: ${song.artist}`]
  return `${headerLines.join("\n")}\n\n${body}`.trim()
}

function stripChordMarkup(input: string): string {
  return input
    .replace(/\[tab\]|\[\/tab\]/g, "")
    .replace(/\[\/?ch\]/g, "")
    .replace(/\r\n/g, "\n")
}

function NoteBoxField({
  label,
  value,
  min,
  fallback,
  onChange,
}: {
  label: string
  value: number
  min: number
  fallback: number
  onChange: (value: number) => void
}) {
  const clamp = (next: number) => Math.max(min, Math.min(1, Number.isFinite(next) ? next : fallback))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm">{label}</Label>
        <Input
          type="number"
          step={0.01}
          min={min}
          max={1}
          value={value}
          onChange={e => onChange(clamp(Number.parseFloat(e.target.value)))}
          className="h-8 w-20 text-right tabular-nums"
        />
      </div>
      <Slider
        min={min}
        max={1}
        step={0.01}
        value={[value]}
        onValueChange={next => onChange(clamp(next[0]))}
      />
    </div>
  )
}

function SectionHeading({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <CardHeader className="pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <span className="text-primary">{icon}</span>
            {title}
          </CardTitle>
          {description && (
            <CardDescription className="mt-1.5 text-sm">{description}</CardDescription>
          )}
        </div>
        {action}
      </div>
    </CardHeader>
  )
}

function describeLibraryTab(publicTab: PublicTabEntry): string {
  const parts =
    publicTab.songs.length === 1
      ? [cleanTabText(publicTab.songs[0].artist)]
      : [`${publicTab.songs.length} songs (mash-up)`]
  if (publicTab.publisherName && publicTab.publisherName !== "Anonymous") {
    parts.push(`by ${cleanTabText(publicTab.publisherName)}`)
  }
  parts.push(new Date(publicTab.publishedAt).toLocaleDateString())
  return parts.join(" · ")
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9"
      />
    </div>
  )
}

function SortSelect({ value, onChange }: { value: SortMode; onChange: (value: SortMode) => void }) {
  return (
    <Select.Root value={value} onValueChange={next => onChange(next as SortMode)}>
      <Select.Trigger
        aria-label="Sort by"
        className="inline-flex h-10 flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-input bg-white pl-3 pr-2.5 text-sm text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:border-primary/60 data-[state=open]:bg-slate-50"
      >
        <ArrowUpDown className="h-4 w-4 text-slate-400" />
        <span className="hidden text-slate-500 sm:inline">Sort:</span>
        <span className="font-medium text-slate-800">
          <Select.Value />
        </span>
        <Select.Icon>
          <ChevronDown className="h-4 w-4 text-slate-400" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1"
        >
          <Select.Viewport>
            {SORT_MODES.map(mode => (
              <Select.Item
                key={mode}
                value={mode}
                className="relative flex cursor-pointer select-none items-center rounded-md py-2 pl-8 pr-3 text-sm text-slate-700 outline-none transition-colors data-[highlighted]:bg-slate-100 data-[highlighted]:text-slate-900 data-[state=checked]:font-medium data-[state=checked]:text-slate-900"
              >
                <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                  <Check className="h-4 w-4 text-primary" />
                </Select.ItemIndicator>
                <Select.ItemText>{SORT_LABELS[mode]}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

function PasswordField({
  value,
  onChange,
  status,
}: {
  value: string
  onChange: (value: string) => void
  status: PasswordStatus
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <label htmlFor="edit-password" className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <KeyRound className="h-4 w-4 text-slate-500" />
        Edit/delete password
      </label>
      <Input
        id="edit-password"
        type="password"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Ask Allen"
        autoComplete="current-password"
        className="h-8 w-40 bg-white"
      />
      <span
        className={cn(
          "text-sm",
          status === "valid" && "text-emerald-700",
          status === "invalid" && "text-red-600",
          (status === "none" || status === "checking") && "text-slate-500"
        )}
      >
        {status === "valid"
          ? "✓ You can edit and delete"
          : status === "invalid"
          ? "Wrong password"
          : status === "checking"
          ? "Checking…"
          : "Needed to edit or delete"}
      </span>
    </div>
  )
}

export default function ChordTransposer() {
  const [view, setView] = useState<WorkspaceView>("editor")

  // Current setlist
  const [songs, setSongs] = useState<SongData[]>([])
  const [setlistName, setSetlistName] = useState("")
  const [activeSavedSetlistId, setActiveSavedSetlistId] = useState<string | null>(null)
  const [savedSetlists, setSavedSetlists] = useState<SavedSetlist[]>([])
  const [savedSetlistSearch, setSavedSetlistSearch] = useState("")
  const [isSetlistsLoading, setIsSetlistsLoading] = useState(false)
  const [hasLoadedSetlists, setHasLoadedSetlists] = useState(false)
  const [isSavingSetlist, setIsSavingSetlist] = useState(false)
  const [deletingSetlistId, setDeletingSetlistId] = useState<string | null>(null)
  const [localOnlySetlists, setLocalOnlySetlists] = useState<SavedSetlist[]>([])
  const [isUploadingLocal, setIsUploadingLocal] = useState(false)
  const [setlistSort, setSetlistSort] = useState<SortMode>("added")
  const [songSort, setSongSort] = useState<SortMode>("added")
  const [editPassword, setEditPassword] = useState("")
  const [passwordStatus, setPasswordStatus] = useState<PasswordStatus>("none")
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [hasHydrated, setHasHydrated] = useState(false)

  // Adding songs
  const [linkInput, setLinkInput] = useState("")
  const [loadingProgress, setLoadingProgress] = useState<{ done: number; total: number } | null>(null)
  const [pastedTabText, setPastedTabText] = useState("")
  const [addSongsMode, setAddSongsMode] = useState<AddSongsMode>("library")
  const [librarySearch, setLibrarySearch] = useState("")
  const [isFocusMode, setIsFocusMode] = useState(false)
  const [focusPreviewScope, setFocusPreviewScope] = useState<"song" | "setlist">("song")
  const [editingSongId, setEditingSongId] = useState<string | null>(null)

  // PDF + export
  const halftoneStyle = "FLATS"
  const [simplify] = useState(false)
  const [fontSize, setFontSize] = useState(10)
  const [autoLinebreak, setAutoLinebreak] = useState(false)
  const [monoFont, setMonoFont] = useState<MonoFontOption>("roboto-mono")
  const [noteBoxes, setNoteBoxes] = useState<PositionedNoteBox[]>([])
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [previewNotePage, setPreviewNotePage] = useState(1)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [isFullScreen, setIsFullScreen] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)
  const [isNotesPanelOpen, setIsNotesPanelOpen] = useState(false)
  const [isAdvancedExportOpen, setIsAdvancedExportOpen] = useState(false)

  // Feedback
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Public tabs
  const [publicTabs, setPublicTabs] = useState<PublicTabEntry[]>([])
  const [isPublicTabsLoading, setIsPublicTabsLoading] = useState(false)
  const [isPublishingSong, setIsPublishingSong] = useState(false)
  const [isPublishSongDialogOpen, setIsPublishSongDialogOpen] = useState(false)
  const [songToPublish, setSongToPublish] = useState<SongData | null>(null)
  const [publishSongTitle, setPublishSongTitle] = useState("")
  const [publishSongAuthor, setPublishSongAuthor] = useState("")
  const [previewPublicTab, setPreviewPublicTab] = useState<PublicTabEntry | null>(null)
  const [publicTabsSearch, setPublicTabsSearch] = useState("")
  const [publicSongSearch, setPublicSongSearch] = useState("")
  const [songEditTarget, setSongEditTarget] = useState<PublicTabEntry | null>(null)
  const [songEditTitle, setSongEditTitle] = useState("")
  const [songEditArtist, setSongEditArtist] = useState("")
  const [songEditPublisher, setSongEditPublisher] = useState("")
  const [songEditText, setSongEditText] = useState("")
  const [isSavingSongEdit, setIsSavingSongEdit] = useState(false)
  const [deletingTabId, setDeletingTabId] = useState<string | null>(null)

  const isLoadingLinks = loadingProgress !== null
  const pendingLinks = useMemo(() => extractUrls(linkInput), [linkInput])

  const showNotice = useCallback((message: string) => {
    setError(null)
    setNotice(message)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timeout = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timeout)
  }, [notice])

  const draftParse = useMemo<{
    song: ParsedPastedSong | null
    error: string | null
  }>(() => {
    if (!pastedTabText.trim()) {
      return { song: null, error: null }
    }

    try {
      return {
        song: parsePastedSong(pastedTabText),
        error: null,
      }
    } catch (err) {
      return {
        song: null,
        error:
          err instanceof Error
            ? err.message
            : "Could not parse pasted song text.",
      }
    }
  }, [pastedTabText])

  const parsedPastedSong = draftParse.song
  const pastedTabError = draftParse.error
  const canEditNotes = Boolean(pdfUrl)

  const currentSettings = useMemo<SavedSetlistSettings>(
    () => ({ fontSize, autoLinebreak, monoFont, noteBoxes }),
    [fontSize, autoLinebreak, monoFont, noteBoxes]
  )

  const currentExportSettings = useMemo<ExportSettings>(
    () => ({
      monoFont,
      noteBoxes,
    }),
    [monoFont, noteBoxes]
  )

  // ---------- Persistence (saved setlists + autosaved working setlist) ----------

  const applyWorkingSetlist = useCallback((working: WorkingSetlist | null) => {
    if (!working || !Array.isArray(working.songs)) return
    setSongs(
      working.songs.map(song => ({
        id: song.id || createId(),
        uri: song.uri,
        artist: cleanTabText(song.artist),
        song: cleanTabText(song.song),
        chords: cleanTabText(song.chords),
        transposedChords: cleanTabText(song.chords),
        transposeStep: song.transposeStep || 0,
      }))
    )
    setSetlistName(working.name || "")
    setActiveSavedSetlistId(working.savedSetlistId || null)
    if (working.settings) {
      setFontSize(working.settings.fontSize ?? 10)
      setAutoLinebreak(Boolean(working.settings.autoLinebreak))
      setMonoFont(working.settings.monoFont || "roboto-mono")
      setNoteBoxes(Array.isArray(working.settings.noteBoxes) ? working.settings.noteBoxes : [])
    }
  }, [])

  const lastWrittenWorkingRef = useRef<string | null>(null)

  useEffect(() => {
    applyWorkingSetlist(readStorage<WorkingSetlist>(WORKING_SETLIST_STORAGE_KEY))

    const storedLocal = readStorage<SavedSetlist[]>(SAVED_SETLISTS_STORAGE_KEY)
    if (Array.isArray(storedLocal)) setLocalOnlySetlists(storedLocal)

    const storedPassword = readStorage<string>(EDIT_PASSWORD_STORAGE_KEY)
    if (typeof storedPassword === "string") setEditPassword(storedPassword)

    const storedSetlistSort = readStorage<SortMode>(SETLIST_SORT_STORAGE_KEY)
    if (storedSetlistSort && SORT_MODES.includes(storedSetlistSort)) setSetlistSort(storedSetlistSort)
    const storedSongSort = readStorage<SortMode>(SONG_SORT_STORAGE_KEY)
    if (storedSongSort && SORT_MODES.includes(storedSongSort)) setSongSort(storedSongSort)
    const storedAddMode = readStorage<AddSongsMode>(ADD_MODE_STORAGE_KEY)
    if (storedAddMode && ADD_SONGS_MODES.includes(storedAddMode)) setAddSongsMode(storedAddMode)

    setHasHydrated(true)

    // Keep several open tabs of the app in sync.
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== WORKING_SETLIST_STORAGE_KEY || !event.newValue) return
      if (event.newValue === lastWrittenWorkingRef.current) return
      try {
        lastWrittenWorkingRef.current = event.newValue
        applyWorkingSetlist(JSON.parse(event.newValue) as WorkingSetlist)
      } catch {
        // ignore malformed data
      }
    }

    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [applyWorkingSetlist])

  useEffect(() => {
    if (!hasHydrated) return
    const serialized = serializeWorkingSetlist(
      setlistName,
      activeSavedSetlistId,
      songs,
      currentSettings
    )
    if (serialized === lastWrittenWorkingRef.current) return
    lastWrittenWorkingRef.current = serialized
    try {
      window.localStorage.setItem(WORKING_SETLIST_STORAGE_KEY, serialized)
    } catch (err) {
      console.error("Failed to autosave setlist:", err)
    }
  }, [hasHydrated, setlistName, activeSavedSetlistId, songs, currentSettings])

  // Remember list preferences in this browser.
  useEffect(() => {
    if (hasHydrated) writeStorage(SETLIST_SORT_STORAGE_KEY, setlistSort)
  }, [hasHydrated, setlistSort])
  useEffect(() => {
    if (hasHydrated) writeStorage(SONG_SORT_STORAGE_KEY, songSort)
  }, [hasHydrated, songSort])
  useEffect(() => {
    if (hasHydrated) writeStorage(ADD_MODE_STORAGE_KEY, addSongsMode)
  }, [hasHydrated, addSongsMode])

  // ---------- Edit/delete password ----------

  // Saved in this browser; the server checks it on every edit/delete.
  useEffect(() => {
    if (!hasHydrated) return
    writeStorage(EDIT_PASSWORD_STORAGE_KEY, editPassword)

    const password = editPassword.trim()
    if (!password) {
      setPasswordStatus("none")
      return
    }

    setPasswordStatus("checking")
    let cancelled = false
    const timeout = setTimeout(async () => {
      try {
        const body = await apiRequest<{ ok: boolean }>("/api/check-password", "POST", { password })
        if (!cancelled) setPasswordStatus(body.ok ? "valid" : "invalid")
      } catch {
        if (!cancelled) setPasswordStatus("invalid")
      }
    }, 400)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [hasHydrated, editPassword])

  const canEdit = passwordStatus === "valid"

  // ---------- Shared setlists ----------

  const loadSetlists = useCallback(async () => {
    setIsSetlistsLoading(true)
    try {
      const body = await apiRequest<{ setlists: SavedSetlist[] }>("/api/setlists")
      setSavedSetlists(Array.isArray(body.setlists) ? body.setlists : [])
      setHasLoadedSetlists(true)
    } catch (err) {
      console.error("Failed to load setlists:", err)
      setError(err instanceof Error ? err.message : "Failed to load setlists.")
    } finally {
      setIsSetlistsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSetlists()
  }, [loadSetlists])

  const activeSavedSetlist = useMemo(
    () => savedSetlists.find(setlist => setlist.id === activeSavedSetlistId) || null,
    [savedSetlists, activeSavedSetlistId]
  )

  const hasUnsavedChanges = useMemo(() => {
    if (!activeSavedSetlist) return songs.length > 0
    return (
      setlistFingerprint(setlistName, songs, currentSettings) !==
      setlistFingerprint(activeSavedSetlist.name, activeSavedSetlist.songs, activeSavedSetlist.settings)
    )
  }, [activeSavedSetlist, setlistName, songs, currentSettings])

  const saveSetlist = useCallback(
    async (asNew = false) => {
      if (songs.length === 0) {
        setError("Add at least one song before saving a setlist.")
        return
      }

      const name = setlistName.trim() || `Setlist ${new Date().toLocaleDateString()}`
      const existing = asNew ? null : activeSavedSetlist
      const payload = {
        id: existing?.id,
        name,
        songs: songs.map(({ uri, artist, song, chords, transposeStep }) => ({
          uri,
          artist,
          song,
          chords,
          transposeStep,
        })),
        settings: currentSettings,
      }

      setIsSavingSetlist(true)
      setError(null)
      try {
        const { setlist } = await apiRequest<{ setlist: SavedSetlist }>(
          "/api/setlists",
          existing ? "PUT" : "POST",
          payload
        )
        setSavedSetlists(prev => [setlist, ...prev.filter(entry => entry.id !== setlist.id)])
        setSetlistName(setlist.name)
        setActiveSavedSetlistId(setlist.id)
        showNotice(existing ? `Updated "${setlist.name}"` : `Saved "${setlist.name}"`)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save setlist.")
      } finally {
        setIsSavingSetlist(false)
      }
    },
    [songs, setlistName, activeSavedSetlist, currentSettings, showNotice]
  )

  const confirmDiscardChanges = useCallback(() => {
    if (!hasUnsavedChanges || songs.length === 0) return true
    return window.confirm("Your current setlist has unsaved changes. Discard them?")
  }, [hasUnsavedChanges, songs.length])

  const openSavedSetlist = useCallback(
    (saved: SavedSetlist) => {
      if (saved.id !== activeSavedSetlistId && !confirmDiscardChanges()) return

      setSongs(songsFromSaved(saved))
      setSetlistName(saved.name)
      setActiveSavedSetlistId(saved.id)
      setFontSize(saved.settings?.fontSize ?? 10)
      setAutoLinebreak(Boolean(saved.settings?.autoLinebreak))
      setMonoFont(saved.settings?.monoFont || "roboto-mono")
      setNoteBoxes(saved.settings?.noteBoxes || [])
      setSelectedNoteId(null)
      setEditingSongId(null)
      setPastedTabText("")
      setView("editor")
      showNotice(`Opened "${saved.name}"`)
    },
    [activeSavedSetlistId, confirmDiscardChanges, showNotice]
  )

  const appendSavedSetlist = useCallback(
    (saved: SavedSetlist) => {
      setSongs(prev => [...prev, ...songsFromSaved(saved)])
      setView("editor")
      showNotice(`Added ${pluralize(saved.songs.length, "song")} from "${saved.name}"`)
    },
    [showNotice]
  )

  const deleteSavedSetlist = useCallback(
    async (saved: SavedSetlist) => {
      if (!window.confirm(`Delete setlist "${saved.name}" for everyone? This can't be undone.`)) return

      setDeletingSetlistId(saved.id)
      setError(null)
      try {
        await apiRequest("/api/setlists", "DELETE", { id: saved.id, password: editPassword.trim() })
        setSavedSetlists(prev => prev.filter(setlist => setlist.id !== saved.id))
        if (activeSavedSetlistId === saved.id) setActiveSavedSetlistId(null)
        showNotice(`Deleted "${saved.name}"`)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete setlist.")
      } finally {
        setDeletingSetlistId(null)
      }
    },
    [activeSavedSetlistId, editPassword, showNotice]
  )

  // Setlists saved before they were shared lived only in this browser.
  const uploadLocalSetlists = useCallback(async () => {
    setIsUploadingLocal(true)
    setError(null)
    const remaining: SavedSetlist[] = []
    for (const local of localOnlySetlists) {
      try {
        await apiRequest("/api/setlists", "POST", local)
      } catch (err) {
        // 409 means it was already uploaded (e.g. from another tab).
        if (!(err instanceof ApiError && err.status === 409)) remaining.push(local)
      }
    }

    setLocalOnlySetlists(remaining)
    if (remaining.length > 0) writeStorage(SAVED_SETLISTS_STORAGE_KEY, remaining)
    else {
      try {
        window.localStorage.removeItem(SAVED_SETLISTS_STORAGE_KEY)
      } catch {
        // ignore
      }
    }

    await loadSetlists()
    setIsUploadingLocal(false)
    if (remaining.length > 0) {
      setError(`Couldn't upload ${pluralize(remaining.length, "setlist")}. Try again.`)
    } else {
      showNotice("Uploaded your setlists — everyone can see them now.")
    }
  }, [localOnlySetlists, loadSetlists, showNotice])

  const startNewSetlist = useCallback(() => {
    if (!confirmDiscardChanges()) return
    setSongs([])
    setSetlistName("")
    setActiveSavedSetlistId(null)
    setNoteBoxes([])
    setSelectedNoteId(null)
    setEditingSongId(null)
    setPastedTabText("")
  }, [confirmDiscardChanges])

  const filteredSavedSetlists = useMemo(() => {
    const query = savedSetlistSearch.trim().toLowerCase()
    const matching = query
      ? savedSetlists.filter(setlist =>
          `${setlist.name} ${setlist.songs.map(song => `${song.song} ${song.artist}`).join(" ")}`
            .toLowerCase()
            .includes(query)
        )
      : savedSetlists
    return sortItems(matching, setlistSort, {
      added: setlist => setlist.createdAt,
      modified: setlist => setlist.updatedAt,
      name: setlist => setlist.name,
    })
  }, [savedSetlists, savedSetlistSearch, setlistSort])

  // ---------- Adding songs ----------

  const addSongsFromLinks = useCallback(async () => {
    const urls = extractUrls(linkInput)
    if (urls.length === 0) {
      setError("Paste one or more Ultimate Guitar links.")
      return
    }

    const invalid = urls.filter(url => !isUltimateGuitarUrl(url))
    if (invalid.length > 0) {
      setError(`Not an Ultimate Guitar link: ${invalid[0]}`)
      return
    }

    setError(null)
    setLoadingProgress({ done: 0, total: urls.length })

    const failed: string[] = []
    let added = 0
    let lastFailureReason = ""

    for (const [index, url] of urls.entries()) {
      try {
        const tab = await fetchUltimateGuitarTab(url)
        const newSong: SongData = {
          id: createId(),
          uri: normalizeUltimateGuitarUrl(url),
          artist: tab.artist,
          song: tab.song,
          chords: tab.content,
          transposedChords: tab.content,
          transposeStep: 0,
        }
        setSongs(prev => [...prev, newSong])
        added += 1
      } catch (err) {
        console.error("Failed to load song:", url, err)
        failed.push(url)
        if (err instanceof Error) lastFailureReason = err.message
      }
      setLoadingProgress({ done: index + 1, total: urls.length })
    }

    setLoadingProgress(null)
    setLinkInput(failed.join("\n"))

    if (failed.length > 0) {
      setError(
        `Couldn't load ${pluralize(failed.length, "link")}. ${
          added > 0 ? `Added ${pluralize(added, "song")}. ` : ""
        }${lastFailureReason ? `(${lastFailureReason}) ` : ""}Check the link${failed.length === 1 ? "" : "s"} left in the box, or use "Paste text" instead.`
      )
    } else {
      showNotice(`Added ${pluralize(added, "song")}`)
    }
  }, [linkInput, showNotice])

  const addOrConfirmPastedSong = useCallback(() => {
    if (!pastedTabText.trim()) {
      setError("Paste song text before importing.")
      return
    }

    if (!parsedPastedSong) {
      setError(pastedTabError || "Could not parse pasted song text.")
      return
    }

    setError(null)

    if (editingSongId) {
      setSongs(prev =>
        prev.map(song =>
          song.id === editingSongId
            ? {
                ...song,
                artist: parsedPastedSong.artist,
                song: parsedPastedSong.song,
                chords: parsedPastedSong.chords,
                transposedChords: parsedPastedSong.chords,
                transposeStep: 0,
              }
            : song
        )
      )

      setEditingSongId(null)
      setPastedTabText("")
      setIsFocusMode(false)
      return
    }

    const songId = createId()
    const newSong: SongData = {
      id: songId,
      uri: `manual://pasted/${songId}`,
      artist: parsedPastedSong.artist,
      song: parsedPastedSong.song,
      chords: parsedPastedSong.chords,
      transposedChords: parsedPastedSong.chords,
      transposeStep: 0,
    }

    setSongs(prev => [...prev, newSong])
    setPastedTabText("")
    setIsFocusMode(false)
    showNotice(`Added "${newSong.song}"`)
  }, [
    pastedTabText,
    parsedPastedSong,
    pastedTabError,
    editingSongId,
    showNotice,
  ])

  const previewSongs = useMemo(() => {
    if (!parsedPastedSong || editingSongId) return songs

    const draftSongId = "draft-preview-song"
    const draftSong: SongData = {
      id: draftSongId,
      uri: `manual://draft/${draftSongId}`,
      artist: parsedPastedSong.artist,
      song: parsedPastedSong.song,
      chords: parsedPastedSong.chords,
      transposedChords: parsedPastedSong.chords,
      transposeStep: 0,
    }

    return [...songs, draftSong]
  }, [songs, parsedPastedSong, editingSongId])

  // ---------- Note boxes ----------

  const selectedNoteBox = useMemo(
    () => noteBoxes.find(box => box.id === selectedNoteId) || null,
    [noteBoxes, selectedNoteId]
  )

  useEffect(() => {
    if (!selectedNoteId) return
    if (noteBoxes.some(noteBox => noteBox.id === selectedNoteId)) return
    setSelectedNoteId(null)
  }, [noteBoxes, selectedNoteId])

  const addNoteBox = useCallback(() => {
    const page = Math.max(1, Math.round(previewNotePage))
    const noteId = createId()
    const newNote: PositionedNoteBox = {
      id: noteId,
      page,
      x: 0.62,
      y: 0.08,
      width: 0.24,
      height: 0.18,
      text: "",
    }

    setNoteBoxes(prev => [...prev, newNote])
    setSelectedNoteId(noteId)
    setPreviewNotePage(page)
  }, [previewNotePage])

  const updateSelectedNoteBox = useCallback(
    (updater: (noteBox: PositionedNoteBox) => PositionedNoteBox) => {
      if (!selectedNoteId) return

      setNoteBoxes(prev =>
        prev.map(noteBox =>
          noteBox.id === selectedNoteId ? updater(noteBox) : noteBox
        )
      )
    },
    [selectedNoteId]
  )

  const removeSelectedNoteBox = useCallback(() => {
    if (!selectedNoteId) return
    setNoteBoxes(prev => prev.filter(noteBox => noteBox.id !== selectedNoteId))
    setSelectedNoteId(null)
  }, [selectedNoteId])

  // ---------- Public tabs ----------

  const sortedPublicTabs = useMemo(
    () =>
      sortItems(publicTabs, songSort, {
        added: tab => tab.publishedAt,
        modified: tab => tab.updatedAt || tab.publishedAt,
        name: tab => cleanTabText(tab.setlistTitle),
      }),
    [publicTabs, songSort]
  )

  const searchPublicTabs = useCallback(
    (queryText: string) => {
      const query = queryText.trim().toLowerCase()
      if (!query) return sortedPublicTabs
      return sortedPublicTabs.filter(tab => {
        const songMetadata = tab.songs.map(song => `${song.song} ${song.artist}`).join(" ")
        return `${tab.setlistTitle} ${tab.publisherName} ${songMetadata}`
          .toLowerCase()
          .includes(query)
      })
    },
    [sortedPublicTabs]
  )

  const filteredPublicTabs = useMemo(
    () => searchPublicTabs(publicTabsSearch),
    [searchPublicTabs, publicTabsSearch]
  )
  const filteredLibraryTabs = useMemo(
    () => searchPublicTabs(librarySearch),
    [searchPublicTabs, librarySearch]
  )

  const filteredPreviewSongs = useMemo(() => {
    const songsForPreview = previewPublicTab?.songs || []
    const query = publicSongSearch.trim().toLowerCase()
    if (!query) return songsForPreview

    return songsForPreview.filter(song => {
      const searchableText = `${song.song} ${song.artist} ${stripChordMarkup(song.transposedChords)}`.toLowerCase()
      return searchableText.includes(query)
    })
  }, [previewPublicTab, publicSongSearch])

  const loadPublicTabs = useCallback(async () => {
    setIsPublicTabsLoading(true)
    try {
      const res = await fetch("/api/public-tabs")
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || "Failed to load songs. Try refreshing.")
      }

      const data = (await res.json()) as PublicTabsResponse
      setPublicTabs(Array.isArray(data.tabs) ? data.tabs : [])
    } catch (err) {
      console.error("Failed to fetch songs:", err)
      setError(err instanceof Error ? err.message : "Failed to load songs. Try refreshing.")
    } finally {
      setIsPublicTabsLoading(false)
    }
  }, [])

  const openPublishSongDialog = useCallback((song: SongData) => {
    setSongToPublish(song)
    setPublishSongTitle(song.song)
    setPublishSongAuthor(song.artist)
    setIsPublishSongDialogOpen(true)
  }, [])

  const publishSingleSong = useCallback(async () => {
    if (!songToPublish) return

    const songTitle = publishSongTitle.trim()
    if (!songTitle) {
      setError("Song name is required to publish.")
      return
    }

    setIsPublishingSong(true)
    setError(null)

    try {
      const response = await fetch("/api/public-tabs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          publisherName: publishSongAuthor.trim(),
          setlistTitle: songTitle,
          notes: "",
          exportSettings: {
            monoFont,
            noteBoxes,
          },
          songs: [
            {
              artist: songToPublish.artist,
              song: songToPublish.song,
              transposedChords: songToPublish.transposedChords,
              transposeStep: songToPublish.transposeStep,
            },
          ],
        }),
      })

      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        throw new Error(body.error || "Failed to publish song")
      }

      showNotice(`Published "${songTitle}"`)
      setIsPublishSongDialogOpen(false)
      setSongToPublish(null)
      await loadPublicTabs()
    } catch (err) {
      console.error("Failed to publish song:", err)
      setError(
        err instanceof Error
          ? err.message
          : "Failed to publish song. Please try again."
      )
    } finally {
      setIsPublishingSong(false)
    }
  }, [songToPublish, publishSongTitle, publishSongAuthor, monoFont, noteBoxes, loadPublicTabs, showNotice])

  const addPublicTabToSetlist = useCallback(
    (publicTab: PublicTabEntry) => {
      const importedSongs: SongData[] = publicTab.songs.map((song, index) => ({
        id: createId(),
        uri: `public://${publicTab.id}/${index}`,
        artist: cleanTabText(song.artist),
        song: cleanTabText(song.song),
        chords: cleanTabText(song.transposedChords),
        transposedChords: cleanTabText(song.transposedChords),
        transposeStep: 0,
      }))

      setSongs(prev => [...prev, ...importedSongs])
      showNotice(
        importedSongs.length === 1
          ? `Added "${importedSongs[0].song}" to your setlist`
          : `Added ${pluralize(importedSongs.length, "song")} to your setlist`
      )
    },
    [showNotice]
  )

  const openPublicTabPreview = useCallback((publicTab: PublicTabEntry) => {
    setPublicSongSearch("")
    setPreviewPublicTab(publicTab)
  }, [])

  const deletePublicTab = useCallback(
    async (publicTab: PublicTabEntry) => {
      if (!window.confirm(`Delete "${cleanTabText(publicTab.setlistTitle)}" from the song library for everyone?`)) {
        return
      }

      setDeletingTabId(publicTab.id)
      setError(null)

      try {
        await apiRequest("/api/public-tabs", "DELETE", {
          id: publicTab.id,
          password: editPassword.trim(),
        })
        setPublicTabs(prev => prev.filter(tab => tab.id !== publicTab.id))
        if (previewPublicTab?.id === publicTab.id) {
          setPreviewPublicTab(null)
        }
        showNotice(`Deleted "${cleanTabText(publicTab.setlistTitle)}"`)
      } catch (err) {
        console.error("Failed deleting public tab:", err)
        setError(err instanceof Error ? err.message : "Failed to delete song.")
      } finally {
        setDeletingTabId(null)
      }
    },
    [editPassword, previewPublicTab, showNotice]
  )

  const openSongEditor = useCallback((publicTab: PublicTabEntry) => {
    const isSingleSong = publicTab.songs.length === 1
    setSongEditTarget(publicTab)
    setSongEditTitle(cleanTabText(publicTab.setlistTitle))
    setSongEditPublisher(cleanTabText(publicTab.publisherName))
    setSongEditArtist(isSingleSong ? cleanTabText(publicTab.songs[0].artist) : "")
    setSongEditText(isSingleSong ? stripChordMarkup(cleanTabText(publicTab.songs[0].transposedChords)).trim() : "")
  }, [])

  const saveSongEdit = useCallback(async () => {
    if (!songEditTarget) return
    const title = songEditTitle.trim()
    if (!title) {
      setError("A title is required.")
      return
    }

    const isSingleSong = songEditTarget.songs.length === 1
    let songs: PublicTabEntry["songs"] | undefined
    if (isSingleSong) {
      try {
        const artist = songEditArtist.trim() || "Unknown Artist"
        const parsed = parsePastedSong(`Title: ${title}\nArtist: ${artist}\n\n${songEditText}`)
        songs = [{ artist, song: title, transposedChords: parsed.chords, transposeStep: 0 }]
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't read the chord sheet.")
        return
      }
    }

    setIsSavingSongEdit(true)
    setError(null)
    try {
      const { tab } = await apiRequest<{ tab: PublicTabEntry }>("/api/public-tabs", "PUT", {
        id: songEditTarget.id,
        password: editPassword.trim(),
        setlistTitle: title,
        publisherName: songEditPublisher.trim(),
        songs,
      })
      setPublicTabs(prev => prev.map(entry => (entry.id === tab.id ? tab : entry)))
      if (previewPublicTab?.id === tab.id) setPreviewPublicTab(tab)
      setSongEditTarget(null)
      showNotice(`Saved changes to "${cleanTabText(tab.setlistTitle)}"`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes.")
    } finally {
      setIsSavingSongEdit(false)
    }
  }, [
    songEditTarget,
    songEditTitle,
    songEditArtist,
    songEditPublisher,
    songEditText,
    editPassword,
    previewPublicTab,
    showNotice,
  ])

  useEffect(() => {
    loadPublicTabs()
  }, [loadPublicTabs])

  // ---------- Editing songs in the setlist ----------

  // Edits are made on the transposed text, so the transposition is baked in
  // and the step resets to 0 (otherwise the song would be transposed twice).
  useEffect(() => {
    if (!editingSongId || !parsedPastedSong) return

    setSongs(prev =>
      prev.map(song =>
        song.id === editingSongId
          ? {
              ...song,
              artist: parsedPastedSong.artist,
              song: parsedPastedSong.song,
              chords: parsedPastedSong.chords,
              transposedChords: parsedPastedSong.chords,
              transposeStep: 0,
            }
          : song
      )
    )
  }, [editingSongId, parsedPastedSong])

  const startEditingSong = useCallback((song: SongData) => {
    setEditingSongId(song.id)
    setPastedTabText(songToEditableTabText(song))
    setAddSongsMode("paste")
    setError(null)
    setView("editor")
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const cancelEditingSong = useCallback(() => {
    setEditingSongId(null)
    setPastedTabText("")
    setIsFocusMode(false)
  }, [])

  const removeSong = useCallback(
    (id: string) => {
      setSongs(prev => prev.filter(s => s.id !== id))
      if (editingSongId === id) {
        setEditingSongId(null)
        setPastedTabText("")
      }
    },
    [editingSongId]
  )

  const moveSong = useCallback((index: number, direction: -1 | 1) => {
    setSongs(prev => {
      const target = index + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [])

  const moveSongTo = useCallback((from: number, to: number) => {
    setSongs(prev => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  const updateTranspose = useCallback((id: string, step: number) => {
    setSongs(prev =>
      prev.map(s =>
        s.id === id ? { ...s, transposeStep: Math.max(-12, Math.min(12, step)) } : s
      )
    )
  }, [])

  // Keyboard shortcut for fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "f" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        pdfUrl &&
        view === "editor"
      ) {
        const activeElement = document.activeElement
        if (
          activeElement &&
          (activeElement.tagName === "INPUT" ||
            activeElement.tagName === "TEXTAREA" ||
            activeElement.tagName === "SELECT")
        )
          return

        e.preventDefault()
        setIsFullScreen(true)
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [pdfUrl, view])

  // Transpose effect
  const transposeDeps = songs
    .map(s => s.chords + s.transposeStep)
    .join(",")

  useEffect(() => {
    const transposeSong = (chords: string, transposeStep: number): string => {
      if (!chords) return ""

      const transChords: string[] = chords.split(/\[ch\]|\[\/ch\]/g)
      let regex: string[] = []

      for (let i = 1; i < transChords.length; i += 2) {
        const chord = transChords[i]
        if (!chord) continue

        try {
          let tones = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]
          if (halftoneStyle === "FLATS") {
            tones = ["A", "Bb", "B", "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab"]
          }

          const parsedChord = parse(chord, {})
          const transChord = transpose(parsedChord, transposeStep)

          if (simplify) {
            delete transChord.extended
            delete transChord.suspended
            delete transChord.added
            delete transChord.overridingRoot
          }

          const prettyChord = prettyPrint(parsedChord, { naming: tones })
          const prettyTransChord = prettyPrint(transChord, { naming: tones })

          const diff = prettyTransChord.length - prettyChord.length
          const filler = diff >= 0 ? "-".repeat(diff) : " ".repeat(Math.abs(diff))

          transChords[i] = `[ch]${prettyTransChord}[/ch]` + filler

          if (diff >= 0) regex.push(filler + " ".repeat(diff))
        } catch (err) {
          console.error("Failed to transpose", chord)
          console.error("Error: ", err)
        }
      }

      regex = [...new Set(regex.filter(r => r.length > 1))]

      return transChords
        .join("")
        .replace(new RegExp(regex.join("|"), "gm"), "")
        .replace(/-+(\n|\r|\S)/gm, "$1")
        .replace(/\[\/ch\]\s\[ch\]/g, "[/ch]  [ch]")
        .replace(/\[\/ch\]\[ch\]/g, "[/ch] [ch]")
        .replace(/\[\/ch\](\w)/g, "[/ch] $1")
    }

    setSongs(prev =>
      prev.map(song => ({
        ...song,
        transposedChords: transposeSong(song.chords, song.transposeStep),
      }))
    )
  }, [transposeDeps, simplify, halftoneStyle])

  // In focus mode the preview can show just the song being written or edited,
  // so it starts on that song instead of page 1 of the setlist.
  const focusSongs = useMemo(() => {
    if (editingSongId) return previewSongs.filter(song => song.id === editingSongId)
    return previewSongs.filter(song => song.id === "draft-preview-song")
  }, [previewSongs, editingSongId])

  const isFocusSongPreview = isFocusMode && focusPreviewScope === "song" && focusSongs.length > 0
  const pdfSongs = isFocusSongPreview ? focusSongs : previewSongs
  const pdfExportSettings = useMemo<ExportSettings>(
    // Note boxes are placed on setlist pages, so leave them out of a single-song preview.
    () => (isFocusSongPreview ? { ...currentExportSettings, noteBoxes: [] } : currentExportSettings),
    [isFocusSongPreview, currentExportSettings]
  )

  // Generate PDF (debounced so typing doesn't rebuild it on every keystroke)
  useEffect(() => {
    if (pdfSongs.length === 0) {
      setPdfUrl(null)
      return
    }

    let cancelled = false
    const timeout = setTimeout(async () => {
      try {
        const { dataUrl } = await generatePDF(pdfSongs, fontSize, autoLinebreak, pdfExportSettings)
        if (!cancelled) setPdfUrl(dataUrl)
      } catch (err) {
        console.error("Failed to generate PDF:", err)
        if (!cancelled) setError("Failed to generate PDF preview")
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [pdfSongs, fontSize, autoLinebreak, pdfExportSettings])

  useEffect(() => {
    if (!isFocusMode) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFocusMode(false)
    }
    document.addEventListener("keydown", handleKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [isFocusMode])

  const exportBaseName =
    setlistName.trim() ||
    (songs.length === 1
      ? `${songs[0].artist} - ${songs[0].song}`
      : `Setlist - ${pluralize(songs.length, "song")}`)

  const handleDownloadPDF = () => {
    if (!pdfUrl) return

    const a = document.createElement("a")
    a.href = pdfUrl
    a.download = `${exportBaseName}.pdf`

    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleCopyToClipboard = async () => {
    if (songs.length === 0) return

    try {
      const formattedText = songs
        .map((song, i) => {
          let text = `${song.artist}\n${song.song}\n`
          if (song.transposeStep !== 0) {
            text += `(Transposed ${song.transposeStep > 0 ? "+" : ""}${song.transposeStep})\n`
          }
          text += "\n" + song.transposedChords.replace(/\[\/?ch\]/g, "")

          if (i < songs.length - 1) {
            text += "\n\n" + "=".repeat(60) + "\n\n"
          }

          return text
        })
        .join("")

      await navigator.clipboard.writeText(formattedText)
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
    } catch {
      setError("Failed to copy to clipboard")
    }
  }

  const handleDownloadDocx = async () => {
    if (songs.length === 0) return

    try {
      const blob = await generateDocx(
        songs,
        fontSize,
        autoLinebreak,
        currentExportSettings
      )
      const url = URL.createObjectURL(blob)

      const a = document.createElement("a")
      a.href = url
      a.download = `${exportBaseName}.docx`

      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setError("Failed to generate Word document")
    }
  }

  const navItems: Array<{ value: WorkspaceView; label: string; count?: number }> = [
    { value: "editor", label: "Editor", count: songs.length || undefined },
    { value: "saved", label: "Setlists", count: savedSetlists.length || undefined },
    { value: "published", label: "Songs", count: publicTabs.length || undefined },
  ]

  const renderPasteTextarea = (id: string, className: string) => (
    <textarea
      id={id}
      value={pastedTabText}
      onChange={e => setPastedTabText(e.target.value)}
      onKeyDown={e => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          addOrConfirmPastedSong()
        }
      }}
      placeholder={"Title: Song Name\nArtist: Artist Name\nKey: G\nCapo: 4\n\n[Verse 1]\nD      G\nLyrics..."}
      spellCheck={false}
      className={cn(
        "w-full rounded-md border border-input bg-white px-3 py-2 text-sm leading-6 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
      style={{ fontFamily: getBrowserFontStack(monoFont) }}
    />
  )

  const pasteActions = (
    <div className="flex items-center gap-2">
      {editingSongId && (
        <Button onClick={cancelEditingSong} variant="outline">
          Cancel
        </Button>
      )}
      <Button
        onClick={addOrConfirmPastedSong}
        disabled={!pastedTabText.trim() || Boolean(pastedTabError)}
        variant={editingSongId || isFocusMode ? "default" : "secondary"}
      >
        {editingSongId ? (
          <>
            <Check className="mr-2 h-4 w-4" />
            Done editing
          </>
        ) : (
          <>
            <Plus className="mr-2 h-4 w-4" />
            Add song
          </>
        )}
      </Button>
    </div>
  )

  const editingSong = editingSongId ? songs.find(song => song.id === editingSongId) : null

  const setlistStatus = isSavingSetlist
    ? "Saving…"
    : activeSavedSetlist
    ? hasUnsavedChanges
      ? "Unsaved changes"
      : `Saved ${formatRelativeTime(activeSavedSetlist.updatedAt)}`
    : songs.length > 0
    ? "Not saved yet"
    : null

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Music2 className="h-6 w-6 text-primary" />
            <span className="text-xl font-bold tracking-tight">tabs</span>
          </div>

          <nav className="order-3 flex w-full gap-1 rounded-lg bg-slate-100 p-1 sm:order-none sm:w-auto">
            {navItems.map(item => (
              <button
                key={item.value}
                type="button"
                onClick={() => setView(item.value)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors sm:flex-none",
                  view === item.value
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                )}
              >
                {item.label}
                {item.count !== undefined && (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs tabular-nums",
                      view === item.value ? "bg-primary/10 text-primary" : "bg-slate-200 text-slate-600"
                    )}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsFullScreen(true)}
              disabled={!pdfUrl}
              className="hidden md:inline-flex"
              title="Fullscreen with autoscroll (F)"
            >
              <Maximize className="mr-2 h-4 w-4" />
              Fullscreen
            </Button>
            <Button size="sm" onClick={handleDownloadPDF} disabled={!pdfUrl}>
              <FileDown className="mr-2 h-4 w-4" />
              Download PDF
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-grow">
        <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
          {(error || notice) && (
            <div
              role={error ? "alert" : "status"}
              className={cn(
                "mb-6 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
                error
                  ? "border-red-200 bg-red-50 text-red-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              )}
            >
              {error ? (
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0" />
              )}
              <span className="flex-1 leading-relaxed">{error || notice}</span>
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setNotice(null)
                }}
                className="rounded p-0.5 opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {view === "editor" && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="space-y-6 lg:col-span-5">
                <Card className="shadow-sm">
                  <SectionHeading
                    icon={<Plus className="h-5 w-5" />}
                    title="Add songs"
                  />
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1" role="tablist">
                      {(
                        [
                          { mode: "library", label: "Library", icon: <Library className="h-4 w-4" /> },
                          { mode: "link", label: "Link", icon: <LinkIcon className="h-4 w-4" /> },
                          { mode: "paste", label: editingSongId ? "Editing" : "Paste text", icon: <ClipboardPaste className="h-4 w-4" /> },
                        ] as Array<{ mode: AddSongsMode; label: string; icon: ReactNode }>
                      ).map(tab => (
                        <button
                          key={tab.mode}
                          type="button"
                          role="tab"
                          aria-selected={addSongsMode === tab.mode}
                          onClick={() => setAddSongsMode(tab.mode)}
                          className={cn(
                            "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
                            addSongsMode === tab.mode
                              ? "bg-white text-slate-900 shadow-sm"
                              : "text-slate-600 hover:text-slate-900"
                          )}
                        >
                          {tab.icon}
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    {addSongsMode === "library" && (
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <SearchInput
                            value={librarySearch}
                            onChange={setLibrarySearch}
                            placeholder="Search songs"
                          />
                          <SortSelect value={songSort} onChange={setSongSort} />
                        </div>
                        <div className="max-h-[360px] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                          {isPublicTabsLoading && publicTabs.length === 0 ? (
                            <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading songs…
                            </div>
                          ) : filteredLibraryTabs.length === 0 ? (
                            <p className="px-4 py-8 text-center text-sm text-slate-500">
                              {publicTabs.length === 0
                                ? "No songs in the library yet. Add one by link or pasted text, then press Publish on it."
                                : "No matching songs."}
                            </p>
                          ) : (
                            filteredLibraryTabs.map(publicTab => (
                              <div key={publicTab.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50">
                                <button
                                  type="button"
                                  onClick={() => openPublicTabPreview(publicTab)}
                                  className="min-w-0 flex-1 text-left"
                                  title="Preview"
                                >
                                  <div className="truncate text-sm font-semibold text-slate-900">
                                    {cleanTabText(publicTab.setlistTitle)}
                                  </div>
                                  <div className="truncate text-xs text-slate-500">
                                    {describeLibraryTab(publicTab)}
                                  </div>
                                </button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => addPublicTabToSetlist(publicTab)}
                                  className="h-8 flex-shrink-0 px-2.5"
                                >
                                  <Plus className="mr-1 h-4 w-4" />
                                  Add
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}

                    {addSongsMode === "link" && (
                    <div className="space-y-2">
                      <Label htmlFor="song-links" className="text-sm text-slate-600">
                        Paste one or more Ultimate Guitar links, one per line.
                      </Label>
                      <textarea
                        id="song-links"
                        value={linkInput}
                        onChange={e => setLinkInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && !e.shiftKey && pendingLinks.length <= 1) {
                            e.preventDefault()
                            if (!isLoadingLinks && linkInput.trim()) addSongsFromLinks()
                          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            if (!isLoadingLinks) addSongsFromLinks()
                          }
                        }}
                        disabled={isLoadingLinks}
                        rows={pendingLinks.length > 1 ? Math.min(pendingLinks.length + 1, 8) : 2}
                        placeholder={"https://tabs.ultimate-guitar.com/tab/...\nPaste several links to add a whole setlist"}
                        className="w-full resize-y rounded-md border border-input bg-white px-3 py-2 text-sm leading-6 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
                      />
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-slate-500">
                          {isLoadingLinks && loadingProgress
                            ? `Loading ${Math.min(loadingProgress.done + 1, loadingProgress.total)} of ${loadingProgress.total}…`
                            : pendingLinks.length > 1
                            ? `${pendingLinks.length} links ready`
                            : "Enter to add · Shift+Enter for a new line"}
                        </span>
                        <Button
                          onClick={addSongsFromLinks}
                          disabled={isLoadingLinks || pendingLinks.length === 0}
                          className="min-w-[132px]"
                        >
                          {isLoadingLinks ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Loading
                            </>
                          ) : (
                            <>
                              <Plus className="mr-2 h-4 w-4" />
                              {pendingLinks.length > 1 ? `Add ${pendingLinks.length} songs` : "Add song"}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                    )}

                    {addSongsMode === "paste" && (
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm text-slate-500">
                            Start with optional <code className="rounded bg-slate-100 px-1">Title:</code>,{" "}
                            <code className="rounded bg-slate-100 px-1">Artist:</code>,{" "}
                            <code className="rounded bg-slate-100 px-1">Key:</code>,{" "}
                            <code className="rounded bg-slate-100 px-1">Capo:</code> lines, then chords and lyrics.
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setIsFocusMode(true)}
                            className="flex-shrink-0"
                            title="Edit with a large editor and preview side by side"
                          >
                            <Maximize2 className="mr-1.5 h-4 w-4" />
                            Focus mode
                          </Button>
                        </div>
                        {renderPasteTextarea("pasted-tab-text", "min-h-[280px]")}
                        {pastedTabError && <p className="text-sm text-red-600">{pastedTabError}</p>}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="text-sm text-slate-500">
                            {editingSongId
                              ? "Preview updates as you type."
                              : "The draft shows in the preview until you add it."}
                          </span>
                          {pasteActions}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="shadow-sm">
                  <CardHeader className="space-y-3 pb-4">
                    <div className="flex items-center gap-2">
                      <List className="h-5 w-5 flex-shrink-0 text-primary" />
                      <Input
                        value={setlistName}
                        onChange={e => setSetlistName(e.target.value)}
                        placeholder="Untitled setlist"
                        aria-label="Setlist name"
                        className="h-10 border-transparent bg-transparent px-2 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => saveSetlist()}
                        disabled={songs.length === 0 || isSavingSetlist}
                      >
                        {isSavingSetlist ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        {activeSavedSetlist ? "Save" : "Save setlist"}
                      </Button>
                      {activeSavedSetlist && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveSetlist(true)}
                          disabled={songs.length === 0 || isSavingSetlist}
                        >
                          Save as new
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={startNewSetlist}
                        disabled={songs.length === 0 && !setlistName}
                      >
                        <FilePlus2 className="mr-2 h-4 w-4" />
                        New
                      </Button>
                      {setlistStatus && (
                        <span
                          className={cn(
                            "ml-auto text-sm",
                            hasUnsavedChanges ? "text-amber-700" : "text-slate-500"
                          )}
                        >
                          {setlistStatus}
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {songs.length === 0 ? (
                      <div className="rounded-lg border-2 border-dashed border-slate-200 px-6 py-10 text-center">
                        <Music2 className="mx-auto h-10 w-10 text-slate-300" />
                        <p className="mt-3 font-medium text-slate-700">No songs yet</p>
                        <p className="mt-1 text-sm text-slate-500">
                          Add songs above, or open one of the{" "}
                          <button
                            type="button"
                            onClick={() => setView("saved")}
                            className="font-medium text-primary hover:underline"
                          >
                            saved setlists
                          </button>
                          .
                        </p>
                      </div>
                    ) : (
                      <ol className="space-y-2">
                        {songs.length > 1 && (
                          <p className="text-sm text-slate-500">Drag songs to reorder them.</p>
                        )}
                        {songs.map((songData, index) => (
                          <li
                            key={songData.id}
                            draggable
                            onDragStart={e => {
                              setDragIndex(index)
                              e.dataTransfer.effectAllowed = "move"
                              e.dataTransfer.setData("text/plain", String(index))
                            }}
                            onDragOver={e => {
                              if (dragIndex === null) return
                              e.preventDefault()
                              e.dataTransfer.dropEffect = "move"
                              if (dragOverIndex !== index) setDragOverIndex(index)
                            }}
                            onDrop={e => {
                              e.preventDefault()
                              if (dragIndex !== null) moveSongTo(dragIndex, index)
                              setDragIndex(null)
                              setDragOverIndex(null)
                            }}
                            onDragEnd={() => {
                              setDragIndex(null)
                              setDragOverIndex(null)
                            }}
                            className={cn(
                              "rounded-lg border bg-white p-3 transition-colors",
                              editingSongId === songData.id
                                ? "border-primary ring-1 ring-primary"
                                : "border-slate-200 hover:border-slate-300",
                              dragIndex === index && "opacity-40",
                              dragOverIndex === index &&
                                dragIndex !== null &&
                                dragIndex !== index &&
                                (dragIndex < index
                                  ? "shadow-[0_3px_0_0_hsl(var(--primary))]"
                                  : "shadow-[0_-3px_0_0_hsl(var(--primary))]")
                            )}
                          >
                            <div className="flex items-start gap-2">
                              <span
                                className="mt-1 hidden flex-shrink-0 cursor-grab text-slate-400 active:cursor-grabbing sm:block"
                                title="Drag to reorder"
                                aria-hidden
                              >
                                <GripVertical className="h-5 w-5" />
                              </span>
                              <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold tabular-nums text-slate-600">
                                {index + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-base font-semibold leading-tight text-slate-900">
                                  {songData.song}
                                </div>
                                <div className="truncate text-sm text-slate-500">
                                  {songData.artist}
                                </div>
                              </div>
                              <div className="flex flex-shrink-0 items-center">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => moveSong(index, -1)}
                                  disabled={index === 0}
                                  className="h-8 w-8"
                                  title="Move up"
                                >
                                  <ChevronUp className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => moveSong(index, 1)}
                                  disabled={index === songs.length - 1}
                                  className="h-8 w-8"
                                  title="Move down"
                                >
                                  <ChevronDown className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>

                            <div className="mt-3 flex flex-wrap items-center gap-2 pl-9 sm:pl-16">
                              <div className="flex items-center rounded-md border border-slate-200">
                                <button
                                  type="button"
                                  onClick={() => updateTranspose(songData.id, songData.transposeStep - 1)}
                                  disabled={songData.transposeStep <= -12}
                                  className="flex h-8 w-8 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                  title="Transpose down a half step"
                                >
                                  <Minus className="h-3.5 w-3.5" />
                                </button>
                                <span
                                  className={cn(
                                    "w-20 text-center text-sm tabular-nums",
                                    songData.transposeStep === 0
                                      ? "text-slate-500"
                                      : "font-semibold text-primary"
                                  )}
                                  title="Transpose (half steps)"
                                >
                                  {songData.transposeStep === 0
                                    ? "Original"
                                    : songData.transposeStep > 0
                                    ? `+${songData.transposeStep}`
                                    : songData.transposeStep}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => updateTranspose(songData.id, songData.transposeStep + 1)}
                                  disabled={songData.transposeStep >= 12}
                                  className="flex h-8 w-8 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                  title="Transpose up a half step"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              </div>

                              <div className="ml-auto flex items-center gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => startEditingSong(songData)}
                                  className="h-8 px-2.5 text-slate-600"
                                >
                                  <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openPublishSongDialog(songData)}
                                  className="h-8 px-2.5 text-slate-600"
                                >
                                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                                  Publish
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => removeSong(songData.id)}
                                  className="h-8 w-8 text-red-500 hover:bg-red-50 hover:text-red-700"
                                  title="Remove from setlist"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </CardContent>
                </Card>

                <Card className="shadow-sm">
                  <SectionHeading
                    icon={<SlidersHorizontal className="h-5 w-5" />}
                    title="Layout & export"
                  />
                  <CardContent className="space-y-5">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="font-size-slider" className="text-sm font-medium">
                          Font size
                        </Label>
                        <span className="text-sm tabular-nums text-slate-600">{fontSize}pt</span>
                      </div>
                      <Slider
                        id="font-size-slider"
                        min={6}
                        max={20}
                        step={0.5}
                        value={[fontSize]}
                        onValueChange={value => setFontSize(value[0])}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="mono-font-select" className="text-sm font-medium">
                        Monospace font
                      </Label>
                      <select
                        id="mono-font-select"
                        value={monoFont}
                        onChange={e => setMonoFont(e.target.value as MonoFontOption)}
                        className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm"
                        style={{ fontFamily: getBrowserFontStack(monoFont) }}
                      >
                        {monoFontOptions.map(fontOption => (
                          <option key={fontOption.value} value={fontOption.value}>
                            {fontOption.label} ({fontOption.exportHint})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="auto-linebreak"
                        checked={autoLinebreak}
                        onCheckedChange={checked => setAutoLinebreak(checked === true)}
                        className="mt-0.5"
                      />
                      <Label htmlFor="auto-linebreak" className="cursor-pointer text-sm font-medium">
                        Keep sections together
                        <span className="mt-0.5 block font-normal text-slate-500">
                          Avoid splitting a paragraph across pages
                        </span>
                      </Label>
                    </div>

                    <p className="text-sm text-slate-500">
                      Tip: use <code className="rounded bg-slate-100 px-1">*bold*</code> and{" "}
                      <code className="rounded bg-slate-100 px-1">_underline_</code> in tab text and notes.
                    </p>

                    <Separator />

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Button onClick={handleDownloadPDF} disabled={!pdfUrl}>
                        <FileDown className="mr-2 h-4 w-4" />
                        Download PDF
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setIsAdvancedExportOpen(prev => !prev)}
                        className="justify-between"
                      >
                        More export options
                        {isAdvancedExportOpen ? (
                          <ChevronUp className="ml-2 h-4 w-4" />
                        ) : (
                          <ChevronDown className="ml-2 h-4 w-4" />
                        )}
                      </Button>
                    </div>

                    {isAdvancedExportOpen && (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <Button
                          onClick={handleDownloadDocx}
                          disabled={songs.length === 0}
                          variant="outline"
                          className="w-full bg-white"
                        >
                          <FileType className="mr-2 h-4 w-4" />
                          Download Word doc (.docx)
                        </Button>
                        <p className="text-center text-sm text-slate-500">
                          Upload to Google Docs to keep formatting
                        </p>
                        <Button
                          onClick={handleCopyToClipboard}
                          disabled={songs.length === 0}
                          variant="outline"
                          className="w-full bg-white"
                        >
                          {copySuccess ? (
                            <>
                              <Check className="mr-2 h-4 w-4" />
                              Copied!
                            </>
                          ) : (
                            <>
                              <Copy className="mr-2 h-4 w-4" />
                              Copy as plain text
                            </>
                          )}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="shadow-sm">
                  <SectionHeading
                    icon={<StickyNote className="h-5 w-5" />}
                    title="Note boxes"
                    description="Place text boxes on specific PDF pages."
                    action={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setIsNotesPanelOpen(prev => !prev)}
                        className="h-8 w-8"
                        aria-expanded={isNotesPanelOpen}
                        aria-label="Toggle note boxes"
                      >
                        {isNotesPanelOpen ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    }
                  />
                  {isNotesPanelOpen && (
                    <CardContent>
                      <fieldset
                        disabled={!canEditNotes}
                        className={cn("space-y-4", !canEditNotes && "opacity-60")}
                      >
                        {!canEditNotes && (
                          <p className="text-sm text-slate-500">
                            Add a song first — notes are positioned on the PDF.
                          </p>
                        )}

                        <div className="flex items-center gap-2">
                          <Label htmlFor="note-page" className="text-sm">
                            Page
                          </Label>
                          <Input
                            id="note-page"
                            type="number"
                            min={1}
                            value={previewNotePage}
                            onChange={e =>
                              setPreviewNotePage(
                                Math.max(1, Number.parseInt(e.target.value || "1", 10))
                              )
                            }
                            className="h-9 w-20"
                          />
                          <Button type="button" variant="outline" size="sm" onClick={addNoteBox} className="ml-auto">
                            <Plus className="mr-1.5 h-4 w-4" />
                            Add note box
                          </Button>
                        </div>

                        {noteBoxes.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {noteBoxes.map((noteBox, noteIndex) => (
                              <button
                                key={noteBox.id}
                                type="button"
                                onClick={() => {
                                  setSelectedNoteId(prev => (prev === noteBox.id ? null : noteBox.id))
                                  setPreviewNotePage(noteBox.page)
                                }}
                                className={cn(
                                  "rounded-md border px-3 py-1.5 text-sm",
                                  selectedNoteId === noteBox.id
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-slate-200 bg-white hover:border-slate-300"
                                )}
                              >
                                Note {noteIndex + 1} · p.{noteBox.page}
                              </button>
                            ))}
                          </div>
                        )}

                        {selectedNoteBox && (
                          <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-semibold">Selected note</span>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={removeSelectedNoteBox}
                                className="h-8 text-red-600 hover:text-red-700"
                              >
                                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                Remove
                              </Button>
                            </div>

                            <textarea
                              value={selectedNoteBox.text}
                              onChange={e =>
                                updateSelectedNoteBox(noteBox => ({
                                  ...noteBox,
                                  text: e.target.value,
                                }))
                              }
                              placeholder="Note text — *bold* and _underline_ work here."
                              className="min-h-[96px] w-full rounded-md border border-input bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              style={{ fontFamily: getBrowserFontStack(monoFont) }}
                            />

                            <div className="flex items-center justify-between gap-2">
                              <Label className="text-sm">Page</Label>
                              <Input
                                type="number"
                                min={1}
                                value={selectedNoteBox.page}
                                onChange={e =>
                                  updateSelectedNoteBox(noteBox => ({
                                    ...noteBox,
                                    page: Math.max(1, Number.parseInt(e.target.value || "1", 10)),
                                  }))
                                }
                                className="h-8 w-20 text-right"
                              />
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                              <NoteBoxField
                                label="X position"
                                value={selectedNoteBox.x}
                                min={0}
                                fallback={0.62}
                                onChange={x => updateSelectedNoteBox(noteBox => ({ ...noteBox, x }))}
                              />
                              <NoteBoxField
                                label="Y position"
                                value={selectedNoteBox.y}
                                min={0}
                                fallback={0.08}
                                onChange={y => updateSelectedNoteBox(noteBox => ({ ...noteBox, y }))}
                              />
                              <NoteBoxField
                                label="Width"
                                value={selectedNoteBox.width}
                                min={MIN_NOTE_BOX_DIMENSION}
                                fallback={0.24}
                                onChange={width => updateSelectedNoteBox(noteBox => ({ ...noteBox, width }))}
                              />
                              <NoteBoxField
                                label="Height"
                                value={selectedNoteBox.height}
                                min={MIN_NOTE_BOX_DIMENSION}
                                fallback={0.18}
                                onChange={height => updateSelectedNoteBox(noteBox => ({ ...noteBox, height }))}
                              />
                            </div>
                          </div>
                        )}
                      </fieldset>
                    </CardContent>
                  )}
                </Card>
              </div>

              <div className="lg:col-span-7">
                <Card className="overflow-hidden shadow-sm lg:sticky lg:top-24">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="h-5 w-5 flex-shrink-0 text-primary" />
                      <span className="truncate font-semibold">
                        {setlistName.trim() || "PDF preview"}
                      </span>
                      {previewSongs.length > 0 && (
                        <span className="flex-shrink-0 text-sm text-slate-500">
                          · {pluralize(previewSongs.length, "song")}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsFullScreen(true)}
                      disabled={!pdfUrl}
                      title="Open fullscreen with autoscroll (F)"
                    >
                      <Maximize className="mr-1.5 h-4 w-4" />
                      Fullscreen
                    </Button>
                  </div>
                  {pdfUrl ? (
                    <iframe
                      src={pdfUrl}
                      className="block h-[75vh] w-full bg-slate-200 lg:h-[calc(100vh-10.5rem)]"
                      title="PDF Preview"
                    />
                  ) : (
                    <div className="flex h-[50vh] flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center text-slate-500 lg:h-[calc(100vh-10.5rem)]">
                      {previewSongs.length > 0 ? (
                        <>
                          <Loader2 className="h-8 w-8 animate-spin" />
                          Generating PDF preview…
                        </>
                      ) : (
                        <>
                          <FileText className="h-12 w-12 text-slate-300" />
                          <p className="text-base font-medium text-slate-600">Your PDF will appear here</p>
                          <p className="max-w-sm text-sm">
                            Add songs from Ultimate Guitar or paste tab text. Each song can be transposed on its
                            own, and everything is combined into one PDF.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          )}

          {view === "saved" && (
            <Card className="shadow-sm">
              <SectionHeading
                icon={<FolderOpen className="h-5 w-5" />}
                title="Setlists"
                description="Shared with everyone. Open one to edit it, or add its songs to your current setlist."
                action={
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadSetlists}
                      disabled={isSetlistsLoading}
                      title="Refresh setlists"
                    >
                      <RefreshCw className={cn("h-4 w-4", isSetlistsLoading && "animate-spin")} />
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => saveSetlist()}
                      disabled={songs.length === 0 || isSavingSetlist}
                      title={songs.length === 0 ? "Add songs in the editor first" : undefined}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      Save current
                    </Button>
                  </div>
                }
              />
              <CardContent className="space-y-4">
                {localOnlySetlists.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <span className="flex-1">
                      {pluralize(localOnlySetlists.length, "setlist")} saved earlier only in this browser (
                      {localOnlySetlists.map(setlist => setlist.name).join(", ")}). Upload{" "}
                      {localOnlySetlists.length === 1 ? "it" : "them"} so everyone can see{" "}
                      {localOnlySetlists.length === 1 ? "it" : "them"}.
                    </span>
                    <Button size="sm" onClick={uploadLocalSetlists} disabled={isUploadingLocal}>
                      {isUploadingLocal ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="mr-2 h-4 w-4" />
                      )}
                      Upload
                    </Button>
                  </div>
                )}

                <PasswordField value={editPassword} onChange={setEditPassword} status={passwordStatus} />

                <div className="flex gap-2">
                  <SearchInput
                    value={savedSetlistSearch}
                    onChange={setSavedSetlistSearch}
                    placeholder="Search setlists or songs"
                  />
                  <SortSelect value={setlistSort} onChange={setSetlistSort} />
                </div>

                <div className="max-h-[calc(100vh-20rem)] min-h-[240px] space-y-2 overflow-y-auto pr-1">
                  {!hasLoadedSetlists && isSetlistsLoading ? (
                    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading setlists…
                    </div>
                  ) : savedSetlists.length === 0 ? (
                    <div className="rounded-lg border-2 border-dashed border-slate-200 px-6 py-12 text-center">
                      <FolderOpen className="mx-auto h-10 w-10 text-slate-300" />
                      <p className="mt-3 font-medium text-slate-700">No setlists yet</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Build a setlist in the editor and press <strong>Save setlist</strong>.
                      </p>
                    </div>
                  ) : filteredSavedSetlists.length === 0 ? (
                    <p className="py-6 text-center text-sm text-slate-500">No matching setlists.</p>
                  ) : (
                    filteredSavedSetlists.map(saved => (
                      <div
                        key={saved.id}
                        className={cn(
                          "flex flex-col gap-3 rounded-lg border bg-white p-4 sm:flex-row sm:items-center",
                          saved.id === activeSavedSetlistId
                            ? "border-primary/60 ring-1 ring-primary/30"
                            : "border-slate-200"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => openSavedSetlist(saved)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span className="truncate text-base font-semibold text-slate-900">
                              {saved.name}
                            </span>
                            {saved.id === activeSavedSetlistId && (
                              <span className="flex-shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                Open
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-sm text-slate-500">
                            {pluralize(saved.songs.length, "song")} · added{" "}
                            {new Date(saved.createdAt).toLocaleDateString()}
                            {saved.updatedAt !== saved.createdAt &&
                              ` · updated ${formatRelativeTime(saved.updatedAt)}`}
                          </div>
                          <div className="mt-1 truncate text-sm text-slate-600">
                            {saved.songs.map(song => song.song).join(" · ")}
                          </div>
                        </button>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          <Button size="sm" onClick={() => openSavedSetlist(saved)}>
                            <FolderOpen className="mr-1.5 h-4 w-4" />
                            Open
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => appendSavedSetlist(saved)}
                            title="Add these songs to the end of your current setlist"
                          >
                            <ListPlus className="mr-1.5 h-4 w-4" />
                            Add songs
                          </Button>
                          {canEdit && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => deleteSavedSetlist(saved)}
                              disabled={deletingSetlistId === saved.id}
                              className="h-9 w-9 text-red-500 hover:bg-red-50 hover:text-red-700"
                              title="Delete setlist"
                            >
                              {deletingSetlistId === saved.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {view === "published" && (
            <Card className="shadow-sm">
              <SectionHeading
                icon={<Globe className="h-5 w-5" />}
                title="Songs"
                description={
                  publicTabs.length > 0
                    ? `${pluralize(publicTabs.length, "song")} in the shared library. Publish a song from your setlist to add it here.`
                    : "The shared song library. Publish a song from your setlist to add it here."
                }
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadPublicTabs}
                    disabled={isPublicTabsLoading}
                    title="Refresh songs"
                  >
                    <RefreshCw className={cn("h-4 w-4", isPublicTabsLoading && "animate-spin")} />
                  </Button>
                }
              />
              <CardContent className="space-y-4">
                <PasswordField value={editPassword} onChange={setEditPassword} status={passwordStatus} />

                <div className="flex gap-2">
                  <SearchInput
                    value={publicTabsSearch}
                    onChange={setPublicTabsSearch}
                    placeholder="Search by song, artist, or publisher"
                  />
                  <SortSelect value={songSort} onChange={setSongSort} />
                </div>

                <div className="max-h-[calc(100vh-20rem)] min-h-[420px] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                  {isPublicTabsLoading && publicTabs.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading songs…
                    </div>
                  ) : publicTabs.length === 0 ? (
                    <p className="py-12 text-center text-sm text-slate-500">
                      No songs yet. Add a song in the editor and press Publish on it.
                    </p>
                  ) : filteredPublicTabs.length === 0 ? (
                    <p className="py-12 text-center text-sm text-slate-500">No matching songs.</p>
                  ) : (
                    filteredPublicTabs.map(publicTab => (
                      <div
                        key={publicTab.id}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50"
                      >
                        <button
                          type="button"
                          onClick={() => openPublicTabPreview(publicTab)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate text-[15px] font-semibold text-slate-900">
                            {cleanTabText(publicTab.setlistTitle)}
                          </div>
                          <div className="truncate text-sm text-slate-500">
                            {describeLibraryTab(publicTab)}
                          </div>
                        </button>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openPublicTabPreview(publicTab)}
                            className="h-8 px-2.5"
                          >
                            <Eye className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">Preview</span>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => addPublicTabToSetlist(publicTab)}
                            className="h-8 px-2.5"
                          >
                            <Plus className="h-4 w-4 sm:mr-1.5" />
                            <span className="hidden sm:inline">Add</span>
                          </Button>
                          {canEdit && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openSongEditor(publicTab)}
                                className="h-8 w-8 text-slate-600"
                                title="Edit song"
                              >
                                <Edit3 className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => deletePublicTab(publicTab)}
                                disabled={deletingTabId === publicTab.id}
                                className="h-8 w-8 text-red-500 hover:bg-red-50 hover:text-red-700"
                                title="Delete song"
                              >
                                {deletingTabId === publicTab.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <Dialog
        open={isPublishSongDialogOpen}
        onOpenChange={open => {
          setIsPublishSongDialogOpen(open)
          if (!open) {
            setSongToPublish(null)
          }
        }}
      >
        <DialogContent className="flex items-center justify-center bg-transparent p-4">
          <Card className="w-full max-w-lg shadow-xl">
            <SectionHeading
              icon={<Upload className="h-5 w-5" />}
              title="Publish song"
              description="Add this song to the shared library so anyone can use it in a setlist."
            />
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="publish-song-title">Song name</Label>
                <Input
                  id="publish-song-title"
                  value={publishSongTitle}
                  onChange={event => setPublishSongTitle(event.target.value)}
                  placeholder="Song name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="publish-song-author">Author (optional)</Label>
                <Input
                  id="publish-song-author"
                  value={publishSongAuthor}
                  onChange={event => setPublishSongAuthor(event.target.value)}
                  placeholder="Author name"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => setIsPublishSongDialogOpen(false)}
                  disabled={isPublishingSong}
                >
                  Cancel
                </Button>
                <Button
                  onClick={publishSingleSong}
                  disabled={!publishSongTitle.trim() || isPublishingSong}
                >
                  {isPublishingSong ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Publishing
                    </>
                  ) : (
                    <>
                      <Upload className="mr-2 h-4 w-4" />
                      Publish song
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </DialogContent>
      </Dialog>

      <Dialog
        open={previewPublicTab !== null}
        onOpenChange={open => {
          if (!open) {
            setPublicSongSearch("")
            setPreviewPublicTab(null)
          }
        }}
      >
        <DialogContent className="flex items-start justify-center overflow-y-auto bg-transparent p-4 sm:p-8">
          <Card className="w-full max-w-4xl shadow-xl">
            <CardHeader className="sticky top-0 z-10 rounded-t-lg border-b border-slate-200 bg-white pb-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-xl font-semibold">
                    {previewPublicTab?.setlistTitle || "Published tab"}
                  </CardTitle>
                  <CardDescription className="mt-1.5 text-sm">
                    {previewPublicTab
                      ? `${previewPublicTab.publisherName} · ${pluralize(previewPublicTab.songs.length, "song")} · ${new Date(previewPublicTab.publishedAt).toLocaleString()}`
                      : ""}
                  </CardDescription>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!previewPublicTab) return
                      addPublicTabToSetlist(previewPublicTab)
                    }}
                  >
                    <Plus className="mr-1.5 h-4 w-4" />
                    Add to setlist
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setPreviewPublicTab(null)}
                    className="h-9 w-9"
                    aria-label="Close"
                  >
                    <X className="h-5 w-5" />
                  </Button>
                </div>
              </div>
              {previewPublicTab && previewPublicTab.songs.length > 1 && (
                <div className="relative pt-3">
                  <Search className="pointer-events-none absolute left-3 top-1/2 mt-1.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={publicSongSearch}
                    onChange={e => setPublicSongSearch(e.target.value)}
                    placeholder="Search songs in this tab"
                    className="pl-9"
                  />
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              {filteredPreviewSongs.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">No songs match your search.</p>
              ) : (
                filteredPreviewSongs.map((song, index) => (
                  <section
                    key={`${previewPublicTab?.id || "preview"}-${index}`}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-4"
                  >
                    <h4 className="text-base font-semibold">
                      {cleanTabText(song.song)}{" "}
                      <span className="font-normal text-slate-500">· {cleanTabText(song.artist)}</span>
                    </h4>
                    <pre
                      className="mt-3 overflow-x-auto whitespace-pre text-sm leading-6 text-slate-800"
                      style={{ fontFamily: getBrowserFontStack(previewPublicTab?.exportSettings?.monoFont || monoFont) }}
                    >
                      {renderChordText(song.transposedChords)}
                    </pre>
                  </section>
                ))
              )}
              {previewPublicTab && canEdit && (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => openSongEditor(previewPublicTab)}>
                    <Edit3 className="mr-2 h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => deletePublicTab(previewPublicTab)}
                    disabled={deletingTabId === previewPublicTab.id}
                    className="text-red-600 hover:text-red-700"
                  >
                    {deletingTabId === previewPublicTab.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Delete
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </DialogContent>
      </Dialog>

      <Dialog
        open={songEditTarget !== null}
        onOpenChange={open => {
          if (!open && !isSavingSongEdit) setSongEditTarget(null)
        }}
      >
        <DialogContent className="flex items-start justify-center overflow-y-auto bg-transparent p-4 sm:p-8">
          <Card className="w-full max-w-3xl shadow-xl">
            <SectionHeading
              icon={<Edit3 className="h-5 w-5" />}
              title="Edit song"
              description="Changes are saved to the shared library for everyone."
            />
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-1">
                  <Label htmlFor="song-edit-title">Title</Label>
                  <Input
                    id="song-edit-title"
                    value={songEditTitle}
                    onChange={e => setSongEditTitle(e.target.value)}
                  />
                </div>
                {songEditTarget?.songs.length === 1 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="song-edit-artist">Artist</Label>
                    <Input
                      id="song-edit-artist"
                      value={songEditArtist}
                      onChange={e => setSongEditArtist(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="song-edit-publisher">Published by</Label>
                  <Input
                    id="song-edit-publisher"
                    value={songEditPublisher}
                    onChange={e => setSongEditPublisher(e.target.value)}
                    placeholder="Anonymous"
                  />
                </div>
              </div>
              {songEditTarget?.songs.length === 1 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="song-edit-text">Chord sheet</Label>
                  <textarea
                    id="song-edit-text"
                    value={songEditText}
                    onChange={e => setSongEditText(e.target.value)}
                    className="min-h-[360px] w-full rounded-md border border-input bg-white px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    style={{ fontFamily: getBrowserFontStack(monoFont) }}
                  />
                  <p className="text-sm text-slate-500">
                    Chord lines are detected automatically, like pasted tab text.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  This is a mash-up of {songEditTarget?.songs.length} songs, so only its title and
                  publisher can be edited here.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSongEditTarget(null)}
                  disabled={isSavingSongEdit}
                >
                  Cancel
                </Button>
                <Button onClick={saveSongEdit} disabled={isSavingSongEdit || !songEditTitle.trim()}>
                  {isSavingSongEdit ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save changes
                </Button>
              </div>
            </CardContent>
          </Card>
        </DialogContent>
      </Dialog>

      {isFocusMode && (
        <div className="fixed inset-0 z-40 flex flex-col bg-slate-100" role="dialog" aria-label="Focus mode">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold text-slate-900">
                {editingSong ? `Editing "${editingSong.song}"` : parsedPastedSong ? parsedPastedSong.song : "New song"}
              </div>
              <div className="text-sm text-slate-500">
                {editingSong ? editingSong.artist : "Paste or type a chord sheet"} · Esc to exit
              </div>
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 text-sm" role="tablist" aria-label="Preview">
              {(
                [
                  { scope: "song", label: "This song" },
                  { scope: "setlist", label: "Whole setlist" },
                ] as const
              ).map(option => (
                <button
                  key={option.scope}
                  type="button"
                  role="tab"
                  aria-selected={focusPreviewScope === option.scope}
                  onClick={() => setFocusPreviewScope(option.scope)}
                  className={cn(
                    "rounded-md px-3 py-1.5 font-medium transition-colors",
                    focusPreviewScope === option.scope
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <label className="hidden items-center gap-2 text-sm text-slate-600 md:flex">
                Size
                <Slider
                  min={6}
                  max={20}
                  step={0.5}
                  value={[fontSize]}
                  onValueChange={value => setFontSize(value[0])}
                  className="w-24"
                />
                <span className="w-10 tabular-nums">{fontSize}pt</span>
              </label>
              {pasteActions}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsFocusMode(false)}
                title="Exit focus mode (Esc)"
                aria-label="Exit focus mode"
              >
                <Minimize2 className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {pastedTabError && (
            <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700">{pastedTabError}</div>
          )}

          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-4 p-4 lg:grid-cols-2 lg:grid-rows-1 sm:p-6">
            {renderPasteTextarea("focus-tab-text", "h-full min-h-0 resize-none text-[15px] leading-7 shadow-sm")}
            <div className="min-h-0 overflow-hidden rounded-md border border-slate-200 bg-slate-200 shadow-sm">
              {pdfUrl ? (
                <iframe src={pdfUrl} className="block h-full w-full" title="Focus preview" />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                  {pastedTabText.trim() ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      Generating preview…
                    </>
                  ) : (
                    "Start typing to see the preview."
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-slate-200 bg-white px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-1 text-sm text-slate-500 sm:flex-row">
          <p>tabs/chords downloader. Happy 20th, Justin.</p>
          <p>Made with ❤️ by Allen</p>
        </div>
      </footer>

      {pdfUrl && (
        <FullScreenPDFViewer
          pdfUrl={pdfUrl}
          isOpen={isFullScreen}
          onClose={() => setIsFullScreen(false)}
          title={setlistName.trim() || (songs.length === 1 ? songs[0].song : `Setlist (${pluralize(songs.length, "song")})`)}
          subtitle={songs.length === 1 ? songs[0].artist : ""}
        />
      )}
    </div>
  )
}
