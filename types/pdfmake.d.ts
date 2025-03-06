// pdfmake.d.ts
declare module "pdfmake/build/pdfmake" {
    import { TDocumentDefinitions } from "pdfmake/interfaces";
    interface PdfMakeStatic {
      createPdf(docDefinition: TDocumentDefinitions): {
        getBlob(callback: (blob: Blob) => void): void;
      };
      vfs: { [key: string]: string };
      fonts: any;
    }
    const pdfMake: PdfMakeStatic;
    export default pdfMake;
  }
  