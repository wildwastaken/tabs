"use client"

import { useState, useCallback, useEffect } from "react"
import { parse, transpose, prettyPrint } from "chord-magic"
import generatePDF from "../lib/generate-pdf"
import generateDocx from "../lib/generate-docx"
import { Input } from "../components/ui/input"
import { Slider } from "../components/ui/slider"
// import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group"
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
import { FullScreenPDFViewer } from "../components/FullScreenPDFViewer"
import {
  Music,
  FileText,
  LinkIcon,
  ArrowUpDown,
  FileDown,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Music2,
  Maximize,
  Plus,
  Trash2,
  GripVertical,
  List,
  Copy,
  Check,
  FileType,
  Library,
  Search,
  X,
} from "lucide-react"

const corsURI = "https://api.codetabs.com/v1/proxy/?quest="

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

function findInObject(obj: ObjectWithKey, key: string): unknown[] {
  let objects: unknown[] = []
  const keys = Object.keys(obj || {})
  for (let i = 0; i < keys.length; i += 1) {
    const _key = keys[i]
    if (Object.prototype.hasOwnProperty.call(obj, _key)) {
      if (typeof obj[_key] === "object" && obj[_key] !== null) {
        // Ensure we're only recursing into objects
        objects = [...objects, ...findInObject(obj[_key] as ObjectWithKey, key)]
      } else if (_key === key) {
        objects.push(obj[_key])
      }
    }
  }
  return objects
}

interface SavedSong {
  uri: string
  artist: string
  song: string
  addedAt: number
}

export default function ChordTransposer() {
  // Multi-song state
  const [songs, setSongs] = useState<SongData[]>([])
  const [currentUri, setCurrentUri] = useState("")

  // Song library state
  const [savedSongs, setSavedSongs] = useState<SavedSong[]>([])
  const [librarySearch, setLibrarySearch] = useState("")

  // Define halftoneStyle constant since it's referenced but not defined
  const halftoneStyle = "FLATS" // Default value
  const [simplify] = useState(false) // Hard-coded for demonstration
  const [fontSize, setFontSize] = useState(10)
  const [autoLinebreak, setAutoLinebreak] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("pdf")
  const [isFullScreen, setIsFullScreen] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)

  // Load saved songs from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('savedSongs')
    if (saved) {
      try {
        setSavedSongs(JSON.parse(saved))
      } catch (err) {
        console.error('Failed to load saved songs:', err)
      }
    }
  }, [])

  // Save to library function
  const saveToLibrary = useCallback((uri: string, artist: string, song: string) => {
    setSavedSongs((prev) => {
      // Check if song already exists (by URI)
      if (prev.some(s => s.uri === uri)) {
        return prev
      }

      const newSong: SavedSong = {
        uri,
        artist,
        song,
        addedAt: Date.now(),
      }

      const updated = [...prev, newSong]
      localStorage.setItem('savedSongs', JSON.stringify(updated))
      return updated
    })
  }, [])

  // Clear library function
  const clearLibrary = useCallback(() => {
    setSavedSongs([])
    localStorage.removeItem('savedSongs')
  }, [])

  const addSong = useCallback(async (urlToAdd?: string) => {
    const uri = urlToAdd || currentUri
    if (!uri.includes("ultimate-guitar.com")) {
      setError("Please enter a valid Ultimate Guitar URL")
      return
    }

    setError(null)
    setIsLoading(true)

    try {
      const res = await fetch(`${corsURI}${uri}`)

      if (!res.ok) {
        throw new Error("Failed to fetch song data")
      }

      const text = await res.text()
      const div = document.createElement("div")
      div.innerHTML = text

      const store = div.getElementsByClassName("js-store")[0]
      const storeJson = store?.getAttribute("data-content") || ""

      if (!storeJson) {
        throw new Error("Could not find song data on the page")
      }

      const storeData = JSON.parse(storeJson)

      const [parsedSongName] = findInObject(storeData, "song_name") as string[]
      const [parsedArtistName] = findInObject(storeData, "artist_name") as string[]
      const [parsedChords] = findInObject(storeData, "content") as string[]

      if (!parsedChords) {
        throw new Error("No chord data found")
      }

      const artist = parsedArtistName || "Unknown Artist"
      const songName = parsedSongName || "Unknown Song"

      const newSong: SongData = {
        id: Date.now().toString(),
        uri,
        artist,
        song: songName,
        chords: parsedChords,
        transposedChords: parsedChords, // Will be updated by transpose effect
        transposeStep: 0,
      }

      setSongs((prev) => [...prev, newSong])

      // Save to library
      saveToLibrary(uri, artist, songName)

      setCurrentUri("") // Clear input after adding
      setActiveTab("pdf") // Switch to PDF view
    } catch (err) {
      console.error("Failed to load song:", err)
      setError("Failed to load song. Please check the URL and try again.")
    } finally {
      setIsLoading(false)
    }
  }, [currentUri, saveToLibrary])

  const addFromLibrary = useCallback(async (saved: SavedSong) => {
  // Re-use existing addSong flow (URL validation, fetch via proxy, parsing, etc.)
  // but without touching the input box
  try {
    await addSong(saved.uri)
  } catch (err) {
    console.error("Failed to add from library:", err)
    setError("Failed to add song from library")
  }
}, [addSong])

  useEffect(() => {
    if (currentUri && currentUri.includes("ultimate-guitar.com")) {
      setError(null)
    }
  }, [currentUri])

  const removeSong = useCallback((id: string) => {
    setSongs((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const moveSongUp = useCallback((index: number) => {
    if (index === 0) return
    setSongs((prev) => {
      const newSongs = [...prev]
      ;[newSongs[index - 1], newSongs[index]] = [newSongs[index], newSongs[index - 1]]
      return newSongs
    })
  }, [])

  const moveSongDown = useCallback((index: number) => {
    setSongs((prev) => {
      if (index === prev.length - 1) return prev
      const newSongs = [...prev]
      ;[newSongs[index], newSongs[index + 1]] = [newSongs[index + 1], newSongs[index]]
      return newSongs
    })
  }, [])

  const updateTranspose = useCallback((id: string, step: number) => {
    setSongs((prev) =>
      prev.map((s) => (s.id === id ? { ...s, transposeStep: step } : s))
    )
  }, [])

  // Keyboard shortcut for fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && pdfUrl && activeTab === 'pdf') {
        // Make sure we're not in an input field
        const activeElement = document.activeElement
        if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
          return
        }
        e.preventDefault()
        setIsFullScreen(true)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [pdfUrl, activeTab])

  // Transpose all songs when their transposeStep changes
  useEffect(() => {
    const transposeSong = (chords: string, transposeStep: number): string => {
      if (!chords) return ""

      const parseOptions = {}
      const transChords: string[] = chords.split(/\[ch\]|\[\/ch\]/g)
      let regex: string[] = []

      for (let i = 1; i < transChords.length; i += 2) {
        const chord = transChords[i]
        if (chord) {
          try {
            let tones = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]
            if (halftoneStyle === "FLATS") {
              tones = ["A", "Bb", "B", "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab"]
            }

            const parsedChord = parse(chord, parseOptions)
            const transChord = transpose(parsedChord, transposeStep)

            if (simplify) {
              delete transChord.extended
              delete transChord.suspended
              delete transChord.added
              delete transChord.overridingRoot
            }

            const prettyChord = prettyPrint(parsedChord, { naming: tones })
            const prettyTransChord = prettyPrint(transChord, { naming: tones })

            const chordsDiff = prettyTransChord.length - prettyChord.length
            const chordsDiffPos = Math.abs(chordsDiff)
            const replacer = chordsDiff >= 0 ? "-".repeat(chordsDiff) : " ".repeat(chordsDiffPos)

            transChords[i] = `[ch]${prettyTransChord}[/ch]`
            transChords[i] += replacer

            if (chordsDiff >= 0) {
              regex.push(replacer + " ".repeat(chordsDiff))
            }
          } catch (err) {
            console.error("Failed to transpose:", err)
            console.info("Failed to transpose", chord)
          }
        }
      }

      regex = [...new Set(regex.filter((r) => r.length > 1))]
      const processedText = transChords
        .join("")
        .replace(new RegExp(regex.join("|"), "gm"), "")
        .replace(/-+(\n|\r|\S)/gm, "$1")
        .replace(/\[\/ch\]\s\[ch\]/g, "[/ch]  [ch]")
        .replace(/\[\/ch\]\[ch\]/g, "[/ch] [ch]")
        .replace(/\[\/ch\](\w)/g, "[/ch] $1")

      return processedText
    }

    // Update transposed chords for all songs
    setSongs((prev) =>
      prev.map((song) => ({
        ...song,
        transposedChords: transposeSong(song.chords, song.transposeStep),
      }))
    )
  }, [songs.map(s => s.chords + s.transposeStep).join(','), simplify, halftoneStyle])

  // Generate PDF whenever songs, fontSize, or autoLinebreak changes
  useEffect(() => {
    const updatePDF = async () => {
      if (songs.length === 0) {
        setPdfUrl(null)
        return
      }

      try {
        const { dataUrl } = await generatePDF(
          songs,
          fontSize,
          autoLinebreak
        )
        setPdfUrl(dataUrl)
      } catch (err) {
        console.error("Failed to generate PDF:", err)
        setError("Failed to generate PDF preview")
      }
    }

    updatePDF()
  }, [songs, fontSize, autoLinebreak])

  const handleDownloadPDF = () => {
    if (pdfUrl) {
      const a = document.createElement("a")
      a.href = pdfUrl
      const filename = songs.length === 1
        ? `${songs[0].artist} - ${songs[0].song}.pdf`
        : `Setlist - ${songs.length} songs.pdf`
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }

  const handleCopyToClipboard = async () => {
    if (songs.length === 0) return

    try {
      // Format all songs as plain text
      const formattedText = songs
        .map((song, index) => {
          // Add song header
          let text = `${song.artist}\n${song.song}\n`

          // Add transpose info if not original key
          if (song.transposeStep !== 0) {
            text += `(Transposed ${song.transposeStep > 0 ? '+' : ''}${song.transposeStep})\n`
          }

          text += '\n'

          // Remove [ch] tags but keep the chord text
          const cleanedChords = song.transposedChords
            .replace(/\[ch\]/g, '')
            .replace(/\[\/ch\]/g, '')
            .replace(/\[tab\]/g, '')
            .replace(/\[\/tab\]/g, '')

          text += cleanedChords

          // Add page break indicator between songs (except after last song)
          if (index < songs.length - 1) {
            text += '\n\n' + '='.repeat(60) + '\n\n'
          }

          return text
        })
        .join('')

      // Copy to clipboard
      await navigator.clipboard.writeText(formattedText)

      // Show success feedback
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
      setError('Failed to copy to clipboard')
      setTimeout(() => setError(null), 3000)
    }
  }

  const handleDownloadDocx = async () => {
    if (songs.length === 0) return

    try {
      const blob = await generateDocx(songs, fontSize, autoLinebreak)

      // Create download link
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const filename = songs.length === 1
        ? `${songs[0].artist} - ${songs[0].song}.docx`
        : `Setlist - ${songs.length} songs.docx`
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to generate Word document:', err)
      setError('Failed to generate Word document')
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
                  ({songs.length} {songs.length === 1 ? 'song' : 'songs'})
                </span>
              )}
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadDocx}
                disabled={songs.length === 0}
                className="hidden md:flex"
              >
                <FileType className="mr-2 h-4 w-4" />
                Word Doc
              </Button>
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
          <Card className="mb-6 border border-slate-200 dark:border-slate-800 shadow-md">
            <CardHeader className="pb-3">
              <CardTitle className="text-xl flex items-center">
                <Plus className="mr-2 h-5 w-5 text-primary" />
                Add Song to Setlist
              </CardTitle>
              <CardDescription>
                Paste a link from Ultimate Guitar to add it to your setlist
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-grow">
                  <Input
                    value={currentUri}
                    onChange={(e) => setCurrentUri(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && currentUri && !isLoading) {
                        e.preventDefault();
                        addSong();
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

              {error && (
                <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-md flex items-start">
                  <AlertCircle className="h-5 w-5 mr-2 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </CardContent>
          </Card>
{/*           
          Song Library commented out for now
          {savedSongs.length > 0 && (
            <Card className="mb-6 border border-slate-200 dark:border-slate-800 shadow-md">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg flex items-center">
                      <Library className="mr-2 h-5 w-5 text-primary" />
                      Song Library ({savedSongs.length} {savedSongs.length === 1 ? 'song' : 'songs'})
                    </CardTitle>
                    <CardDescription>
                      Your saved songs - click to add to setlist
                    </CardDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearLibrary}
                    className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear Library
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <Input
                      value={librarySearch}
                      onChange={(e) => setLibrarySearch(e.target.value)}
                      placeholder="Search songs or artists..."
                      className="pl-10 pr-10"
                    />
                    {librarySearch && (
                      <button
                        onClick={() => setLibrarySearch('')}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {savedSongs
                    .filter(
                      (s) =>
                        s.song.toLowerCase().includes(librarySearch.toLowerCase()) ||
                        s.artist.toLowerCase().includes(librarySearch.toLowerCase())
                    )
                    .sort((a, b) => b.addedAt - a.addedAt)
                    .map((savedSong) => (
                      <div
                        key={savedSong.uri}
                        className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                      >
                        <div className="flex-grow min-w-0 mr-3">
                          <div className="font-semibold text-sm truncate">
                            {savedSong.song}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {savedSong.artist}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => addFromLibrary(savedSong)}
                          disabled={isLoading}
                        >
                          <Plus className="mr-1 h-3 w-3" />
                          Add
                        </Button>
                      </div>
                    ))}
                </div>

                {librarySearch && savedSongs.filter(
                  (s) =>
                    s.song.toLowerCase().includes(librarySearch.toLowerCase()) ||
                    s.artist.toLowerCase().includes(librarySearch.toLowerCase())
                ).length === 0 && (
                  <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                    No songs found matching "{librarySearch}"
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          */}

          {songs.length > 0 && (
            <Card className="mb-6 border border-slate-200 dark:border-slate-800 shadow-md">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center">
                  <List className="mr-2 h-5 w-5 text-primary" />
                  Setlist ({songs.length} {songs.length === 1 ? 'song' : 'songs'})
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
                            updateTranspose(songData.id, Math.max(songData.transposeStep - 1, -12))
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
                            updateTranspose(songData.id, Math.min(songData.transposeStep + 1, 12))
                          }
                          disabled={songData.transposeStep >= 12}
                          className="h-7 w-7"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeSong(songData.id)}
                        className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {songs.length > 0 && (
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
                        {pdfUrl && activeTab === 'pdf' && (
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
                    <TabsContent value="preview" className="mt-0">
                      {/* 
                        You can show a textual or HTML preview here if you want.
                        Uncomment the lines below if you'd like a chords preview tab.
                      */}
                      {/* <div className="bg-white dark:bg-slate-950 rounded-md border border-slate-200 dark:border-slate-800 p-4 font-mono whitespace-pre-wrap overflow-auto max-h-[70vh]">
                        <div className="text-xl font-bold mb-1">{artist}</div>
                        <div className="text-lg font-bold mb-4">{song}</div>
                        <div
                          dangerouslySetInnerHTML={{
                            __html: transposedChords
                              .replace(
                                /\[ch\]/g,
                                '<span class="inline-block bg-primary/10 text-primary font-bold px-1 rounded">',
                              )
                              .replace(/\[\/ch\]/g, "</span>"),
                          }}
                        />
                      </div> */}
                    </TabsContent>

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

              <div className="space-y-6">
                <Card className="border border-slate-200 dark:border-slate-800 shadow-md">
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
                          <Label htmlFor="font-size-slider">
                            Font Size: {fontSize}pt
                          </Label>
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
                          onValueChange={(value) => setFontSize(value[0])}
                        />
                        <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
                          <span>6pt</span>
                          <span>13pt</span>
                          <span>20pt</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border border-slate-200 dark:border-slate-800 shadow-md">
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
                          onCheckedChange={(checked) => setAutoLinebreak(checked === true)}
                        />
                        <Label htmlFor="auto-linebreak" className="cursor-pointer">
                          Auto linebreak
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            Prevent paragraphs from being split across pages
                          </p>
                        </Label>
                      </div>

                      <Separator />

                      <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                        Export for Google Docs / Word
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

                      <Separator />

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

                      <Separator />

                      <Button onClick={handleDownloadPDF} disabled={!pdfUrl} className="w-full">
                        <FileDown className="mr-2 h-4 w-4" />
                        Download PDF
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {songs.length === 0 && !isLoading && (
            <Card className="border border-slate-200 dark:border-slate-800 shadow-md bg-slate-50 dark:bg-slate-900">
              <CardContent className="p-12">
                <div className="flex flex-col items-center justify-center text-center space-y-4">
                  <Music2 className="h-16 w-16 text-slate-300 dark:text-slate-700" />
                  <h3 className="text-xl font-medium text-slate-700 dark:text-slate-300">
                    Create your setlist
                  </h3>
                  <p className="text-slate-500 dark:text-slate-400 max-w-md">
                    Add multiple songs from Ultimate Guitar to create a combined setlist.
                    Each song can be transposed individually, and all songs will be combined
                    into one PDF document.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

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

      {/* Full Screen PDF Viewer */}
      {pdfUrl && (
        <FullScreenPDFViewer
          pdfUrl={pdfUrl}
          isOpen={isFullScreen}
          onClose={() => setIsFullScreen(false)}
          title={songs.length === 1 ? songs[0].song : `Setlist (${songs.length} songs)`}
          subtitle={songs.length === 1 ? songs[0].artist : ''}
        />
      )}
    </div>
  )
}
