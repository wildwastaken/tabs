// lib/generate-pdf.ts

// Define the types you need
type ChordSegment = string | { text: string; bold: boolean };
type ProcessedChord = string | { text: ChordSegment[] };

function isOdd(i: number): boolean {
  return i % 2 === 1;
}

// Instead of importing pdfMake at the top, we import it on the fly
// so this code only runs in the browser (no SSR).
export default async function generatePDF(
  artist: string,
  song: string,
  chords: string,
  fontSize: number
): Promise<{ dataUrl: string; filename: string }> {
  // Dynamically load pdfMake so this only runs in the browser
  const pdfMakeModule = await import("pdfmake/build/pdfmake");
  const pdfMake = pdfMakeModule.default || pdfMakeModule;

  // Configure custom fonts using the locally hosted font files in the 'font/' folder
  pdfMake.fonts = {
    RobotoMono: {
      normal: "https://wildwastaken.github.io/gifting/Roboto_Mono/RobotoMono-Regular.ttf",
      bold: "https://wildwastaken.github.io/gifting/Roboto_Mono/RobotoMono-Bold.ttf"
    }
  };
  

  // Process chord text into pdfMake-ready objects
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
      font: "RobotoMono", // use the key from your fonts config
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
    const pdfDocGenerator = pdfMake.createPdf(docDefinition) as {
      getDataUrl: (callback: (dataUrl: string) => void) => void;
    };
    pdfDocGenerator.getDataUrl((dataUrl: string) => {
      resolve({ dataUrl, filename });
    });
  });
}

// Helper to process chords
function processChords(chords: string): ProcessedChord[] {
  // Remove [tab] markers
  const formattedChords = chords.replace(/\[tab\]/g, "").replace(/\[\/tab\]/g, "");
  // Split lines, then split out chords from lyrics
  const lines = formattedChords.split(/\n/g).map((line) => line.split(/\[ch\]|\[\/ch\]/g));

  // Map each line into PDF text objects
  const processedChords: ProcessedChord[] = lines.map((segments) => {
    // If there are no chord tags, just return the raw line
    if (segments.length === 1) {
      return segments[0];
    }

    // Otherwise, bold any "odd" segments that were chords
    const processedSegments: ChordSegment[] = segments.map((segment, index) =>
      isOdd(index) ? { text: segment, bold: true } : segment
    );
    return { text: processedSegments };
  });

  return processedChords;
}
