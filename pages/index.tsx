"use client"

import { useState, useCallback, useEffect } from "react"
import { parse, transpose, prettyPrint } from "chord-magic"
import generatePDF from "../lib/generate-pdf"
import { Input } from "../components/ui/input"
import { Slider } from "../components/ui/slider"
// import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group"
// import { Checkbox } from "../components/ui/checkbox"
import { Label } from "../components/ui/label"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs"
import { Separator } from "../components/ui/separator"
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
} from "lucide-react"

const corsURI = 'https://api.codetabs.com/v1/proxy/?quest='

// Fix 1: Replace 'any' with proper type definitions
interface ObjectWithKey {
  [key: string]: unknown
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

export default function ChordTransposer() {
  const [uri, setUri] = useState("")
  const [chords, setChords] = useState("")
  const [artist, setArtist] = useState("")
  const [song, setSong] = useState("")
  // Define halftoneStyle constant since it's referenced but not defined
  const halftoneStyle = "FLATS" // Default value
  const [simplify] = useState(false)
  const [transposeStep, setTransposeStep] = useState(0)
  const [transposedChords, setTransposedChords] = useState("")
  const [fontSize, setFontSize] = useState(10)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("pdf")

  const loadSong = useCallback(async () => {
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

      setArtist(parsedArtistName || "Unknown Artist")
      setSong(parsedSongName || "Unknown Song")
      setChords(parsedChords)
      // setActiveTab("preview") - add back eventually
    } catch (err) {
      // Fix 4: Rename 'error' to 'err' to avoid name collision
      console.error("Failed to load song:", err)
      setError("Failed to load song. Please check the URL and try again.")
    } finally {
      setIsLoading(false)
    }
  }, [uri])

  useEffect(() => {
    if (uri && uri.includes("ultimate-guitar.com")) {
      setError(null)
    }
  }, [uri])

  useEffect(() => {
    const updatePDF = async () => {
      if (artist && song && transposedChords) {
        try {
          const { url, filename } = await generatePDF(artist, song, transposedChords, fontSize)
          setPdfUrl(`${url}#view=FitH&zoom=20&filename=${encodeURIComponent(`${filename} - ${artist}`)}`)
        } catch (err) {
          console.error("Failed to generate PDF:", err)
          setError("Failed to generate PDF preview")
        }
      }
    }

    if (transposedChords) {
      updatePDF()
    }
  }, [artist, song, transposedChords, fontSize])

  // Fix 5: Remove halftoneStyle from the dependency array
  useEffect(() => {
    if (!chords) return

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
          console.info("failed to transpose", chord)
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

    setTransposedChords(processedText)
  }, [transposeStep, chords, simplify]) // removed halftoneStyle from dependencies

  const handleDownloadPDF = () => {
    if (pdfUrl) {
      const a = document.createElement("a")
      a.href = pdfUrl
      a.download = `${artist} - ${song}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }

  const incrementTranspose = () => {
    setTransposeStep((prev) => Math.min(prev + 1, 12))
  }

  const decrementTranspose = () => {
    setTransposeStep((prev) => Math.max(prev - 1, -12))
  }

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      <header className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm">
        <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Music2 className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">tabs</h1>
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
                Download PDF
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
                <LinkIcon className="mr-2 h-5 w-5 text-primary" />
                Enter Ultimate Guitar URL
              </CardTitle>
              <CardDescription>Paste a link from Ultimate Guitar to transpose the chords</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-grow">
                  <Input
                    value={uri}
                    onChange={(e) => setUri(e.target.value)}
                    placeholder="https://tabs.ultimate-guitar.com/tab/..."
                    className="w-full"
                  />
                </div>
                <Button onClick={loadSong} disabled={isLoading || !uri} className="min-w-[120px]">
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading
                    </>
                  ) : (
                    "Load Song"
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

          {(artist || song) && (
            <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{song}</h2>
                <p className="text-lg text-slate-600 dark:text-slate-400">{artist}</p>
              </div>

              <Card className="w-full sm:w-auto border border-slate-200 dark:border-slate-800">
                <CardContent className="p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex flex-col items-center">
                      <div className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Transpose</div>
                      <div className="flex items-center">
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={decrementTranspose}
                          disabled={transposeStep <= -12}
                          className="h-8 w-8"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                        <div className="w-10 text-center font-mono font-bold text-primary">
                          {transposeStep > 0 ? `+${transposeStep}` : transposeStep}
                        </div>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={incrementTranspose}
                          disabled={transposeStep >= 12}
                          className="h-8 w-8"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <Separator orientation="vertical" className="h-12" />

                    <div className="flex flex-col items-center">
                      <div className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">Font Size</div>
                      <div className="flex items-center">
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setFontSize((prev) => Math.max(prev - 1, 6))}
                          disabled={fontSize <= 6}
                          className="h-8 w-8"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                        <div className="w-10 text-center font-mono font-bold text-primary">
                          {fontSize}pt
                        </div>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setFontSize((prev) => Math.min(prev + 1, 20))}
                          disabled={fontSize >= 20}
                          className="h-8 w-8"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {transposedChords && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2 border border-slate-200 dark:border-slate-800 shadow-md">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                  <CardHeader className="pb-0">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-xl flex items-center">
                        <Music className="mr-2 h-5 w-5 text-primary" />
                        Transposed Chords
                      </CardTitle>
                      <TabsList className="grid grid-cols-2 w-[200px]">
                        <TabsTrigger value="preview">Preview</TabsTrigger>
                        <TabsTrigger value="pdf">PDF</TabsTrigger>
                      </TabsList>
                    </div>
                  </CardHeader>

                  <CardContent className="pt-6">
                    <TabsContent value="preview" className="mt-0">
                      {/* Commenting out the preview tab as it's not very useful */}
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
                        <div className="relative">
                          <iframe
                            src={pdfUrl}
                            className="w-full h-[70vh] border border-slate-200 dark:border-slate-800 rounded-md"
                            title="PDF Preview"
                          />
                          {/* Commenting out the download button in the preview */}
                          {/* <div className="absolute bottom-4 right-4">
                            <Button onClick={handleDownloadPDF} className="shadow-lg">
                              <FileDown className="mr-2 h-4 w-4" />
                              Download PDF
                            </Button>
                          </div> */}
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
                      <ArrowUpDown className="mr-2 h-5 w-5 text-primary" />
                      Transpose Settings
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-6">
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <Label htmlFor="transpose-slider">
                            Transpose: {transposeStep > 0 ? `+${transposeStep}` : transposeStep}
                          </Label>
                          <span className="text-sm text-slate-500 dark:text-slate-400">
                            {transposeStep > 0 ? "Higher" : transposeStep < 0 ? "Lower" : "Original"}
                          </span>
                        </div>
                        <Slider
                          id="transpose-slider"
                          min={-12}
                          max={12}
                          step={1}
                          value={[transposeStep]}
                          onValueChange={(value) => setTransposeStep(value[0])}
                        />
                        <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
                          <span>-12</span>
                          <span>0</span>
                          <span>+12</span>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <Label htmlFor="font-size-slider">Font Size: {fontSize}pt</Label>
                          <span className="text-sm text-slate-500 dark:text-slate-400">
                            {fontSize < 9 ? "Small" : fontSize > 12 ? "Large" : "Medium"}
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
{/* 
                      <div className="flex items-center space-x-2 pt-2">
                        <Checkbox
                          id="simplify"
                          checked={simplify}
                          onCheckedChange={(checked) => setSimplify(checked === true)}
                        />
                        <Label htmlFor="simplify" className="cursor-pointer">
                          Simplify chords
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                            Remove extended, suspended, and added notes
                          </p>
                        </Label>
                      </div> */}
                    </div>
                  </CardContent>
                </Card>

                <Card className="border border-slate-200 dark:border-slate-800 shadow-md">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center">
                      <FileText className="mr-2 h-5 w-5 text-primary" />
                      PDF Options
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
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

          {!transposedChords && !isLoading && (
            <Card className="border border-slate-200 dark:border-slate-800 shadow-md bg-slate-50 dark:bg-slate-900">
              <CardContent className="p-12">
                <div className="flex flex-col items-center justify-center text-center space-y-4">
                  <Music2 className="h-16 w-16 text-slate-300 dark:text-slate-700" />
                  <h3 className="text-xl font-medium text-slate-700 dark:text-slate-300">
                    Paste an Ultimate Guitar URL to get started
                  </h3>
                  <p className="text-slate-500 dark:text-slate-400 max-w-md">
                    Enter a URL from Ultimate Guitar to load chord charts. You can then transpose, customize, and
                    download them as a PDF.
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
            tabs downloader
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Made with ❤️ by Allen
          </p>
        </div>
      </footer>
    </div>
  )
}