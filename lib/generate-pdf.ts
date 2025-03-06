// lib/generate-pdf.ts
import pdfMake from "pdfmake/build/pdfmake";
// @ts-ignore
import vfsFonts from "./vfs_fonts";

pdfMake.vfs = vfsFonts.pdfMake.vfs;

pdfMake.fonts = {
  RobotoMono: {
    normal: "RobotoMono-Regular.ttf",
    bold: "RobotoMono-Bold.ttf",
  },
};

const isOdd = (i: number) => i % 2 === 1;

function processChords(chords: string): any[] {
  let formattedChords = chords;

  formattedChords = formattedChords.replace(/\[tab\]/g, "");
  formattedChords = formattedChords.replace(/\[\/tab\]/g, "");

  let processedChords: any[] = formattedChords
    .split(/\n/g)
    .map((w) => w.split(/\[ch\]|\[\/ch\]/g));

  for (let i = 0; i < processedChords.length; i += 1) {
    const processedChord = processedChords[i];

    if (processedChord.length === 1) {
      processedChords[i] = processedChord[0];
    } else {
      for (let j = 0; j < processedChord.length; j += 1) {
        const chord = processedChord[j];

        if (isOdd(j)) {
          processedChord[j] = { text: chord, bold: true };
        }
      }

      processedChords[i] = {
        text: processedChord,
      };
    }
  }

  return processedChords;
}

export default function generatePDF(
  artist: string,
  song: string,
  chords: string,
  fontSize: number
): Promise<{ url: string; filename: string }> {
  const docDefinition = {
    pageSize: "A4",
    content: [
      { text: artist, style: "artist" },
      { text: song, style: "song" },
      " ",
      ...processChords(chords),
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
      currentNode: any,
      followingNodesOnPage: any[],
      nodesOnNextPage: any[]
    ) => {
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