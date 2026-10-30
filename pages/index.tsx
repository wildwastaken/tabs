"use client"

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
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
} from "lucide-react"

const MIN_NOTE_BOX_DIMENSION = 0.02
const SAVED_SETLISTS_STORAGE_KEY = "tabs.savedSetlists.v1"
const WORKING_SETLIST_STORAGE_KEY = "tabs.workingSetlist.v1"

// Browser-side fallbacks, used only if our own /api/fetch-tab route fails.
const CLIENT_PROXIES: Array<(url: string) => string> = [
  url => `https://api.codetabs.com/v1/proxy/?quest=${url}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
]

type WorkspaceView = "editor" | "saved" | "published"

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
  songs: SongData[]
  settings: SavedSetlistSettings
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
    artist: song.artist,
    song: song.song,
    chords: song.chords,
    transposedChords: song.chords,
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
    songs: songs.map(({ uri, artist, song, chords, transposeStep }) => [
      uri,
      artist,
      song,
      chords,
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
  const text = input.replace(/\[tab\]|\[\/tab\]/g, "").replace(/\r\n/g, "\n")
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
  const normalizedText = rawText.replace(/\r\n/g, "\n").trim()
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

export default function ChordTransposer() {
  const [view, setView] = useState<WorkspaceView>("editor")

  // Current setlist
  const [songs, setSongs] = useState<SongData[]>([])
  const [setlistName, setSetlistName] = useState("")
  const [activeSavedSetlistId, setActiveSavedSetlistId] = useState<string | null>(null)
  const [savedSetlists, setSavedSetlists] = useState<SavedSetlist[]>([])
  const [savedSetlistSearch, setSavedSetlistSearch] = useState("")
  const [hasHydrated, setHasHydrated] = useState(false)

  // Adding songs
  const [linkInput, setLinkInput] = useState("")
  const [loadingProgress, setLoadingProgress] = useState<{ done: number; total: number } | null>(null)
  const [pastedTabText, setPastedTabText] = useState("")
  const [isPasteOpen, setIsPasteOpen] = useState(false)
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
  const [isPublishing, setIsPublishing] = useState(false)
  const [isPublishingSong, setIsPublishingSong] = useState(false)
  const [publisherName, setPublisherName] = useState("")
  const [publishTitle, setPublishTitle] = useState("")
  const [isPublishSongDialogOpen, setIsPublishSongDialogOpen] = useState(false)
  const [songToPublish, setSongToPublish] = useState<SongData | null>(null)
  const [publishSongTitle, setPublishSongTitle] = useState("")
  const [publishSongAuthor, setPublishSongAuthor] = useState("")
  const [previewPublicTab, setPreviewPublicTab] = useState<PublicTabEntry | null>(null)
  const [publicTabsSearch, setPublicTabsSearch] = useState("")
  const [publicSongSearch, setPublicSongSearch] = useState("")
  const [deletePassword, setDeletePassword] = useState("")
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

  useEffect(() => {
    const storedSetlists = readStorage<SavedSetlist[]>(SAVED_SETLISTS_STORAGE_KEY)
    if (Array.isArray(storedSetlists)) setSavedSetlists(storedSetlists)

    const working = readStorage<WorkingSetlist>(WORKING_SETLIST_STORAGE_KEY)
    if (working && Array.isArray(working.songs)) {
      setSongs(
        working.songs.map(song => ({ ...song, transposedChords: song.chords }))
      )
      setSetlistName(working.name || "")
      setActiveSavedSetlistId(working.savedSetlistId || null)
      if (working.settings) {
        setFontSize(working.settings.fontSize ?? 10)
        setAutoLinebreak(Boolean(working.settings.autoLinebreak))
        setMonoFont(working.settings.monoFont || "roboto-mono")
        setNoteBoxes(Array.isArray(working.settings.noteBoxes) ? working.settings.noteBoxes : [])
      }
    }

    setHasHydrated(true)
  }, [])

  useEffect(() => {
    if (!hasHydrated) return
    const working: WorkingSetlist = {
      name: setlistName,
      savedSetlistId: activeSavedSetlistId,
      songs,
      settings: currentSettings,
    }
    writeStorage(WORKING_SETLIST_STORAGE_KEY, working)
  }, [hasHydrated, setlistName, activeSavedSetlistId, songs, currentSettings])

  const persistSavedSetlists = useCallback((next: SavedSetlist[]) => {
    setSavedSetlists(next)
    writeStorage(SAVED_SETLISTS_STORAGE_KEY, next)
  }, [])

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
    (asNew = false) => {
      if (songs.length === 0) {
        setError("Add at least one song before saving a setlist.")
        return
      }

      const now = new Date().toISOString()
      const name = setlistName.trim() || `Setlist ${new Date().toLocaleDateString()}`
      const existing = asNew ? null : activeSavedSetlist
      const entry: SavedSetlist = {
        id: existing?.id || createId(),
        name,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        songs: songs.map(({ uri, artist, song, chords, transposeStep }) => ({
          uri,
          artist,
          song,
          chords,
          transposeStep,
        })),
        settings: currentSettings,
      }

      persistSavedSetlists(
        existing
          ? savedSetlists.map(setlist => (setlist.id === existing.id ? entry : setlist))
          : [entry, ...savedSetlists]
      )
      setSetlistName(name)
      setActiveSavedSetlistId(entry.id)
      showNotice(existing ? `Updated "${name}"` : `Saved "${name}"`)
    },
    [songs, setlistName, activeSavedSetlist, currentSettings, savedSetlists, persistSavedSetlists, showNotice]
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
    (saved: SavedSetlist) => {
      if (!window.confirm(`Delete saved setlist "${saved.name}"? This can't be undone.`)) return
      persistSavedSetlists(savedSetlists.filter(setlist => setlist.id !== saved.id))
      if (activeSavedSetlistId === saved.id) setActiveSavedSetlistId(null)
      showNotice(`Deleted "${saved.name}"`)
    },
    [savedSetlists, activeSavedSetlistId, persistSavedSetlists, showNotice]
  )

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
    const sorted = [...savedSetlists].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (!query) return sorted
    return sorted.filter(setlist =>
      `${setlist.name} ${setlist.songs.map(song => `${song.song} ${song.artist}`).join(" ")}`
        .toLowerCase()
        .includes(query)
    )
  }, [savedSetlists, savedSetlistSearch])

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
        }${lastFailureReason ? `(${lastFailureReason}) ` : ""}Check the link${failed.length === 1 ? "" : "s"} left in the box, or paste the tab text instead.`
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

  const filteredPublicTabs = useMemo(() => {
    const query = publicTabsSearch.trim().toLowerCase()
    if (!query) return publicTabs

    return publicTabs.filter(tab => {
      const songMetadata = tab.songs
        .map(song => `${song.song} ${song.artist}`)
        .join(" ")
      const searchableText = `${tab.setlistTitle} ${tab.publisherName} ${songMetadata}`.toLowerCase()
      return searchableText.includes(query)
    })
  }, [publicTabs, publicTabsSearch])

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
        throw new Error("Failed to load public tabs")
      }

      const data = (await res.json()) as PublicTabsResponse
      setPublicTabs(Array.isArray(data.tabs) ? data.tabs : [])
    } catch (err) {
      console.error("Failed to fetch public tabs:", err)
      setError("Failed to load public tabs. Try refreshing.")
    } finally {
      setIsPublicTabsLoading(false)
    }
  }, [])

  const defaultPublishTitle =
    setlistName.trim() ||
    (songs.length === 1
      ? `${songs[0].artist} - ${songs[0].song}`
      : `Setlist (${pluralize(songs.length, "song")})`)

  const publishCurrentSetlist = useCallback(async () => {
    if (songs.length === 0) {
      setError("Add at least one song before publishing.")
      return
    }

    setIsPublishing(true)
    setError(null)

    try {
      const res = await fetch("/api/public-tabs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          publisherName,
          setlistTitle: publishTitle.trim() || defaultPublishTitle,
          notes: "",
          exportSettings: {
            monoFont,
            noteBoxes,
          },
          songs: songs.map(song => ({
            artist: song.artist,
            song: song.song,
            transposedChords: song.transposedChords,
            transposeStep: song.transposeStep,
          })),
        }),
      })

      if (!res.ok) {
        const responseBody = (await res.json()) as { error?: string }
        throw new Error(responseBody.error || "Failed to publish setlist")
      }

      showNotice("Published to Public Tabs.")
      await loadPublicTabs()
    } catch (err) {
      console.error("Failed to publish setlist:", err)
      setError(
        err instanceof Error
          ? err.message
          : "Failed to publish setlist. Please try again."
      )
    } finally {
      setIsPublishing(false)
    }
  }, [
    songs,
    publisherName,
    publishTitle,
    defaultPublishTitle,
    monoFont,
    noteBoxes,
    loadPublicTabs,
    showNotice,
  ])

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
        artist: song.artist,
        song: song.song,
        chords: song.transposedChords,
        transposedChords: song.transposedChords,
        transposeStep: 0,
      }))

      setSongs(prev => [...prev, ...importedSongs])
      showNotice(`Added ${pluralize(importedSongs.length, "song")} to your setlist`)
    },
    [showNotice]
  )

  const openPublicTabPreview = useCallback((publicTab: PublicTabEntry) => {
    setPublicSongSearch("")
    setPreviewPublicTab(publicTab)
  }, [])

  const deletePublicTab = useCallback(
    async (publicTab: PublicTabEntry) => {
      if (!deletePassword.trim()) {
        setError("Enter the delete password before deleting tabs.")
        return
      }

      if (!window.confirm(`Delete "${publicTab.setlistTitle}" from public tabs?`)) {
        return
      }

      setDeletingTabId(publicTab.id)
      setError(null)

      try {
        const response = await fetch("/api/public-tabs", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: publicTab.id,
            password: deletePassword.trim(),
          }),
        })

        if (!response.ok) {
          const body = (await response.json()) as { error?: string }
          throw new Error(body.error || "Failed to delete published tab")
        }

        setPublicTabs(prev => prev.filter(tab => tab.id !== publicTab.id))
        if (previewPublicTab?.id === publicTab.id) {
          setPreviewPublicTab(null)
        }
        showNotice(`Deleted "${publicTab.setlistTitle}"`)
      } catch (err) {
        console.error("Failed deleting public tab:", err)
        setError(
          err instanceof Error ? err.message : "Failed to delete published tab."
        )
      } finally {
        setDeletingTabId(null)
      }
    },
    [deletePassword, previewPublicTab, showNotice]
  )

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
    setIsPasteOpen(true)
    setError(null)
    setView("editor")
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const cancelEditingSong = useCallback(() => {
    setEditingSongId(null)
    setPastedTabText("")
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

  // Generate PDF
  useEffect(() => {
    const updatePDF = async () => {
      if (previewSongs.length === 0) {
        setPdfUrl(null)
        return
      }

      try {
        const { dataUrl } = await generatePDF(
          previewSongs,
          fontSize,
          autoLinebreak,
          currentExportSettings
        )
        setPdfUrl(dataUrl)
      } catch (err) {
        console.error("Failed to generate PDF:", err)
        setError("Failed to generate PDF preview")
      }
    }

    updatePDF()
  }, [previewSongs, fontSize, autoLinebreak, currentExportSettings])

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
    { value: "saved", label: "My Setlists", count: savedSetlists.length || undefined },
    { value: "published", label: "Public Tabs" },
  ]

  const setlistStatus = activeSavedSetlist
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
                    description="Paste one or more Ultimate Guitar links (one per line), or paste tab text."
                  />
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="song-links" className="flex items-center gap-2 text-sm font-medium">
                        <LinkIcon className="h-4 w-4 text-slate-500" />
                        Ultimate Guitar links
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

                    <Separator />

                    <div>
                      <button
                        type="button"
                        onClick={() => setIsPasteOpen(prev => !prev)}
                        className="flex w-full items-center justify-between rounded-md py-1 text-left text-sm font-medium text-slate-700 hover:text-slate-900"
                        aria-expanded={isPasteOpen || Boolean(editingSongId)}
                      >
                        <span className="flex items-center gap-2">
                          <ClipboardPaste className="h-4 w-4 text-slate-500" />
                          {editingSongId ? "Editing song text" : "Paste tab text instead"}
                        </span>
                        {isPasteOpen || editingSongId ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>

                      {(isPasteOpen || editingSongId) && (
                        <div className="mt-3 space-y-3">
                          <p className="text-sm text-slate-500">
                            Start with optional <code className="rounded bg-slate-100 px-1">Title:</code>,{" "}
                            <code className="rounded bg-slate-100 px-1">Artist:</code>,{" "}
                            <code className="rounded bg-slate-100 px-1">Key:</code>,{" "}
                            <code className="rounded bg-slate-100 px-1">Capo:</code> lines, then chords and lyrics.
                          </p>
                          <textarea
                            id="pasted-tab-text"
                            value={pastedTabText}
                            onChange={e => setPastedTabText(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault()
                                addOrConfirmPastedSong()
                              }
                            }}
                            placeholder={
                              "Title: Song Name\nArtist: Artist Name\nKey: G\nCapo: 4\n\n[Verse 1]\nD      G\nLyrics..."
                            }
                            className="min-h-[280px] w-full rounded-md border border-input bg-white px-3 py-2 text-sm leading-6 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            style={{ fontFamily: getBrowserFontStack(monoFont) }}
                          />
                          {pastedTabError && (
                            <p className="text-sm text-red-600">{pastedTabError}</p>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <span className="text-sm text-slate-500">
                              {editingSongId
                                ? "Preview updates as you type."
                                : "The draft shows in the preview until you add it."}
                            </span>
                            <div className="flex items-center gap-2">
                              {editingSongId && (
                                <Button onClick={cancelEditingSong} variant="outline">
                                  Cancel
                                </Button>
                              )}
                              <Button
                                onClick={addOrConfirmPastedSong}
                                disabled={!pastedTabText.trim() || Boolean(pastedTabError)}
                                variant={editingSongId ? "default" : "secondary"}
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
                          </div>
                        </div>
                      )}
                    </div>
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
                      <Button size="sm" onClick={() => saveSetlist()} disabled={songs.length === 0}>
                        <Save className="mr-2 h-4 w-4" />
                        {activeSavedSetlist ? "Save" : "Save setlist"}
                      </Button>
                      {activeSavedSetlist && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => saveSetlist(true)}
                          disabled={songs.length === 0}
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
                          Add songs above, or open one of{" "}
                          <button
                            type="button"
                            onClick={() => setView("saved")}
                            className="font-medium text-primary hover:underline"
                          >
                            your saved setlists
                          </button>
                          .
                        </p>
                      </div>
                    ) : (
                      <ol className="space-y-2">
                        {songs.map((songData, index) => (
                          <li
                            key={songData.id}
                            className={cn(
                              "rounded-lg border bg-white p-3 transition-colors",
                              editingSongId === songData.id
                                ? "border-primary ring-1 ring-primary"
                                : "border-slate-200 hover:border-slate-300"
                            )}
                          >
                            <div className="flex items-start gap-3">
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

                            <div className="mt-3 flex flex-wrap items-center gap-2 pl-10">
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
                title="My setlists"
                description="Saved in this browser. Open one to edit it, or add its songs to your current setlist."
                action={
                  <Button
                    size="sm"
                    onClick={() => saveSetlist()}
                    disabled={songs.length === 0}
                    title={songs.length === 0 ? "Add songs in the editor first" : undefined}
                  >
                    <Save className="mr-2 h-4 w-4" />
                    Save current
                  </Button>
                }
              />
              <CardContent className="space-y-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={savedSetlistSearch}
                    onChange={e => setSavedSetlistSearch(e.target.value)}
                    placeholder="Search setlists or songs"
                    className="pl-9"
                  />
                </div>

                <div className="max-h-[calc(100vh-17rem)] space-y-2 overflow-y-auto pr-1">
                  {savedSetlists.length === 0 ? (
                    <div className="rounded-lg border-2 border-dashed border-slate-200 px-6 py-12 text-center">
                      <FolderOpen className="mx-auto h-10 w-10 text-slate-300" />
                      <p className="mt-3 font-medium text-slate-700">No saved setlists yet</p>
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
                            {pluralize(saved.songs.length, "song")} · updated {formatRelativeTime(saved.updatedAt)}
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
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => deleteSavedSetlist(saved)}
                            className="h-9 w-9 text-red-500 hover:bg-red-50 hover:text-red-700"
                            title="Delete saved setlist"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {view === "published" && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="space-y-6 lg:col-span-4">
                <Card className="shadow-sm">
                  <SectionHeading
                    icon={<Upload className="h-5 w-5" />}
                    title="Publish your setlist"
                    description="Share your current setlist so anyone can view or add it."
                  />
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="publish-title" className="text-sm font-medium">
                        Title
                      </Label>
                      <Input
                        id="publish-title"
                        value={publishTitle}
                        onChange={e => setPublishTitle(e.target.value)}
                        placeholder={defaultPublishTitle}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="publisher-name" className="text-sm font-medium">
                        Your name <span className="font-normal text-slate-500">(optional)</span>
                      </Label>
                      <Input
                        id="publisher-name"
                        value={publisherName}
                        onChange={e => setPublisherName(e.target.value)}
                        placeholder="Anonymous"
                      />
                    </div>
                    <Button
                      onClick={publishCurrentSetlist}
                      disabled={songs.length === 0 || isPublishing}
                      className="w-full"
                    >
                      {isPublishing ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Publishing
                        </>
                      ) : (
                        <>
                          <Upload className="mr-2 h-4 w-4" />
                          {songs.length === 0
                            ? "Add songs to publish"
                            : `Publish ${pluralize(songs.length, "song")}`}
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>

                <Card className="shadow-sm">
                  <CardContent className="space-y-1.5 pt-6">
                    <Label htmlFor="delete-password" className="text-sm font-medium">
                      Delete password
                    </Label>
                    <Input
                      id="delete-password"
                      type="password"
                      value={deletePassword}
                      onChange={e => setDeletePassword(e.target.value)}
                      placeholder="Ask Allen"
                    />
                    <p className="text-sm text-slate-500">Needed only to remove published tabs.</p>
                  </CardContent>
                </Card>
              </div>

              <Card className="shadow-sm lg:col-span-8">
                <SectionHeading
                  icon={<Globe className="h-5 w-5" />}
                  title="Public tabs"
                  description={
                    publicTabs.length > 0
                      ? `${pluralize(publicTabs.length, "published tab")}`
                      : "Anyone can publish here."
                  }
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadPublicTabs}
                      disabled={isPublicTabsLoading}
                      title="Refresh public tabs"
                    >
                      <RefreshCw
                        className={cn("mr-1.5 h-4 w-4", isPublicTabsLoading && "animate-spin")}
                      />
                      Refresh
                    </Button>
                  }
                />
                <CardContent className="space-y-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={publicTabsSearch}
                      onChange={e => setPublicTabsSearch(e.target.value)}
                      placeholder="Search by song, artist, setlist, or publisher"
                      className="pl-9"
                    />
                  </div>

                  <div className="max-h-[calc(100vh-16rem)] min-h-[420px] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                    {isPublicTabsLoading && publicTabs.length === 0 ? (
                      <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading public tabs…
                      </div>
                    ) : publicTabs.length === 0 ? (
                      <p className="py-12 text-center text-sm text-slate-500">
                        No public tabs yet. Publish your current setlist to start.
                      </p>
                    ) : filteredPublicTabs.length === 0 ? (
                      <p className="py-12 text-center text-sm text-slate-500">No matching tabs found.</p>
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
                              {publicTab.setlistTitle}
                            </div>
                            <div className="truncate text-sm text-slate-500">
                              {publicTab.publisherName} · {pluralize(publicTab.songs.length, "song")} ·{" "}
                              {new Date(publicTab.publishedAt).toLocaleDateString()}
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
                            {deletePassword.trim() && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => deletePublicTab(publicTab)}
                                disabled={deletingTabId === publicTab.id}
                                className="h-8 w-8 text-red-500 hover:bg-red-50 hover:text-red-700"
                                title="Delete tab"
                              >
                                {deletingTabId === publicTab.id ? (
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
            </div>
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
              description="Share this song to the public tab list."
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
                      {song.song} <span className="font-normal text-slate-500">· {song.artist}</span>
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
              {previewPublicTab && deletePassword.trim() && (
                <div className="flex justify-end">
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
                    Delete from public tabs
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </DialogContent>
      </Dialog>

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
