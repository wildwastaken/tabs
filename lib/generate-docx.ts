// lib/generate-docx.ts

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  PageBreak,
  UnderlineType,
  convertInchesToTwip,
} from "docx"
import type {
  ExportSettings,
  MonoFontOption,
  PositionedNoteBox,
} from "../types/setlist"
import { parseInlineMarkdown } from "./inline-markdown"

interface SongData {
  id: string
  uri: string
  artist: string
  song: string
  chords: string
  transposedChords: string
  transposeStep: number
}

interface DocxRenderSettings {
  monoFont: MonoFontOption
  noteBoxes: PositionedNoteBox[]
}

/**
 * Generates a Word document from multiple songs.
 */
export default async function generateDocx(
  songs: SongData[],
  fontSize: number,
  autoLinebreak = false,
  exportSettings?: Partial<ExportSettings>
): Promise<Blob> {
  if (songs.length === 0) {
    throw new Error("No songs to generate document from")
  }

  const settings = resolveDocxRenderSettings(exportSettings)
  const fontFamily = resolveDocxFontFamily(settings.monoFont)
  const paragraphs: Paragraph[] = []

  const pageHeight = 842
  const margin = 40
  const lineHeight = fontSize * 1.5

  for (let i = 0; i < songs.length; i += 1) {
    const song = songs[i]

    if (i > 0) {
      paragraphs.push(
        new Paragraph({
          children: [new PageBreak()],
        })
      )
    }

    let currentY = margin

    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: song.artist || "Unknown Artist",
            bold: true,
            size: (fontSize + 4) * 2,
            font: fontFamily,
          }),
        ],
        spacing: {
          after: Math.floor((fontSize + 8) * 20),
        },
      })
    )
    currentY += fontSize + 8

    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: song.song || "Untitled",
            bold: true,
            size: (fontSize + 2) * 2,
            font: fontFamily,
          }),
        ],
        spacing: {
          after: Math.floor((fontSize + 15) * 20),
        },
      })
    )
    currentY += fontSize + 15

    const formattedChords = song.transposedChords
      .replace(/\[tab\]/g, "")
      .replace(/\[\/tab\]/g, "")
      .replace(/\r\n/g, "\n")

    const lines = formattedChords.split("\n")

    const processedLines = autoLinebreak
      ? addParagraphBreaks(lines, pageHeight, margin, lineHeight, currentY)
      : lines

    for (const line of processedLines) {
      if (line === "__PAGE_BREAK__") {
        paragraphs.push(
          new Paragraph({
            children: [new PageBreak()],
          })
        )
        currentY = margin
        continue
      }

      if (currentY + lineHeight > pageHeight - margin) {
        paragraphs.push(
          new Paragraph({
            children: [new PageBreak()],
          })
        )
        currentY = margin
      }

      if (line.includes("[ch]") && line.includes("[/ch]")) {
        const segments = line.split(/(\[ch\][^\[]*\[\/ch\])/)
        const textRuns: TextRun[] = []

        for (const segment of segments) {
          if (!segment) continue

          if (segment.startsWith("[ch]") && segment.endsWith("[/ch]")) {
            const chordText = segment.substring(4, segment.length - 5)
            textRuns.push(...markdownRuns(chordText, fontFamily, fontSize * 2, true))
          } else {
            textRuns.push(...markdownRuns(segment, fontFamily, fontSize * 2, false))
          }
        }

        paragraphs.push(
          new Paragraph({
            children: textRuns,
            spacing: {
              after: 0,
              line: Math.floor(lineHeight * 20),
              lineRule: "exact",
            },
          })
        )
      } else {
        paragraphs.push(
          new Paragraph({
            children: markdownRuns(line, fontFamily, fontSize * 2, false),
            spacing: {
              after: 0,
              line: Math.floor(lineHeight * 20),
              lineRule: "exact",
            },
          })
        )
      }

      currentY += lineHeight
    }
  }

  if (settings.noteBoxes.length > 0) {
    paragraphs.push(
      new Paragraph({
        children: [new PageBreak()],
      })
    )

    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "PDF Note Boxes",
            bold: true,
            font: fontFamily,
            size: (fontSize + 2) * 2,
          }),
        ],
        spacing: { after: 180 },
      })
    )

    settings.noteBoxes
      .slice()
      .sort((a, b) => a.page - b.page)
      .forEach(noteBox => {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `Page ${noteBox.page} (${Math.round(noteBox.x * 100)}%, ${Math.round(noteBox.y * 100)}%)`,
                bold: true,
                font: fontFamily,
                size: fontSize * 2,
              }),
            ],
            spacing: { after: 80 },
          })
        )

        noteBox.text.split("\n").forEach(line => {
          paragraphs.push(
            new Paragraph({
              children: markdownRuns(line, fontFamily, fontSize * 2, false),
              spacing: {
                after: 0,
                line: Math.floor(lineHeight * 20),
                lineRule: "exact",
              },
            })
          )
        })

        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: "" })],
            spacing: { after: 120 },
          })
        )
      })
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(40 / 72),
              bottom: convertInchesToTwip(40 / 72),
              left: convertInchesToTwip(40 / 72),
              right: convertInchesToTwip(40 / 72),
            },
          },
        },
        children: paragraphs,
      },
    ],
  })

  return Packer.toBlob(doc)
}

function resolveDocxRenderSettings(
  input?: Partial<ExportSettings>
): DocxRenderSettings {
  return {
    monoFont: input?.monoFont || "roboto-mono",
    noteBoxes: Array.isArray(input?.noteBoxes) ? input.noteBoxes : [],
  }
}

function resolveDocxFontFamily(monoFont: MonoFontOption): string {
  switch (monoFont) {
    case "courier-new":
      return "Courier New"
    case "consolas":
      return "Consolas"
    case "menlo":
      return "Menlo"
    case "roboto-mono":
    default:
      return "Consolas"
  }
}

function markdownRuns(
  text: string,
  fontFamily: string,
  size: number,
  forceBold: boolean
): TextRun[] {
  const segments = parseInlineMarkdown(text)
  const runs: TextRun[] = []

  for (const segment of segments) {
    if (segment.text.length === 0) continue

    runs.push(
      new TextRun({
        text: segment.text,
        bold: forceBold || segment.bold,
        underline: segment.underline
          ? { type: UnderlineType.SINGLE }
          : undefined,
        font: fontFamily,
        size,
      })
    )
  }

  if (runs.length > 0) {
    return runs
  }

  return [
    new TextRun({
      text: "",
      font: fontFamily,
      size,
    }),
  ]
}

/**
 * Detect song sections and add page breaks to avoid splitting them across pages.
 */
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
