"use client"

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
} from "react"
import {
  parse,
  transpose,
  prettyPrint,
} from "chord-magic/dist/chord-magic.cjs.js"
import generatePDF from "../lib/generate-pdf"
import generateDocx from "../lib/generate-docx"
import type {
  ExportSettings,
  MonoFontOption,
  PositionedNoteBox,
  PublicTabEntry,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs"
import { Separator } from "../components/ui/separator"
import { Dialog, DialogContent } from "../components/ui/dialog"
import { FullScreenPDFViewer } from "../components/FullScreenPDFViewer"
import {
  Music,
  FileText,
  // LinkIcon,        // --- LIBRARY DISABLED ---
  // ArrowUpDown,     // --- LIBRARY DISABLED ---
  FileDown,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Music2,
  Maximize,
  Plus,
  Trash2,
  // GripVertical,    // --- LIBRARY DISABLED ---
  List,
  Copy,
  Check,
  FileType,
  Globe,
  Upload,
  RefreshCw,
  Edit3,
  Eye,
  // Library,         // --- LIBRARY DISABLED ---
  // Search,          // --- LIBRARY DISABLED ---
  // X,               // --- LIBRARY DISABLED ---
} from "lucide-react"

const corsURI = "https://api.codetabs.com/v1/proxy/?quest="
const MIN_NOTE_BOX_DIMENSION = 0.02

// Fix 1: Replace 'any' with proper type definitions
interface ObjectWithKey {
  [key: string]: unknown
}

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

// --- LIBRARY DISABLED ---
/*
interface SavedSong {
  uri: string
  artist: string
  song: string
  addedAt: number
}
*/

function findInObject(obj: ObjectWithKey, key: string): unknown[] {
  let objects: unknown[] = []
  const keys = Object.keys(obj || {})
  for (let i = 0; i < keys.length; i += 1) {
    const _key = keys[i]
    if (Object.prototype.hasOwnProperty.call(obj, _key)) {
      if (typeof obj[_key] === "object" && obj[_key] !== null) {
        objects = [...objects, ...findInObject(obj[_key] as ObjectWithKey, key)]
      } else if (_key === key) {
        objects.push(obj[_key])
      }
    }
  }
  return objects
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

export default function ChordTransposer() {
  // Multi-song state
  const [songs, setSongs] = useState<SongData[]>([])
  const [currentUri, setCurrentUri] = useState("")
  const [pastedTabText, setPastedTabText] = useState("")
  const [editingSongId, setEditingSongId] = useState<string | null>(null)

  // --- LIBRARY DISABLED ---
  /*
  const [savedSongs, setSavedSongs] = useState<SavedSong[]>([])
  const [librarySearch, setLibrarySearch] = useState("")
  */

  const halftoneStyle = "FLATS"
  const [simplify] = useState(false)
  const [fontSize, setFontSize] = useState(10)
  const [autoLinebreak, setAutoLinebreak] = useState(false)
  const [monoFont, setMonoFont] = useState<MonoFontOption>("roboto-mono")
  const [workspaceTab, setWorkspaceTab] = useState("editor")
  const [noteBoxes, setNoteBoxes] = useState<PositionedNoteBox[]>([])
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [previewNotePage, setPreviewNotePage] = useState(1)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("pdf")
  const [isFullScreen, setIsFullScreen] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)
  const [publicTabs, setPublicTabs] = useState<PublicTabEntry[]>([])
  const [isPublicTabsLoading, setIsPublicTabsLoading] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isPublishingSong, setIsPublishingSong] = useState(false)
  const [publisherName, setPublisherName] = useState("")
  const [publishTitle, setPublishTitle] = useState("")
  const [publishMessage, setPublishMessage] = useState<string | null>(null)
  const [isPublishSongDialogOpen, setIsPublishSongDialogOpen] = useState(false)
  const [songToPublish, setSongToPublish] = useState<SongData | null>(null)
  const [publishSongTitle, setPublishSongTitle] = useState("")
  const [publishSongAuthor, setPublishSongAuthor] = useState("")
  const [previewPublicTab, setPreviewPublicTab] = useState<PublicTabEntry | null>(null)
  const [deletePassword, setDeletePassword] = useState("")
  const [isNotesPanelOpen, setIsNotesPanelOpen] = useState(false)
  const [isAdvancedExportOpen, setIsAdvancedExportOpen] = useState(false)
  const [deletingTabId, setDeletingTabId] = useState<string | null>(null)

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
  const canEditNotes = activeTab === "pdf" && Boolean(pdfUrl)

  // --- LIBRARY DISABLED ---
  /*
  useEffect(() => {
    const saved = localStorage.getItem("savedSongs")
    if (saved) {
      try {
        setSavedSongs(JSON.parse(saved))
      } catch (err) {
        console.error("Failed to load saved songs:", err)
      }
    }
  }, [])
  */

  // --- LIBRARY DISABLED ---
  /*
  const saveToLibrary = useCallback((uri: string, artist: string, song: string) => {
    setSavedSongs(prev => {
      if (prev.some(s => s.uri === uri)) return prev

      const newSong: SavedSong = {
        uri,
        artist,
        song,
        addedAt: Date.now()
      }

      const updated = [...prev, newSong]
      localStorage.setItem("savedSongs", JSON.stringify(updated))
      return updated
    })
  }, [])

  const clearLibrary = useCallback(() => {
    setSavedSongs([])
    localStorage.removeItem("savedSongs")
  }, [])
  */

  const addSong = useCallback(
    async (urlToAdd?: string) => {
      const uri = urlToAdd || currentUri
      if (!uri.includes("ultimate-guitar.com")) {
        setError("Please enter a valid Ultimate Guitar URL")
        return
      }

      setError(null)
      setIsLoading(true)

      try {
        const res = await fetch(`${corsURI}${uri}`)
        if (!res.ok) throw new Error("Failed to fetch song data")

        const text = await res.text()
        const div = document.createElement("div")
        div.innerHTML = text

        const store = div.getElementsByClassName("js-store")[0]
        const storeJson = store?.getAttribute("data-content") || ""
        if (!storeJson) throw new Error("Could not find song data on the page")

        const storeData = JSON.parse(storeJson)
        const [parsedSongName] = findInObject(storeData, "song_name") as string[]
        const [parsedArtistName] = findInObject(storeData, "artist_name") as string[]
        const [parsedChords] = findInObject(storeData, "content") as string[]

        if (!parsedChords) throw new Error("No chord data found")

        const artist = parsedArtistName || "Unknown Artist"
        const songName = parsedSongName || "Unknown Song"

        const newSong: SongData = {
          id: Date.now().toString(),
          uri,
          artist,
          song: songName,
          chords: parsedChords,
          transposedChords: parsedChords,
          transposeStep: 0,
        }

        setSongs(prev => [...prev, newSong])

        // --- LIBRARY DISABLED ---
        // saveToLibrary(uri, artist, songName)

        setCurrentUri("")
        setActiveTab("pdf")
      } catch (err) {
        console.error("Failed to load song:", err)
        setError("Failed to load song. Please check the URL and try again.")
      } finally {
        setIsLoading(false)
      }
    },
    [currentUri]
  )

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
              }
            : song
        )
      )

      setEditingSongId(null)
      setPastedTabText("")
      setActiveTab("pdf")
      return
    }

    const songId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
    setActiveTab("pdf")
  }, [
    pastedTabText,
    parsedPastedSong,
    pastedTabError,
    editingSongId,
  ])

  const currentExportSettings = useMemo<ExportSettings>(
    () => ({
      monoFont,
      noteBoxes,
    }),
    [monoFont, noteBoxes]
  )

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
    const noteId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

  const publishCurrentSetlist = useCallback(async () => {
    if (songs.length === 0) {
      setError("Add at least one song before publishing.")
      return
    }

    setIsPublishing(true)
    setPublishMessage(null)
    setError(null)

    try {
      const res = await fetch("/api/public-tabs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          publisherName,
          setlistTitle:
            publishTitle ||
            (songs.length === 1
              ? `${songs[0].artist} - ${songs[0].song}`
              : `Setlist (${songs.length} songs)`),
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

      setPublishMessage("Published to Public Tabs.")
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
    monoFont,
    noteBoxes,
    loadPublicTabs,
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
    setPublishMessage(null)

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

      setPublishMessage(`Published "${songTitle}"`)
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
  }, [songToPublish, publishSongTitle, publishSongAuthor, monoFont, noteBoxes, loadPublicTabs])

  const addPublicTabToSetlist = useCallback(
    (publicTab: PublicTabEntry, applyExportSettings = false) => {
      const importedSongs: SongData[] = publicTab.songs.map((song, index) => {
        const importId = `${Date.now()}-${publicTab.id}-${index}`
        return {
          id: importId,
          uri: `public://${publicTab.id}/${index}`,
          artist: song.artist,
          song: song.song,
          chords: song.transposedChords,
          transposedChords: song.transposedChords,
          transposeStep: 0,
        }
      })

      setSongs(prev => [...prev, ...importedSongs])

      if (applyExportSettings) {
        setMonoFont(publicTab.exportSettings?.monoFont || "roboto-mono")
        if (
          Array.isArray(publicTab.exportSettings?.noteBoxes) &&
          publicTab.exportSettings.noteBoxes.length > 0
        ) {
          setNoteBoxes(publicTab.exportSettings.noteBoxes)
          setPreviewNotePage(publicTab.exportSettings.noteBoxes[0].page || 1)
        }
      }

      setPublishMessage(
        `Added ${importedSongs.length} ${importedSongs.length === 1 ? "song" : "songs"} to setlist`
      )
      setActiveTab("pdf")
    },
    []
  )

  const openPublicTabPreview = useCallback((publicTab: PublicTabEntry) => {
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
      setPublishMessage(null)

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
        setPublishMessage(`Deleted "${publicTab.setlistTitle}"`)
      } catch (err) {
        console.error("Failed deleting public tab:", err)
        setError(
          err instanceof Error ? err.message : "Failed to delete published tab."
        )
      } finally {
        setDeletingTabId(null)
      }
    },
    [deletePassword, previewPublicTab]
  )

  // --- LIBRARY DISABLED ---
  /*
  const addFromLibrary = useCallback(async (saved: SavedSong) => {
    try {
      await addSong(saved.uri)
    } catch (err) {
      console.error("Failed to add from library:", err)
      setError("Failed to add song from library")
    }
  }, [addSong])
  */

  useEffect(() => {
    if (currentUri && currentUri.includes("ultimate-guitar.com")) {
      setError(null)
    }
  }, [currentUri])

  useEffect(() => {
    loadPublicTabs()
  }, [loadPublicTabs])

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
            }
          : song
      )
    )
  }, [editingSongId, parsedPastedSong])

  const startEditingSong = useCallback((song: SongData) => {
    setEditingSongId(song.id)
    setPastedTabText(songToEditableTabText(song))
    setError(null)
    setWorkspaceTab("editor")
    setActiveTab("pdf")
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

  const moveSongUp = useCallback((index: number) => {
    if (index === 0) return
    setSongs(prev => {
      const newSongs = [...prev]
      ;[newSongs[index - 1], newSongs[index]] = [newSongs[index], newSongs[index - 1]]
      return newSongs
    })
  }, [])

  const moveSongDown = useCallback((index: number) => {
    setSongs(prev => {
      if (index === prev.length - 1) return prev
      const newSongs = [...prev]
      ;[newSongs[index], newSongs[index + 1]] = [newSongs[index + 1], newSongs[index]]
      return newSongs
    })
  }, [])

  const updateTranspose = useCallback((id: string, step: number) => {
    setSongs(prev =>
      prev.map(s => (s.id === id ? { ...s, transposeStep: step } : s))
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
        activeTab === "pdf"
      ) {
        const activeElement = document.activeElement
        if (
          activeElement &&
          (activeElement.tagName === "INPUT" ||
            activeElement.tagName === "TEXTAREA")
        )
          return

        e.preventDefault()
        setIsFullScreen(true)
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [pdfUrl, activeTab])

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

  const handleDownloadPDF = () => {
    if (!pdfUrl) return

    const a = document.createElement("a")
    a.href = pdfUrl
    a.download =
      songs.length === 1
        ? `${songs[0].artist} - ${songs[0].song}.pdf`
        : `Setlist - ${songs.length} songs.pdf`

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
      setTimeout(() => setError(null), 3000)
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
      a.download =
        songs.length === 1
          ? `${songs[0].artist} - ${songs[0].song}.docx`
          : `Setlist - ${songs.length} songs.docx`

      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setError("Failed to generate Word document")
      setTimeout(() => setError(null), 3000)
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <header className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Music2 className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                tabs
              </h1>
              {songs.length > 0 && (
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  ({songs.length} {songs.length === 1 ? "song" : "songs"})
                </span>
              )}
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadPDF}
                disabled={!pdfUrl}
                className="hidden sm:flex"
              >
                <FileDown className="mr-2 h-4 w-4" />
                PDF
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <Tabs
            value={workspaceTab}
            onValueChange={setWorkspaceTab}
            className="mb-6"
          >
            <TabsList className="grid w-full max-w-[320px] grid-cols-2">
              <TabsTrigger value="editor">Editor</TabsTrigger>
              <TabsTrigger value="published">Published Tabs</TabsTrigger>
            </TabsList>
          </Tabs>

          {workspaceTab === "editor" && (
            <Card className="mb-6 border border-slate-200 dark:border-slate-800 shadow-md">
            <CardHeader className="pb-3">
              <CardTitle className="text-xl flex items-center">
                <Plus className="mr-2 h-5 w-5 text-primary" />
                Add Song to Setlist
              </CardTitle>
              <CardDescription>
                Add by Ultimate Guitar link or paste tab text from your personal editor
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-grow">
                  <Input
                    value={currentUri}
                    onChange={e => setCurrentUri(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && currentUri && !isLoading) {
                        e.preventDefault()
                        addSong()
                      }
                    }}
                    placeholder="https://tabs.ultimate-guitar.com/tab/..."
                    className="w-full"
                  />
                </div>
                <Button
                  onClick={() => addSong()}
                  disabled={isLoading || !currentUri}
                  className="min-w-[120px]"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading
                    </>
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      Add Song
                    </>
                  )}
                </Button>
              </div>

              <Separator className="my-4" />

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="pasted-tab-text">Paste tab text</Label>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Supports `Title`, `Artist`, `Key`, `Capo`, plus chord/lyric blocks.
                  </p>
                </div>
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
                  className="w-full min-h-[220px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  style={{ fontFamily: getBrowserFontStack(monoFont) }}
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {editingSongId
                      ? "Live preview updates while editing. Press Confirm Edit when finished."
                      : "Live preview includes this draft. Press Add Song to save it to your setlist."}
                  </div>
                  <div className="flex items-center gap-2">
                    {editingSongId && (
                      <Button onClick={cancelEditingSong} variant="outline">
                        Cancel Edit
                      </Button>
                    )}
                    <Button
                      onClick={addOrConfirmPastedSong}
                      disabled={!pastedTabText.trim() || Boolean(pastedTabError)}
                      variant="secondary"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      {editingSongId ? "Confirm Edit" : "Add Song"}
                    </Button>
                  </div>
                </div>

                {pastedTabError && (
                  <p className="text-xs text-red-600 dark:text-red-400">{pastedTabError}</p>
                )}
              </div>

              {error && (
                <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-md flex items-start">
                  <AlertCircle className="h-5 w-5 mr-2 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </CardContent>
          </Card>
          )}

          {workspaceTab === "published" && (
            <Card className="mb-6 border border-slate-200 dark:border-slate-800 shadow-md">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center">
                <Globe className="mr-2 h-5 w-5 text-primary" />
                Public Tabs
              </CardTitle>
              <CardDescription>
                Anyone can publish here. Delete can be password-gated by setting{" "}
                <code>TABS_DELETE_PASSWORD</code> on the server.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <Input
                  value={publisherName}
                  onChange={e => setPublisherName(e.target.value)}
                  placeholder="Your name (optional)"
                />
                <Input
                  value={publishTitle}
                  onChange={e => setPublishTitle(e.target.value)}
                  placeholder="Setlist title (optional)"
                />
                <Input
                  type="password"
                  value={deletePassword}
                  onChange={e => setDeletePassword(e.target.value)}
                  placeholder="Delete password"
                />
                <div className="flex gap-2 items-center">
                  <Button
                    onClick={publishCurrentSetlist}
                    disabled={songs.length === 0 || isPublishing}
                    className="flex-1"
                  >
                    {isPublishing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Publishing
                      </>
                    ) : (
                      <>
                        <Upload className="mr-2 h-4 w-4" />
                        Publish
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={loadPublicTabs}
                    disabled={isPublicTabsLoading}
                    className="px-3"
                    title="Refresh public tabs"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${isPublicTabsLoading ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>
              </div>

              {publishMessage && (
                <div className="mt-3 p-2 rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 text-sm">
                  {publishMessage}
                </div>
              )}

              <div className="mt-4 space-y-2 max-h-[320px] overflow-y-auto pr-1">
                {isPublicTabsLoading && publicTabs.length === 0 ? (
                  <div className="text-sm text-slate-500 dark:text-slate-400 flex items-center">
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Loading public tabs...
                  </div>
                ) : publicTabs.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    No public tabs yet. Publish your current setlist to start.
                  </p>
                ) : (
	                  publicTabs.map(publicTab => (
	                    <div
	                      key={publicTab.id}
	                      className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-between gap-3"
	                    >
	                      <button
	                        type="button"
	                        onClick={() => openPublicTabPreview(publicTab)}
	                        className="min-w-0 text-left flex-1"
	                      >
	                        <div className="font-semibold text-sm truncate">
	                          {publicTab.setlistTitle}
	                        </div>
	                        <div className="text-xs text-slate-500 dark:text-slate-400">
	                          {publicTab.publisherName} • {publicTab.songs.length}{" "}
	                          {publicTab.songs.length === 1 ? "song" : "songs"} •{" "}
	                          {new Date(publicTab.publishedAt).toLocaleString()}
	                        </div>
	                      </button>
	                      <div className="flex items-center gap-2">
	                        <Button
	                          variant="outline"
	                          size="sm"
	                          onClick={() => openPublicTabPreview(publicTab)}
	                        >
	                          <Eye className="mr-1 h-3.5 w-3.5" />
	                          Preview
	                        </Button>
	                        <Button
	                          variant="outline"
	                          size="sm"
	                          onClick={() => addPublicTabToSetlist(publicTab)}
	                        >
	                          Add to Setlist
	                        </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => deletePublicTab(publicTab)}
                            disabled={
                              deletingTabId === publicTab.id ||
                              !deletePassword.trim()
                            }
                            className="text-red-600 hover:text-red-700"
                            title={
                              deletePassword.trim()
                                ? "Delete tab"
                                : "Enter delete password first"
                            }
                          >
                            {deletingTabId === publicTab.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
	                      </div>
	                    </div>
	                  ))
	                )}
	              </div>
            </CardContent>
          </Card>
          )}

          {workspaceTab === "editor" && songs.length > 0 && (
            <Card className="mb-6 border border-slate-200 dark:border-slate-800 shadow-md">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center">
                  <List className="mr-2 h-5 w-5 text-primary" />
                  Setlist ({songs.length} {songs.length === 1 ? "song" : "songs"})
                </CardTitle>
                <CardDescription>
                  Reorder, transpose, or remove songs from your setlist
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {songs.map((songData, index) => (
                    <div
                      key={songData.id}
                      className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700"
                    >
                      <div className="flex flex-col gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => moveSongUp(index)}
                          disabled={index === 0}
                          className="h-6 w-6"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => moveSongDown(index)}
                          disabled={index === songs.length - 1}
                          className="h-6 w-6"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="flex-grow min-w-0">
                        <div className="font-semibold text-sm truncate">
                          {songData.song}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {songData.artist}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Transpose:
                        </div>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            updateTranspose(
                              songData.id,
                              Math.max(songData.transposeStep - 1, -12)
                            )
                          }
                          disabled={songData.transposeStep <= -12}
                          className="h-7 w-7"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                        <div className="w-12 text-center font-mono text-sm font-bold text-primary">
                          {songData.transposeStep > 0
                            ? `+${songData.transposeStep}`
                            : songData.transposeStep}
                        </div>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            updateTranspose(
                              songData.id,
                              Math.min(songData.transposeStep + 1, 12)
                            )
                          }
                          disabled={songData.transposeStep >= 12}
                          className="h-7 w-7"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openPublishSongDialog(songData)}
                          className="h-8"
                        >
                          <Upload className="mr-1 h-3.5 w-3.5" />
                          Publish
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEditingSong(songData)}
                          className="h-8"
                        >
                          <Edit3 className="mr-1 h-3.5 w-3.5" />
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeSong(songData.id)}
                          className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {workspaceTab === "editor" && previewSongs.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2 border border-slate-200 dark:border-slate-800 shadow-md">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                  <CardHeader className="pb-0">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-xl flex items-center">
                        <Music className="mr-2 h-5 w-5 text-primary" />
                        Transposed Chords
                      </CardTitle>
                      <div className="flex items-center gap-3">
                        <TabsList className="grid grid-cols-2 w-[200px]">
                          <TabsTrigger value="preview">Preview</TabsTrigger>
                          <TabsTrigger value="pdf">PDF</TabsTrigger>
                        </TabsList>
                        {pdfUrl && activeTab === "pdf" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setIsFullScreen(true)}
                            className="hidden sm:flex items-center gap-1 text-xs"
                            title="Open fullscreen with autoscroll (F)"
                          >
                            <Maximize className="h-3 w-3" />
                            Fullscreen
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="pt-6">
                    <TabsContent value="preview" className="mt-0">{/* disabled */}</TabsContent>

                    <TabsContent value="pdf" className="mt-0">
                      {pdfUrl ? (
                        <div className="relative group">
                          <iframe
                            src={pdfUrl}
                            className="w-full h-[70vh] border border-slate-200 dark:border-slate-800 rounded-md"
                            title="PDF Preview"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setIsFullScreen(true)}
                            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shadow-lg backdrop-blur-sm bg-white/90 dark:bg-slate-800/90 hover:bg-white dark:hover:bg-slate-800"
                            title="Open in fullscreen with autoscroll (F)"
                          >
                            <Maximize className="h-4 w-4 mr-1" />
                            Fullscreen
                          </Button>
                        </div>
                      ) : (
                        <div className="w-full h-[70vh] flex items-center justify-center text-slate-500 border border-slate-200 dark:border-slate-800 rounded-md">
                          <Loader2 className="h-8 w-8 animate-spin mr-2" />
                          Generating PDF preview...
                        </div>
                      )}
                    </TabsContent>
                  </CardContent>
                </Tabs>
              </Card>

              <div className="flex flex-col gap-6">
                <Card className="order-2 border border-slate-200 dark:border-slate-800 shadow-md">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center">
                      <FileText className="mr-2 h-5 w-5 text-primary" />
                      PDF Settings
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-6">
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <Label htmlFor="font-size-slider">Font Size: {fontSize}pt</Label>
                          <span className="text-sm text-slate-500 dark:text-slate-400">
                            {fontSize < 9
                              ? "Small"
                              : fontSize > 12
                              ? "Large"
                              : "Medium"}
                          </span>
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
                        <Label htmlFor="mono-font-select">Monospace Font</Label>
                        <select
                          id="mono-font-select"
                          value={monoFont}
                          onChange={e => setMonoFont(e.target.value as MonoFontOption)}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          style={{ fontFamily: getBrowserFontStack(monoFont) }}
                        >
                          {monoFontOptions.map(fontOption => (
                            <option key={fontOption.value} value={fontOption.value}>
                              {fontOption.label} ({fontOption.exportHint})
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          PDF supports Roboto Mono and Courier-family rendering.
                        </p>
                      </div>

                      <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
                        <p>Inline styling now uses markdown:</p>
                        <p>
                          Use <code>*bold*</code> for bold and <code>_underline_</code>{" "}
                          for underline.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="order-1 border border-slate-200 dark:border-slate-800 shadow-md">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg flex items-center">
                        <FileText className="mr-2 h-5 w-5 text-primary" />
                        Note Boxes
                      </CardTitle>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setIsNotesPanelOpen(prev => !prev)}
                        className="h-8 w-8"
                      >
                        {isNotesPanelOpen ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <CardDescription>
                      Keep PDF tab visible while positioning notes.
                    </CardDescription>
                  </CardHeader>
                  {isNotesPanelOpen && (
                    <CardContent>
                      <div className="space-y-3">
                        {!canEditNotes && (
                          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
                            Open the PDF tab to edit notes while viewing the real layout.
                            <div className="mt-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => setActiveTab("pdf")}
                              >
                                Show PDF Tab
                              </Button>
                            </div>
                          </div>
                        )}

                        <fieldset disabled={!canEditNotes} className={canEditNotes ? "" : "opacity-60"}>
                          <div className="space-y-3">
                            <div className="flex items-center justify-between gap-2">
                              <Label>Per-Page Note Boxes</Label>
                              <div className="flex items-center gap-2">
                                <label className="text-xs text-slate-500 dark:text-slate-400">
                                  Page
                                </label>
                                <Input
                                  type="number"
                                  min={1}
                                  value={previewNotePage}
                                  onChange={e =>
                                    setPreviewNotePage(
                                      Math.max(1, Number.parseInt(e.target.value || "1", 10))
                                    )
                                  }
                                  className="h-8 w-20"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <Button type="button" variant="outline" onClick={addNoteBox}>
                                Add Note Box
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => setSelectedNoteId(null)}
                                disabled={!selectedNoteId}
                              >
                                Clear Selection
                              </Button>
                            </div>

                            {noteBoxes.length > 0 && (
                              <div className="space-y-2">
                                <Label className="text-xs text-slate-500 dark:text-slate-400">
                                  Select a note box to edit
                                </Label>
                                <div className="max-h-[140px] overflow-y-auto space-y-1 pr-1">
                                  {noteBoxes.map((noteBox, noteIndex) => (
                                    <button
                                      key={noteBox.id}
                                      type="button"
                                      onClick={() => {
                                        setSelectedNoteId(noteBox.id)
                                        setPreviewNotePage(noteBox.page)
                                      }}
                                      className={`w-full rounded-md border px-2 py-1.5 text-left text-xs ${
                                        selectedNoteId === noteBox.id
                                          ? "border-primary bg-primary/10 text-primary"
                                          : "border-slate-200 dark:border-slate-700"
                                      }`}
                                    >
                                      Note {noteIndex + 1} • Page {noteBox.page}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {selectedNoteBox && (
                              <div className="space-y-2 rounded-md border border-slate-200 dark:border-slate-700 p-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-medium">Selected Note Box</span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={removeSelectedNoteBox}
                                    className="text-red-600 hover:text-red-700"
                                  >
                                    Remove
                                  </Button>
                                </div>

                                <div className="space-y-3">
                                  <div className="space-y-1">
                                    <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                                      <Label className="text-xs">Page</Label>
                                      <span>{selectedNoteBox.page}</span>
                                    </div>
                                    <Input
                                      type="number"
                                      min={1}
                                      value={selectedNoteBox.page}
                                      onChange={e =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          page: Math.max(
                                            1,
                                            Number.parseInt(e.target.value || "1", 10)
                                          ),
                                        }))
                                      }
                                      className="h-8"
                                    />
                                  </div>

                                  <div className="space-y-1">
                                    <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                                      <Label className="text-xs">X Position</Label>
                                      <span>{selectedNoteBox.x.toFixed(2)}</span>
                                    </div>
                                    <Input
                                      type="number"
                                      step={0.01}
                                      min={0}
                                      max={1}
                                      value={selectedNoteBox.x}
                                      onChange={e =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          x: Math.max(
                                            0,
                                            Math.min(
                                              1,
                                              Number.parseFloat(e.target.value || "0.62")
                                            )
                                          ),
                                        }))
                                      }
                                      className="h-8"
                                    />
                                    <Slider
                                      min={0}
                                      max={1}
                                      step={0.01}
                                      value={[selectedNoteBox.x]}
                                      onValueChange={value =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          x: Math.max(0, Math.min(1, value[0] || 0)),
                                        }))
                                      }
                                    />
                                  </div>

                                  <div className="space-y-1">
                                    <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                                      <Label className="text-xs">Y Position</Label>
                                      <span>{selectedNoteBox.y.toFixed(2)}</span>
                                    </div>
                                    <Input
                                      type="number"
                                      step={0.01}
                                      min={0}
                                      max={1}
                                      value={selectedNoteBox.y}
                                      onChange={e =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          y: Math.max(
                                            0,
                                            Math.min(
                                              1,
                                              Number.parseFloat(e.target.value || "0.08")
                                            )
                                          ),
                                        }))
                                      }
                                      className="h-8"
                                    />
                                    <Slider
                                      min={0}
                                      max={1}
                                      step={0.01}
                                      value={[selectedNoteBox.y]}
                                      onValueChange={value =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          y: Math.max(0, Math.min(1, value[0] || 0)),
                                        }))
                                      }
                                    />
                                  </div>

                                  <div className="space-y-1">
                                    <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                                      <Label className="text-xs">Width</Label>
                                      <span>{selectedNoteBox.width.toFixed(2)}</span>
                                    </div>
                                    <Input
                                      type="number"
                                      step={0.01}
                                      min={MIN_NOTE_BOX_DIMENSION}
                                      max={1}
                                      value={selectedNoteBox.width}
                                      onChange={e =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          width: Math.max(
                                            MIN_NOTE_BOX_DIMENSION,
                                            Math.min(
                                              1,
                                              Number.parseFloat(e.target.value || "0.24")
                                            )
                                          ),
                                        }))
                                      }
                                      className="h-8"
                                    />
                                    <Slider
                                      min={MIN_NOTE_BOX_DIMENSION}
                                      max={1}
                                      step={0.01}
                                      value={[selectedNoteBox.width]}
                                      onValueChange={value =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          width: Math.max(
                                            MIN_NOTE_BOX_DIMENSION,
                                            Math.min(1, value[0] || MIN_NOTE_BOX_DIMENSION)
                                          ),
                                        }))
                                      }
                                    />
                                  </div>

                                  <div className="space-y-1">
                                    <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                                      <Label className="text-xs">Height</Label>
                                      <span>{selectedNoteBox.height.toFixed(2)}</span>
                                    </div>
                                    <Input
                                      type="number"
                                      step={0.01}
                                      min={MIN_NOTE_BOX_DIMENSION}
                                      max={1}
                                      value={selectedNoteBox.height}
                                      onChange={e =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          height: Math.max(
                                            MIN_NOTE_BOX_DIMENSION,
                                            Math.min(
                                              1,
                                              Number.parseFloat(e.target.value || "0.18")
                                            )
                                          ),
                                        }))
                                      }
                                      className="h-8"
                                    />
                                    <Slider
                                      min={MIN_NOTE_BOX_DIMENSION}
                                      max={1}
                                      step={0.01}
                                      value={[selectedNoteBox.height]}
                                      onValueChange={value =>
                                        updateSelectedNoteBox(noteBox => ({
                                          ...noteBox,
                                          height: Math.max(
                                            MIN_NOTE_BOX_DIMENSION,
                                            Math.min(1, value[0] || MIN_NOTE_BOX_DIMENSION)
                                          ),
                                        }))
                                      }
                                    />
                                  </div>
                                </div>

                                <textarea
                                  value={selectedNoteBox.text}
                                  onChange={e =>
                                    updateSelectedNoteBox(noteBox => ({
                                      ...noteBox,
                                      text: e.target.value,
                                    }))
                                  }
                                  placeholder="Use *bold* and _underline_ markdown here."
                                  className="w-full min-h-[96px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                  style={{ fontFamily: getBrowserFontStack(monoFont) }}
                                />
                              </div>
                            )}
                          </div>
                        </fieldset>

                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Note preview overlay is disabled to avoid browser PDF alignment
                          mismatch. Use the numeric + slider controls to position boxes.
                        </p>
                      </div>
                    </CardContent>
                  )}
                </Card>

                <Card className="order-3 border border-slate-200 dark:border-slate-800 shadow-md">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center">
                      <FileText className="mr-2 h-5 w-5 text-primary" />
                      Export Options
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="auto-linebreak"
                          checked={autoLinebreak}
                          onCheckedChange={checked => setAutoLinebreak(checked === true)}
                        />
                        <Label htmlFor="auto-linebreak" className="cursor-pointer">
                          Auto linebreak
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            Prevent paragraphs from being split across pages
                          </p>
                        </Label>
                      </div>

                      <Separator />

                      <Button
                        onClick={handleDownloadPDF}
                        disabled={!pdfUrl}
                        className="w-full"
                      >
                        <FileDown className="mr-2 h-4 w-4" />
                        Download PDF
                      </Button>

                      <Separator />

                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsAdvancedExportOpen(prev => !prev)}
                        className="w-full justify-between"
                      >
                        <span className="text-sm">Advanced Export Tools</span>
                        {isAdvancedExportOpen ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>

                      {isAdvancedExportOpen && (
                        <div className="space-y-3 rounded-md border border-slate-200 dark:border-slate-700 p-3">
                          <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                            Google Docs / Word
                          </div>
                          <Button
                            onClick={handleDownloadDocx}
                            disabled={songs.length === 0}
                            className="w-full"
                          >
                            <FileType className="mr-2 h-4 w-4" />
                            Download Word Doc (.docx)
                          </Button>
                          <div className="text-xs text-slate-500 dark:text-slate-400 text-center">
                            Upload this file to Google Docs to preserve formatting
                          </div>
                          <Button
                            onClick={handleCopyToClipboard}
                            disabled={songs.length === 0}
                            variant="outline"
                            className="w-full"
                          >
                            {copySuccess ? (
                              <>
                                <Check className="mr-2 h-4 w-4" />
                                Copied to Clipboard!
                              </>
                            ) : (
                              <>
                                <Copy className="mr-2 h-4 w-4" />
                                Copy as Plain Text
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {workspaceTab === "editor" &&
            songs.length === 0 &&
            previewSongs.length === 0 &&
            !isLoading && (
            <Card className="border border-slate-200 dark:border-slate-800 shadow-md bg-slate-50 dark:bg-slate-900">
              <CardContent className="p-12">
                <div className="flex flex-col items-center justify-center text-center space-y-4">
                  <Music2 className="h-16 w-16 text-slate-300 dark:text-slate-700" />
                  <h3 className="text-xl font-medium text-slate-700 dark:text-slate-300">
                    Create your setlist
                  </h3>
                  <p className="text-slate-500 dark:text-slate-400 max-w-md">
                    Add multiple songs from Ultimate Guitar to create a combined
                    setlist. Each song can be transposed individually, and all
                    songs will be combined into one PDF document.
                  </p>
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
        <DialogContent className="flex items-center justify-center p-4">
          <Card className="w-full max-w-lg border border-slate-200 dark:border-slate-800 shadow-xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Publish Song</CardTitle>
              <CardDescription>
                Share this song to the public tab list.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="publish-song-title">Song name</Label>
                <Input
                  id="publish-song-title"
                  value={publishSongTitle}
                  onChange={event => setPublishSongTitle(event.target.value)}
                  placeholder="Song name"
                />
              </div>
              <div className="space-y-1">
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
                      Publish Song
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
            setPreviewPublicTab(null)
          }
        }}
      >
        <DialogContent className="flex items-center justify-center p-4">
          <Card className="w-full max-w-4xl border border-slate-200 dark:border-slate-800 shadow-xl">
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">
                {previewPublicTab?.setlistTitle || "Published Tab"}
              </CardTitle>
              <CardDescription>
                {previewPublicTab
                  ? `${previewPublicTab.publisherName} • ${new Date(previewPublicTab.publishedAt).toLocaleString()}`
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="max-h-[62vh] overflow-y-auto space-y-3 pr-1">
                {(previewPublicTab?.songs || []).map((song, index) => (
                  <div
                    key={`${previewPublicTab?.id || "preview"}-${index}`}
                    className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 p-3"
                  >
                    <div className="text-sm font-semibold">
                      {song.song} <span className="text-slate-500">• {song.artist}</span>
                    </div>
                    <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-700 dark:text-slate-300 font-mono">
                      {stripChordMarkup(song.transposedChords)}
                    </pre>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setPreviewPublicTab(null)}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    if (!previewPublicTab) return
                    addPublicTabToSetlist(previewPublicTab)
                  }}
                >
                  Add to Setlist
                </Button>
                {previewPublicTab && (
                  <Button
                    variant="outline"
                    onClick={() => deletePublicTab(previewPublicTab)}
                    disabled={
                      deletingTabId === previewPublicTab.id ||
                      !deletePassword.trim()
                    }
                    className="text-red-600 hover:text-red-700"
                    title={
                      deletePassword.trim()
                        ? "Delete tab"
                        : "Enter delete password in Published tab first"
                    }
                  >
                    {deletingTabId === previewPublicTab.id ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Deleting
                      </>
                    ) : (
                      <>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </>
                    )}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </DialogContent>
      </Dialog>

      <footer className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 py-6 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            tabs/chords downloader. Happy 20th, Justin.
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Made with ❤️ by Allen
          </p>
        </div>
      </footer>

      {pdfUrl && (
        <FullScreenPDFViewer
          pdfUrl={pdfUrl}
          isOpen={isFullScreen}
          onClose={() => setIsFullScreen(false)}
          title={songs.length === 1 ? songs[0].song : `Setlist (${songs.length} songs)`}
          subtitle={songs.length === 1 ? songs[0].artist : ""}
        />
      )}
    </div>
  )
}
