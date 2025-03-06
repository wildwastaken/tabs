// pdfmake.d.ts
// Extend or merge with your current declarations

declare module "pdfmake/build/pdfmake" {
  import { TDocumentDefinitions } from "pdfmake/interfaces"

  interface PdfMakeStatic {
    createPdf(docDefinition: TDocumentDefinitions): TCreatedPdf
    vfs: { [key: string]: string }
    fonts: any
  }

  interface TCreatedPdf {
    // Already existing method from your snippet
    getBlob(callback: (blob: Blob) => void): void
    // Add missing method so TS recognizes it
    getDataUrl(callback: (dataUrl: string) => void): void

    // (Optional) You can also declare other missing pdfMake methods if needed:
    // getBuffer(callback: (buffer: ArrayBuffer) => void): void
    // getBase64(callback: (base64: string) => void): void
    // download(defaultFileName?: string, cb?: () => void, options?: {}): void
    // open(): Window
    // print(): void
  }

  const pdfMake: PdfMakeStatic
  export default pdfMake
}

declare module "pdfmake/build/vfs_fonts" {
  const pdfFonts: {
    pdfMake: {
      vfs: Record<string, string>
    }
  }
  export default pdfFonts
}
