// lib/generate-pdf.ts

import type { jsPDF } from "jspdf";

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
 * Generates a PDF from multiple songs using jsPDF
 * @param songs Array of song data
 * @param fontSize The font size to use
 * @param autoLinebreak Whether to prevent paragraphs from splitting across pages
 * @returns Promise with dataUrl and filename
 */
export default async function generatePDF(
  songs: SongData[],
  fontSize: number,
  autoLinebreak = false,
): Promise<{ dataUrl: string; filename: string }> {
  try {
    if (songs.length === 0) {
      throw new Error("No songs to generate PDF from");
    }

    // Dynamically import jsPDF to ensure it only runs in browser
    const jsPDFModule = await import("jspdf");
    const jsPDF = jsPDFModule.default || jsPDFModule;

    // Create a new PDF document
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: "a4",
    });

    // Load the monospace font - crucial for proper tab spacing
    await loadFonts(doc);

    // PDF dimensions
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;

    // Line height for text
    const lineHeight = fontSize * 1.5;

    // Process each song
    for (let i = 0; i < songs.length; i++) {
      const songData = songs[i];

      // Add new page for songs after the first
      if (i > 0) {
        doc.addPage();
      }

      // Set starting position for this song
      let yPos = margin;

      // Add title and artist
      doc.setFontSize(fontSize + 4);
      doc.setFont("RobotoMono", "bold");
      const artistText = songData.artist || "Unknown Artist";
      doc.text(artistText, margin, yPos);
      yPos += fontSize + 8;

      doc.setFontSize(fontSize + 2);
      const songText = songData.song || "Untitled";
      doc.text(songText, margin, yPos);
      yPos += fontSize + 15;

      // Set font size for chord content
      doc.setFontSize(fontSize);
      doc.setFont("RobotoMono", "normal");

      // Clean up the chord content but preserve all spaces
      // This is critical for properly displaying tablature formatting
      const formattedChords = songData.transposedChords
        .replace(/\[tab\]/g, "")
        .replace(/\[\/tab\]/g, "")
        .replace(/\r\n/g, "\n"); // Normalize line endings

      // Process the full content with chord tags
      processChordContent(
        doc,
        formattedChords,
        margin,
        yPos,
        pageWidth,
        pageHeight,
        lineHeight,
        autoLinebreak,
      );
    }

    // Generate the PDF as data URL with proper error handling
    const dataUrl = doc.output("datauristring");

    // Generate filename based on number of songs
    const filename = songs.length === 1
      ? `${songs[0].artist.replace(/[^\w\s-]/g, "")} - ${songs[0].song.replace(/[^\w\s-]/g, "")}.pdf`
      : `Setlist - ${songs.length} songs.pdf`;

    return { dataUrl, filename };
  } catch (error: unknown) {
    console.error("PDF generation error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to generate PDF: ${errorMessage}`);
  }
}

/**
 * Process chord content while preserving spacing for tabs
 */
function processChordContent(
  doc: jsPDF,
  content: string,
  margin: number,
  startY: number,
  pageWidth: number,
  pageHeight: number,
  lineHeight: number,
  autoLinebreak = false,
): void {
  let yPos = startY;

  // Split the content into lines
  const lines = content.split("\n");

  // If auto linebreak is enabled, detect paragraphs and add page breaks
  const processedLines = autoLinebreak
    ? addParagraphBreaks(lines, pageHeight, margin, lineHeight, startY)
    : lines;

  // Debug logging
  if (autoLinebreak) {
    console.log("Auto linebreak is enabled");
    console.log("Original lines:", lines.length);
    console.log("Processed lines:", processedLines.length);
    console.log(
      "Page breaks added:",
      processedLines.filter((line) => line === "__PAGE_BREAK__").length,
    );
  }

  // Process each line
  for (let i = 0; i < processedLines.length; i++) {
    const line = processedLines[i];

    // Check for forced page break marker
    if (line === "__PAGE_BREAK__") {
      doc.addPage();
      yPos = margin;
      continue;
    }

    // Check if we need a new page
    if (yPos + lineHeight > pageHeight - margin) {
      doc.addPage();
      yPos = margin;
    }

    // If the line contains chord tags
    if (line.includes("[ch]") && line.includes("[/ch]")) {
      // Process line with chords - we'll need to handle each segment separately
      const segments = line.split(/(\[ch\][^\[]*\[\/ch\])/g);
      let xPos = margin;

      for (let j = 0; j < segments.length; j++) {
        const segment = segments[j];
        if (!segment) continue;

        // Check if this is a chord segment
        if (segment.startsWith("[ch]") && segment.endsWith("[/ch]")) {
          // Extract the chord text
          const chordText = segment.substring(4, segment.length - 5);

          // Switch to bold for chords
          doc.setFont("RobotoMono", "bold");

          // Calculate text width
          const textWidth = doc.getTextWidth(chordText);

          // Check if chord would go beyond page width
          if (xPos + textWidth > pageWidth - margin) {
            // Move to next line
            yPos += lineHeight;
            xPos = margin;

            // Check if we need a new page
            if (yPos + lineHeight > pageHeight - margin) {
              doc.addPage();
              yPos = margin;
            }
          }

          // Draw the chord
          doc.text(chordText, xPos, yPos);
          xPos += textWidth;
        } else {
          // This is regular text - preserve all spaces exactly
          doc.setFont("RobotoMono", "normal");

          // Use character-by-character approach to preserve all spaces
          for (let k = 0; k < segment.length; k++) {
            const char = segment[k];
            const charWidth = doc.getTextWidth(char);

            // Check if character would go beyond page width
            if (xPos + charWidth > pageWidth - margin) {
              // Move to next line
              yPos += lineHeight;
              xPos = margin;

              // Check if we need a new page
              if (yPos + lineHeight > pageHeight - margin) {
                doc.addPage();
                yPos = margin;
              }
            }

            // Draw the character (including spaces)
            doc.text(char, xPos, yPos);
            xPos += charWidth;
          }
        }
      }
    } else {
      // This is a normal line or a tab line without chord markers
      // We must preserve all spaces exactly as they are
      doc.setFont("RobotoMono", "normal");

      // Special handling for tab notation - use a fixed-width approach
      // First, check if we can fit this line in the available width
      const lineWidth = doc.getTextWidth(line);

      if (lineWidth <= pageWidth - margin * 2) {
        // The line fits, draw it as is
        doc.text(line, margin, yPos);
      } else {
        // The line is too long, we need to split it
        // For tabs, we'll just cut at the right margin and continue on the next line
        // This preserves the vertical alignment of tab characters

        // Calculate how many characters we can fit in one line
        const spaceWidth = doc.getTextWidth(" ");
        const charsPerLine = Math.floor((pageWidth - margin * 2) / spaceWidth);

        // Split the line into chunks of charsPerLine length
        for (
          let charIndex = 0;
          charIndex < line.length;
          charIndex += charsPerLine
        ) {
          const chunk = line.substring(charIndex, charIndex + charsPerLine);

          // Draw this chunk
          doc.text(chunk, margin, yPos);

          // Move to next line if we have more to draw
          if (charIndex + charsPerLine < line.length) {
            yPos += lineHeight;

            // Check if we need a new page
            if (yPos + lineHeight > pageHeight - margin) {
              doc.addPage();
              yPos = margin;
            }
          }
        }
      }
    }

    // Move to next line after processing this line
    yPos += lineHeight;
  }
}

/**
 * Detect song sections and add page breaks to avoid splitting them across pages
 */
function addParagraphBreaks(
  lines: string[],
  pageHeight: number,
  margin: number,
  lineHeight: number,
  startY: number,
): string[] {
  const processedLines: string[] = [];

  // Account for the header space (title and artist) already used
  const usableHeight = pageHeight - margin * 2;
  const maxLinesPerPage = Math.floor(usableHeight / lineHeight);

  // Calculate how many lines are already used on the first page
  const firstPageUsedLines = Math.ceil((startY - margin) / lineHeight);
  const firstPageAvailableLines = maxLinesPerPage - firstPageUsedLines;

  console.log("addParagraphBreaks called with:", {
    totalLines: lines.length,
    maxLinesPerPage,
    firstPageAvailableLines,
    pageHeight,
    margin,
    lineHeight,
    startY,
  });

  // Helper function to detect if a line is a section header like [Verse 1], [Chorus], etc.
  const isSectionHeader = (line: string): boolean => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith("[") &&
      trimmed.endsWith("]") &&
      trimmed.length > 2 &&
      !trimmed.includes("[ch]")
    );
  };

  // Split content into sections based on headers and empty lines
  const sections: string[][] = [];
  let currentSection: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHeader = isSectionHeader(line);
    const isEmptyLine = line.trim() === "";
    const nextIsHeader = i < lines.length - 1 && isSectionHeader(lines[i + 1]);

    if (isHeader && currentSection.length > 0) {
      // Save current section and start a new one with the header
      sections.push([...currentSection]);
      currentSection = [line];
    } else if (isEmptyLine && nextIsHeader && currentSection.length > 0) {
      // Empty line before a header - end current section (including the empty line)
      currentSection.push(line);
      sections.push([...currentSection]);
      currentSection = [];
    } else if (
      isEmptyLine &&
      currentSection.length > 0 &&
      i > 0 &&
      lines[i - 1].trim() !== ""
    ) {
      // Empty line after content - could be section end
      currentSection.push(line);
      // Check if next line is also empty or we're at the end
      if (
        i === lines.length - 1 ||
        (i < lines.length - 1 && lines[i + 1].trim() === "")
      ) {
        sections.push([...currentSection]);
        currentSection = [];
      }
    } else if (line.trim() !== "" || currentSection.length > 0) {
      // Add non-empty line or empty line within a section
      currentSection.push(line);
    }
  }

  // Don't forget the last section
  if (currentSection.length > 0) {
    sections.push(currentSection);
  }

  console.log("Sections identified:", sections.length);

  // Now process sections and add page breaks as needed
  let currentPageLines = 0;
  let currentPageNumber = 1;

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex];
    const sectionLines = section.length;

    // Determine available lines on current page
    const availableLinesOnCurrentPage =
      currentPageNumber === 1
        ? firstPageAvailableLines - currentPageLines
        : maxLinesPerPage - currentPageLines;

    console.log(`Processing section ${sectionIndex + 1}:`, {
      sectionLines,
      currentPageLines,
      availableLinesOnCurrentPage,
      currentPageNumber,
    });

    // Check if this section would be split across pages
    const sectionWouldBeSplit = sectionLines > availableLinesOnCurrentPage;
    const sectionFitsOnNewPage = sectionLines <= maxLinesPerPage;

    // Only add a page break if:
    // 1. The section would be split
    // 2. There's already content on the current page
    // 3. The section would fit on a new page
    // 4. We're not wasting too much space (e.g., don't break if we'd only save 1-2 lines)
    const minimumLinesToJustifyBreak = 3;
    const wouldSaveEnoughLines = sectionLines >= minimumLinesToJustifyBreak;

    if (
      sectionWouldBeSplit &&
      currentPageLines > 0 &&
      sectionFitsOnNewPage &&
      wouldSaveEnoughLines
    ) {
      // Add page break before this section
      console.log(`Adding page break before section ${sectionIndex + 1}`);
      processedLines.push("__PAGE_BREAK__");
      currentPageLines = 0;
      currentPageNumber++;
    }

    // Add all lines from this section
    processedLines.push(...section);
    currentPageLines += sectionLines;

    // Check if we've exceeded the page capacity
    const currentPageCapacity =
      currentPageNumber === 1 ? firstPageAvailableLines : maxLinesPerPage;

    if (currentPageLines >= currentPageCapacity) {
      // Calculate overflow to next page
      currentPageLines = currentPageLines - currentPageCapacity;
      currentPageNumber++;

      // If there's significant overflow, track it
      while (currentPageLines >= maxLinesPerPage) {
        currentPageLines -= maxLinesPerPage;
        currentPageNumber++;
      }
    }
  }

  console.log("Final processed lines:", processedLines.length);
  console.log(
    "Page breaks added:",
    processedLines.filter((l) => l === "__PAGE_BREAK__").length,
  );

  return processedLines;
}

/**
 * Load required fonts for the PDF
 */
async function loadFonts(doc: jsPDF): Promise<void> {
  try {
    const regularFontUrl =
      "https://wildwastaken.github.io/gifting/Roboto_Mono/RobotoMono-Regular.ttf";
    const boldFontUrl =
      "https://wildwastaken.github.io/gifting/Roboto_Mono/RobotoMono-Bold.ttf";

    // Create an array of promises for parallel font loading
    const fontPromises = [fetchFont(regularFontUrl), fetchFont(boldFontUrl)];

    // Wait for both fonts to load
    const [regularFontData, boldFontData] = await Promise.all(fontPromises);

    // Add fonts to document
    doc.addFileToVFS(
      "RobotoMono-Regular.ttf",
      arrayBufferToBase64(regularFontData),
    );
    doc.addFileToVFS("RobotoMono-Bold.ttf", arrayBufferToBase64(boldFontData));

    // Register fonts
    doc.addFont("RobotoMono-Regular.ttf", "RobotoMono", "normal");
    doc.addFont("RobotoMono-Bold.ttf", "RobotoMono", "bold");

    // Set default font
    doc.setFont("RobotoMono");
  } catch (error) {
    console.error("Failed to load custom fonts:", error);
    // Fallback to standard fonts if custom ones fail
    console.log("Using fallback fonts instead");
  }
}

/**
 * Helper function to fetch font data with timeout and retry
 */
async function fetchFont(
  url: string,
  retries = 2,
  timeout = 5000,
): Promise<ArrayBuffer> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to load font: ${response.status}`);
    }

    return await response.arrayBuffer();
  } catch (error: unknown) {
    if (
      retries > 0 &&
      ((error instanceof Error && error.name === "AbortError") ||
        !navigator.onLine)
    ) {
      console.warn(`Retrying font fetch for ${url}, ${retries} attempts left`);
      return fetchFont(url, retries - 1, timeout);
    }
    throw error;
  }
}

/**
 * Helper function to convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;

  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}
