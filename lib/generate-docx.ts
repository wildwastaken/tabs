// lib/generate-docx.ts

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  PageBreak,
  convertInchesToTwip,
} from "docx"

interface SongData {
  id: string
  uri: string
  artist: string
  song: string
  chords: string
  transposedChords: string
  transposeStep: number
}

/**
 * Generates a Word document from multiple songs that matches PDF exactly
 * @param songs Array of song data
 * @param fontSize The font size to use (in points)
 * @param autoLinebreak Whether to prevent paragraphs from splitting across pages
 * @returns Promise with Blob
 */
export default async function generateDocx(
  songs: SongData[],
  fontSize: number,
  autoLinebreak = false
): Promise<Blob> {
  if (songs.length === 0) {
    throw new Error("No songs to generate document from")
  }

  const paragraphs: Paragraph[] = []

  // A4 dimensions in points (matching PDF)
  const pageHeight = 842 // A4 height in points
  const margin = 40 // Same as PDF
  const lineHeight = fontSize * 1.5 // Same as PDF

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i]

    // Add page break before each song except the first
    if (i > 0) {
      paragraphs.push(
        new Paragraph({
          children: [new PageBreak()],
        })
      )
    }

    // Track vertical position for this song (matching PDF's yPos logic)
    let currentY = margin

    // Add artist name (bold, larger) - matching PDF exactly
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: song.artist || "Unknown Artist",
            bold: true,
            size: (fontSize + 4) * 2, // Convert to half-points
            font: "Consolas", // Closest to RobotoMono on Windows/Mac
          }),
        ],
        spacing: {
          after: Math.floor((fontSize + 8) * 20), // Match PDF spacing
        },
      })
    )
    currentY += fontSize + 8

    // Add song title (bold, slightly larger) - matching PDF exactly
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: song.song || "Untitled",
            bold: true,
            size: (fontSize + 2) * 2,
            font: "Consolas",
          }),
        ],
        spacing: {
          after: Math.floor((fontSize + 15) * 20), // Match PDF spacing
        },
      })
    )
    currentY += fontSize + 15

    // Process the chord content - exactly like PDF
    const formattedChords = song.transposedChords
      .replace(/\[tab\]/g, "")
      .replace(/\[\/tab\]/g, "")
      .replace(/\r\n/g, "\n")

    const lines = formattedChords.split("\n")

    // Apply auto-linebreak if enabled (same logic as PDF)
    const processedLines = autoLinebreak
      ? addParagraphBreaks(lines, pageHeight, margin, lineHeight, currentY)
      : lines

    for (const line of processedLines) {
      // Check for forced page break marker
      if (line === "__PAGE_BREAK__") {
        paragraphs.push(
          new Paragraph({
            children: [new PageBreak()],
          })
        )
        currentY = margin // Reset position after page break
        continue
      }

      // Check if we need a new page (matching PDF logic at line 165)
      if (currentY + lineHeight > pageHeight - margin) {
        paragraphs.push(
          new Paragraph({
            children: [new PageBreak()],
          })
        )
        currentY = margin
      }

      if (line.includes("[ch]") && line.includes("[/ch]")) {
        // Line contains chords - parse and format them exactly like PDF
        const segments = line.split(/(\[ch\][^\[]*\[\/ch\])/)
        const textRuns: TextRun[] = []

        for (const segment of segments) {
          if (!segment) continue

          if (segment.startsWith("[ch]") && segment.endsWith("[/ch]")) {
            // This is a chord - extract and make it bold (matching PDF)
            const chordText = segment.substring(4, segment.length - 5)
            textRuns.push(
              new TextRun({
                text: chordText,
                bold: true,
                font: "Consolas",
                size: fontSize * 2,
              })
            )
          } else {
            // Regular text - preserve all spaces
            textRuns.push(
              new TextRun({
                text: segment,
                font: "Consolas",
                size: fontSize * 2,
              })
            )
          }
        }

        paragraphs.push(
          new Paragraph({
            children: textRuns,
            spacing: {
              after: 0,
              line: Math.floor(lineHeight * 20), // Exact line height from PDF
              lineRule: "exact",
            },
          })
        )
      } else {
        // Regular line without chords - preserve exact spacing
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line,
                font: "Consolas",
                size: fontSize * 2,
              }),
            ],
            spacing: {
              after: 0,
              line: Math.floor(lineHeight * 20),
              lineRule: "exact",
            },
          })
        )
      }

      // Move down by one line (matching PDF's yPos += lineHeight)
      currentY += lineHeight
    }
  }

  // Create the document with A4 page size and matching margins
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(40 / 72), // 40pt to inches to twips
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

  // Generate blob
  const blob = await Packer.toBlob(doc)
  return blob
}

/**
 * Detect song sections and add page breaks to avoid splitting them across pages
 * (Same logic as PDF generation)
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

  // Calculate how many lines are already used on the first page (accounting for header)
  const firstPageUsedLines = Math.ceil((startY - margin) / lineHeight)
  const firstPageAvailableLines = maxLinesPerPage - firstPageUsedLines

  // Helper function to detect if a line is a section header
  const isSectionHeader = (line: string): boolean => {
    const trimmed = line.trim()
    return (
      trimmed.startsWith("[") &&
      trimmed.endsWith("]") &&
      trimmed.length > 2 &&
      !trimmed.includes("[ch]")
    )
  }

  // Split content into sections
  const sections: string[][] = []
  let currentSection: string[] = []

  for (let i = 0; i < lines.length; i++) {
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

  // Process sections and add page breaks as needed (matching PDF logic exactly)
  let currentPageLines = 0
  let currentPageNumber = 1

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex]
    const sectionLines = section.length

    // Determine available lines on current page (matching PDF logic)
    const availableLinesOnCurrentPage =
      currentPageNumber === 1
        ? firstPageAvailableLines - currentPageLines
        : maxLinesPerPage - currentPageLines

    const sectionWouldBeSplit = sectionLines > availableLinesOnCurrentPage
    const sectionFitsOnNewPage = sectionLines <= maxLinesPerPage
    const minimumLinesToJustifyBreak = 3
    const wouldSaveEnoughLines = sectionLines >= minimumLinesToJustifyBreak

    if (
      sectionWouldBeSplit &&
      currentPageLines > 0 &&
      sectionFitsOnNewPage &&
      wouldSaveEnoughLines
    ) {
      processedLines.push("__PAGE_BREAK__")
      currentPageLines = 0
      currentPageNumber++
    }

    processedLines.push(...section)
    currentPageLines += sectionLines

    // Check if we've exceeded the page capacity (matching PDF logic)
    const currentPageCapacity =
      currentPageNumber === 1 ? firstPageAvailableLines : maxLinesPerPage

    if (currentPageLines >= currentPageCapacity) {
      currentPageLines = currentPageLines - currentPageCapacity
      currentPageNumber++

      while (currentPageLines >= maxLinesPerPage) {
        currentPageLines -= maxLinesPerPage
        currentPageNumber++
      }
    }
  }

  return processedLines
}
