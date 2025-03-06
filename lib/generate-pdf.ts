// lib/generate-pdf.ts
import pdfMake from "pdfmake/build/pdfmake";
// @ts-expect-error // comment
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
  
  // Split the input into lines and then split each line by [ch] markers.
  const lines = formattedChords.split(/\n/g).map((line) => line.split(/\[ch\]|\[\/ch\]/g));

  // Process each line to wrap chord parts in an object.
  const processedChords: ProcessedChord[] = lines.map((segments) => {
    if (segments.length === 1) {
      // No chord markers – return the plain string.
      return segments[0];
    } else {
      // For alternating segments, wrap every odd-index segment as a bold chord.
      const processedSegments: ChordSegment[] = segments.map((segment, index) => {
        return isOdd(index) ? { text: segment, bold: true } : segment;
      });
      return { text: processedSegments };
    }
  });

  return processedChords;
}

export default function generatePDF(
  artist: string,
  song: string,
  chords: string,
  fontSize: number
): Promise<{ url: string; filename: string }> {
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
      return (
        isLastOnPage &&
        isNotLastOfAll &&
        Array.isArray(currentNode.text)
      );
    },
  };

  return new Promise((resolve) => {
    const filename = `${artist}-${song}.pdf`;

    pdfMake.createPdf(docDefinition).getBlob((blob: Blob) => {
      const url = URL.createObjectURL(blob);
      resolve({ url, filename });
    });
  });
}