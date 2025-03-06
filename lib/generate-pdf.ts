// lib/generate-pdf.ts
import pdfMake from "pdfmake/build/pdfmake";
// @ts-expect-error: vfsFonts has no type definitions
import vfsFonts from "./vfs_fonts";

pdfMake.vfs = vfsFonts.pdfMake.vfs;

pdfMake.fonts = {
  RobotoMono: {
    normal: "RobotoMono-Regular.ttf",
    bold: "RobotoMono-Bold.ttf",
  },
};

const isOdd = (i: number): boolean => i % 2 === 1;

type ChordSegment = string | { text: string; bold: boolean };
type ProcessedChord = string | { text: ChordSegment[] };

function processChords(chords: string): ProcessedChord[] {
  // Remove [tab] markers
  const formattedChords = chords.replace(/\[tab\]/g, "").replace(/\[\/tab\]/g, "");
  const lines = formattedChords.split(/\n/g).map((line) => line.split(/\[ch\]|\[\/ch\]/g));
  const processedChords: ProcessedChord[] = lines.map((segments) => {
    if (segments.length === 1) {
      return segments[0];
    } else {
      const processedSegments: ChordSegment[] = segments.map((segment, index) =>
        isOdd(index) ? { text: segment, bold: true } : segment
      );
      return { text: processedSegments };
    }
  });
  return processedChords;
}

// Define an interface for pdfMake's document generator that includes getDataUrl
interface PdfDocGenerator {
  getDataUrl(callback: (dataUrl: string) => void): void;
}

interface ExtendedPdfDocGenerator extends PdfDocGenerator {
  getBlob(callback: (blob: Blob) => void): void; // Include any additional methods
}

export default function generatePDF(
  artist: string,
  song: string,
  chords: string,
  fontSize: number
): Promise<{ dataUrl: string; filename: string }> {
  const processedChords = processChords(chords);

  const docDefinition = {
    pageSize: "A4",
    content: [
      { text: artist, style: "artist" },
      { text: song, style: "song" },
      " ",
      ...processedChords,
    ],
    defaultStyle: {
      font: "RobotoMono",
      fontSize: fontSize,
      preserveLeadingSpaces: true,
    },
    styles: {
      artist: {
        fontSize: fontSize + 4,
        bold: true,
        margin: [0, 0, 0, 5],
      },
      song: {
        fontSize: fontSize + 2,
        bold: true,
        margin: [0, 0, 0, 10],
      },
    },
    pageBreakBefore: (
      currentNode: { text?: unknown },
      followingNodesOnPage: unknown[],
      nodesOnNextPage: unknown[]
    ): boolean => {
      const isLastOnPage = followingNodesOnPage.length === 0;
      const isNotLastOfAll = nodesOnNextPage.length !== 0;
      return isLastOnPage && isNotLastOfAll && Array.isArray(currentNode.text);
    },
  };

  return new Promise((resolve) => {
    const filename = `${artist}-${song}.pdf`;
    // Cast to ExtendedPdfDocGenerator to include getDataUrl
    const pdfDocGenerator = pdfMake.createPdf(docDefinition) as ExtendedPdfDocGenerator;
    pdfDocGenerator.getDataUrl((dataUrl: string) => {
      resolve({ dataUrl, filename });
    });
  });
}
