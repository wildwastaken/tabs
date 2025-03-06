// lib/generate-pdf.ts
import type { jsPDF } from 'jspdf';

/**
 * Generates a PDF from chord data using jsPDF
 * @param artist The artist name
 * @param song The song title
 * @param chords The chord content with [ch] tags
 * @param fontSize The font size to use
 * @returns Promise with dataUrl and filename
 */
export default async function generatePDF(
  artist: string,
  song: string,
  chords: string,
  fontSize: number
): Promise<{ dataUrl: string; filename: string }> {
  try {
    // Dynamically import jsPDF to ensure it only runs in browser
    const jsPDFModule = await import('jspdf');
    const jsPDF = jsPDFModule.default || jsPDFModule;
    
    // Create a new PDF document
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'pt',
      format: 'a4'
    });

    // Load the monospace font - crucial for proper tab spacing
    await loadFonts(doc);
    
    // PDF dimensions
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    
    // Set starting position
    let yPos = margin;
    
    // Add title and artist
    doc.setFontSize(fontSize + 4);
    doc.setFont('RobotoMono', 'bold');
    const artistText = artist || 'Unknown Artist';
    doc.text(artistText, margin, yPos);
    yPos += fontSize + 8;
    
    doc.setFontSize(fontSize + 2);
    const songText = song || 'Untitled';
    doc.text(songText, margin, yPos);
    yPos += fontSize + 15;
    
    // Set font size for chord content
    doc.setFontSize(fontSize);
    doc.setFont('RobotoMono', 'normal');
    
    // Line height for text
    const lineHeight = fontSize * 1.5;
    
    // Clean up the chord content but preserve all spaces
    // This is critical for properly displaying tablature formatting
    const formattedChords = chords
      .replace(/\[tab\]/g, "")
      .replace(/\[\/tab\]/g, "")
      .replace(/\r\n/g, "\n"); // Normalize line endings
    
    // Process the full content with chord tags
    processChordContent(doc, formattedChords, margin, yPos, pageWidth, pageHeight, lineHeight);
    
    // Generate the PDF as data URL with proper error handling
    const dataUrl = doc.output('datauristring');
    const sanitizedArtist = artistText.replace(/[^\w\s-]/g, '');
    const sanitizedSong = songText.replace(/[^\w\s-]/g, '');
    const filename = `${sanitizedArtist} - ${sanitizedSong}.pdf`;
    
    return { dataUrl, filename };
  } catch (error: unknown) {
    console.error('PDF generation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
  lineHeight: number
): void {
  let yPos = startY;
  
  // Split the content into lines
  const lines = content.split('\n');
  
  // Process each line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if we need a new page
    if (yPos + lineHeight > pageHeight - margin) {
      doc.addPage();
      yPos = margin;
    }
    
    // If the line contains chord tags
    if (line.includes('[ch]') && line.includes('[/ch]')) {
      // Process line with chords - we'll need to handle each segment separately
      const segments = line.split(/(\[ch\][^\[]*\[\/ch\])/g);
      let xPos = margin;
      
      for (let j = 0; j < segments.length; j++) {
        const segment = segments[j];
        if (!segment) continue;
        
        // Check if this is a chord segment
        if (segment.startsWith('[ch]') && segment.endsWith('[/ch]')) {
          // Extract the chord text
          const chordText = segment.substring(4, segment.length - 5);
          
          // Switch to bold for chords
          doc.setFont('RobotoMono', 'bold');
          
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
          doc.setFont('RobotoMono', 'normal');
          
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
      doc.setFont('RobotoMono', 'normal');
      
      // Special handling for tab notation - use a fixed-width approach
      // First, check if we can fit this line in the available width
      const lineWidth = doc.getTextWidth(line);
      
      if (lineWidth <= pageWidth - (margin * 2)) {
        // The line fits, draw it as is
        doc.text(line, margin, yPos);
      } else {
        // The line is too long, we need to split it
        // For tabs, we'll just cut at the right margin and continue on the next line
        // This preserves the vertical alignment of tab characters
        
        // Calculate how many characters we can fit in one line
        const spaceWidth = doc.getTextWidth(' ');
        const charsPerLine = Math.floor((pageWidth - (margin * 2)) / spaceWidth);
        
        // Split the line into chunks of charsPerLine length
        for (let charIndex = 0; charIndex < line.length; charIndex += charsPerLine) {
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
 * Load required fonts for the PDF
 */
async function loadFonts(doc: jsPDF): Promise<void> {
  try {
    const regularFontUrl = 'https://wildwastaken.github.io/gifting/Roboto_Mono/RobotoMono-Regular.ttf';
    const boldFontUrl = 'https://wildwastaken.github.io/gifting/Roboto_Mono/RobotoMono-Bold.ttf';
    
    // Create an array of promises for parallel font loading
    const fontPromises = [
      fetchFont(regularFontUrl),
      fetchFont(boldFontUrl)
    ];
    
    // Wait for both fonts to load
    const [regularFontData, boldFontData] = await Promise.all(fontPromises);
    
    // Add fonts to document
    doc.addFileToVFS('RobotoMono-Regular.ttf', arrayBufferToBase64(regularFontData));
    doc.addFileToVFS('RobotoMono-Bold.ttf', arrayBufferToBase64(boldFontData));
    
    // Register fonts
    doc.addFont('RobotoMono-Regular.ttf', 'RobotoMono', 'normal');
    doc.addFont('RobotoMono-Bold.ttf', 'RobotoMono', 'bold');
    
    // Set default font
    doc.setFont('RobotoMono');
  } catch (error) {
    console.error('Failed to load custom fonts:', error);
    // Fallback to standard fonts if custom ones fail
    console.log('Using fallback fonts instead');
  }
}

/**
 * Helper function to fetch font data with timeout and retry
 */
async function fetchFont(url: string, retries = 2, timeout = 5000): Promise<ArrayBuffer> {
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
    if (retries > 0 && (
      (error instanceof Error && error.name === 'AbortError') || 
      !navigator.onLine
    )) {
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
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  
  return btoa(binary);
}