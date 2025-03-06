// lib/generate-pdf.ts

// Define the types you need
type ChordSegment = string | { text: string; bold: boolean };
type ProcessedChord = string | { text: ChordSegment[] };

function isOdd(i: number): boolean {
  return i % 2 === 1;
}

// Instead of importing pdfMake at the top, we import it on the fly
export default async function generatePDF(
  artist: string,
  song: string,
  chords: string,
  fontSize: number
): Promise<{ dataUrl: string; filename: string }> {
  const pdfMake = (await import("pdfmake/build/pdfmake")).default;
  const pdfFonts = (await import("pdfmake/build/vfs_fonts")).default;
  pdfMake.vfs = pdfFonts.pdfMake.vfs;

  pdfMake.fonts = {
    RobotoMono: {
      normal: "RobotoMono-Regular.ttf",
      bold: "RobotoMono-Bold.ttf"
    }
  };

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
  const formattedChords = chords.replace(/\[tab\]/g, "").replace(/\[\/tab\]/g, "");
  const lines = formattedChords.split(/\n/g).map((line) => line.split(/\[ch\]|\[\/ch\]/g));

  const processedChords: ProcessedChord[] = lines.map((segments) => {
    if (segments.length === 1) {
      return segments[0];
    }

    const processedSegments: ChordSegment[] = segments.map((segment, index) =>
      isOdd(index) ? { text: segment, bold: true } : segment
    );
    return { text: processedSegments };
  });

  return processedChords;
}