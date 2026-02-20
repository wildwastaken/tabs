// lib/generate-pdf.ts

import type { jsPDF } from "jspdf"
import type {
  ExportSettings,
  MonoFontOption,
  PositionedNoteBox,
} from "../types/setlist"
import { parseInlineMarkdown } from "./inline-markdown"
import vfsFonts from "./vfs_fonts"

interface SongData {
  id: string
  uri: string
  artist: string
  song: string
  chords: string
  transposedChords: string
  transposeStep: number
}

interface PdfRenderSettings {
  monoFont: MonoFontOption
  noteBoxes: PositionedNoteBox[]
}

interface TextRenderBounds {
  left: number
  right: number
  bottom: number
  lineHeight: number
  fontFamily: string
  onPageBreak?: () => void
}

interface CursorPosition {
  x: number
  y: number
}

/**
 * Generates a PDF from multiple songs using jsPDF.
 */
export default async function generatePDF(
  songs: SongData[],
  fontSize: number,
  autoLinebreak = false,
  exportSettings?: Partial<ExportSettings>
): Promise<{ dataUrl: string; filename: string }> {
  try {
    if (songs.length === 0) {
      throw new Error("No songs to generate PDF from")
    }

    const settings = resolvePdfRenderSettings(exportSettings)

    const jsPDFModule = await import("jspdf")
    const jsPDF = jsPDFModule.default || jsPDFModule

    const doc = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: "a4",
    })

    let hasRobotoMono = false
    if (settings.monoFont === "roboto-mono") {
      hasRobotoMono = loadRobotoMonoFonts(doc)
    }

    const pdfFontFamily = resolvePdfFontFamily(settings.monoFont, hasRobotoMono)

    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const margin = 40
    const lineHeight = fontSize * 1.5

    for (let i = 0; i < songs.length; i += 1) {
      const songData = songs[i]

      if (i > 0) {
        doc.addPage()
      }

      let yPos = margin

      doc.setFontSize(fontSize + 4)
      doc.setFont(pdfFontFamily, "bold")
      drawStyledText(doc, songData.artist || "Unknown Artist", margin, yPos, false)
      yPos += fontSize + 8

      doc.setFontSize(fontSize + 2)
      drawStyledText(doc, songData.song || "Untitled", margin, yPos, false)
      yPos += fontSize + 15

      doc.setFontSize(fontSize)
      doc.setFont(pdfFontFamily, "normal")

      const formattedChords = songData.transposedChords
        .replace(/\[tab\]/g, "")
        .replace(/\[\/tab\]/g, "")
        .replace(/\r\n/g, "\n")

      processChordContent(
        doc,
        formattedChords,
        {
          left: margin,
          right: pageWidth - margin,
          bottom: pageHeight - margin,
          lineHeight,
          fontFamily: pdfFontFamily,
        },
        yPos,
        pageHeight,
        autoLinebreak
      )
    }

    drawPositionedNoteBoxes(doc, settings.noteBoxes, {
      pageWidth,
      pageHeight,
      margin,
      fontFamily: pdfFontFamily,
      fontSize,
    })

    const dataUrl = doc.output("datauristring")

    const filename =
      songs.length === 1
        ? `${songs[0].artist.replace(/[^\w\s-]/g, "")} - ${songs[0].song.replace(/[^\w\s-]/g, "")}.pdf`
        : `Setlist - ${songs.length} songs.pdf`

    return { dataUrl, filename }
  } catch (error: unknown) {
    console.error("PDF generation error:", error)
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error"
    throw new Error(`Failed to generate PDF: ${errorMessage}`)
  }
}

function resolvePdfRenderSettings(
  input?: Partial<ExportSettings>
): PdfRenderSettings {
  return {
    monoFont: input?.monoFont || "roboto-mono",
    noteBoxes: Array.isArray(input?.noteBoxes) ? input.noteBoxes : [],
  }
}

function resolvePdfFontFamily(
  monoFont: MonoFontOption,
  hasRobotoMono: boolean
): string {
  if (monoFont === "roboto-mono") {
    return hasRobotoMono ? "RobotoMono" : "courier"
  }

  // jsPDF only ships with Courier/Helvetica/Times families.
  return "courier"
}

function processChordContent(
  doc: jsPDF,
  content: string,
  bounds: TextRenderBounds,
  startY: number,
  pageHeight: number,
  autoLinebreak: boolean
): void {
  const lines = content.split("\n")
  const processedLines = autoLinebreak
    ? addParagraphBreaks(lines, pageHeight, bounds.left, bounds.lineHeight, startY)
    : lines

  const cursor: CursorPosition = {
    x: bounds.left,
    y: startY,
  }

  for (let i = 0; i < processedLines.length; i += 1) {
    const line = processedLines[i]

    if (line === "__PAGE_BREAK__") {
      doc.addPage()
      bounds.onPageBreak?.()
      cursor.x = bounds.left
      cursor.y = bounds.left
      continue
    }

    if (cursor.y + bounds.lineHeight > bounds.bottom) {
      doc.addPage()
      bounds.onPageBreak?.()
      cursor.x = bounds.left
      cursor.y = bounds.left
    }

    if (line.includes("[ch]") && line.includes("[/ch]")) {
      const segments = line.split(/(\[ch\][^\[]*\[\/ch\])/g)

      for (let j = 0; j < segments.length; j += 1) {
        const segment = segments[j]
        if (!segment) continue

        const isChordSegment =
          segment.startsWith("[ch]") && segment.endsWith("[/ch]")
        const rawText = isChordSegment
          ? segment.substring(4, segment.length - 5)
          : segment

        renderMarkdownTextInline(
          doc,
          rawText,
          cursor,
          bounds,
          isChordSegment
        )
      }
    } else {
      renderMarkdownTextInline(doc, line, cursor, bounds, false)
    }

    cursor.y += bounds.lineHeight
    cursor.x = bounds.left
  }
}

function renderMarkdownTextInline(
  doc: jsPDF,
  text: string,
  cursor: CursorPosition,
  bounds: TextRenderBounds,
  forceBold: boolean
): void {
  const markdownSegments = parseInlineMarkdown(text)

  for (let i = 0; i < markdownSegments.length; i += 1) {
    const segment = markdownSegments[i]
    const useBold = forceBold || segment.bold

    doc.setFont(bounds.fontFamily, useBold ? "bold" : "normal")

    for (let j = 0; j < segment.text.length; j += 1) {
      const char = segment.text[j]
      const charWidth = doc.getTextWidth(char)

      if (cursor.x + charWidth > bounds.right) {
        cursor.y += bounds.lineHeight
        cursor.x = bounds.left
      }

      drawStyledText(doc, char, cursor.x, cursor.y, segment.underline)
      cursor.x += charWidth
    }
  }
}

function drawStyledText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  underline: boolean
): void {
  doc.text(text, x, y)

  if (!underline || !text || text.trim().length === 0) return

  const textWidth = doc.getTextWidth(text)
  if (textWidth <= 0) return

  const underlineY = y + 1.5
  doc.line(x, underlineY, x + textWidth, underlineY)
}

function drawPositionedNoteBoxes(
  doc: jsPDF,
  noteBoxes: PositionedNoteBox[],
  config: {
    pageWidth: number
    pageHeight: number
    margin: number
    fontFamily: string
    fontSize: number
  }
): void {
  if (noteBoxes.length === 0) return

  const totalPages = doc.getNumberOfPages()
  const usableWidth = config.pageWidth - config.margin * 2
  const usableHeight = config.pageHeight - config.margin * 2

  for (let i = 0; i < noteBoxes.length; i += 1) {
    const noteBox = noteBoxes[i]
    if (noteBox.page < 1 || noteBox.page > totalPages) continue

    doc.setPage(noteBox.page)

    const x = config.margin + usableWidth * noteBox.x
    const y = config.margin + usableHeight * noteBox.y
    const width = Math.max(usableWidth * noteBox.width, 24)
    const height = Math.max(usableHeight * noteBox.height, 18)

    doc.setLineWidth(0.5)
    doc.roundedRect(x, y, width, height, 4, 4)

    doc.setFont(config.fontFamily, "normal")
    doc.setFontSize(Math.max(config.fontSize - 1, 8))

    const left = x + 6
    const right = x + width - 6
    const bottom = y + height - 6
    const lineHeight = Math.max(config.fontSize * 1.2, 10)

    const cursor: CursorPosition = {
      x: left,
      y: y + 12,
    }

    const lines = noteBox.text.replace(/\r\n/g, "\n").split("\n")

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      if (cursor.y > bottom) break

      renderMarkdownTextInline(
        doc,
        line,
        cursor,
        {
          left,
          right,
          bottom,
          lineHeight,
          fontFamily: config.fontFamily,
        },
        false
      )

      cursor.x = left
      cursor.y += lineHeight
    }
  }
}

function addParagraphBreaks(
  lines: string[],
  pageHeight: number,
  margin: number,
  lineHeight: number,
  startY: number
): string[] {
  const processedLines: string[] = []

  const usableHeight = pageHeight - margin * 2
  const maxLinesPerPage = Math.floor(usableHeight / lineHeight)

  const firstPageUsedLines = Math.ceil((startY - margin) / lineHeight)
  const firstPageAvailableLines = maxLinesPerPage - firstPageUsedLines

  const isSectionHeader = (line: string): boolean => {
    const trimmed = line.trim()
    return (
      trimmed.startsWith("[") &&
      trimmed.endsWith("]") &&
      trimmed.length > 2 &&
      !trimmed.includes("[ch]")
    )
  }

  const sections: string[][] = []
  let currentSection: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const isHeader = isSectionHeader(line)
    const isEmptyLine = line.trim() === ""
    const nextIsHeader = i < lines.length - 1 && isSectionHeader(lines[i + 1])

    if (isHeader && currentSection.length > 0) {
      sections.push([...currentSection])
      currentSection = [line]
    } else if (isEmptyLine && nextIsHeader && currentSection.length > 0) {
      currentSection.push(line)
      sections.push([...currentSection])
      currentSection = []
    } else if (
      isEmptyLine &&
      currentSection.length > 0 &&
      i > 0 &&
      lines[i - 1].trim() !== ""
    ) {
      currentSection.push(line)
      if (
        i === lines.length - 1 ||
        (i < lines.length - 1 && lines[i + 1].trim() === "")
      ) {
        sections.push([...currentSection])
        currentSection = []
      }
    } else if (line.trim() !== "" || currentSection.length > 0) {
      currentSection.push(line)
    }
  }

  if (currentSection.length > 0) {
    sections.push(currentSection)
  }

  let currentPageLines = 0
  let currentPageNumber = 1

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex]
    const sectionLines = section.length

    const availableLinesOnCurrentPage =
      currentPageNumber === 1
        ? firstPageAvailableLines - currentPageLines
        : maxLinesPerPage - currentPageLines

    const sectionWouldBeSplit = sectionLines > availableLinesOnCurrentPage
    const sectionFitsOnNewPage = sectionLines <= maxLinesPerPage

    if (sectionWouldBeSplit && currentPageLines > 0 && sectionFitsOnNewPage) {
      processedLines.push("__PAGE_BREAK__")
      currentPageLines = 0
      currentPageNumber += 1
    }

    processedLines.push(...section)
    currentPageLines += sectionLines

    const currentPageCapacity =
      currentPageNumber === 1 ? firstPageAvailableLines : maxLinesPerPage

    if (currentPageLines >= currentPageCapacity) {
      currentPageLines = currentPageLines - currentPageCapacity
      currentPageNumber += 1

      while (currentPageLines >= maxLinesPerPage) {
        currentPageLines -= maxLinesPerPage
        currentPageNumber += 1
      }
    }
  }

  return processedLines
}

function loadRobotoMonoFonts(doc: jsPDF): boolean {
  try {
    const vfs = (vfsFonts as { pdfMake?: { vfs?: Record<string, string> } })
      ?.pdfMake?.vfs

    const regular = vfs?.["RobotoMono-Regular.ttf"]
    const bold = vfs?.["RobotoMono-Bold.ttf"]

    if (!regular || !bold) {
      return false
    }

    doc.addFileToVFS("RobotoMono-Regular.ttf", regular)
    doc.addFileToVFS("RobotoMono-Bold.ttf", bold)

    doc.addFont("RobotoMono-Regular.ttf", "RobotoMono", "normal")
    doc.addFont("RobotoMono-Bold.ttf", "RobotoMono", "bold")

    return true
  } catch (error) {
    console.error("Failed to load bundled RobotoMono fonts:", error)
    return false
  }
}
