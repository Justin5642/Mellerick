import { renderToBuffer } from "@react-pdf/renderer";
import { DocumentPdf, DocumentPdfProps } from "./document-template";
import { loadLogo } from "./logo";


export async function renderDocumentPdf(props: Omit<DocumentPdfProps, "logo">) {
  const logo = loadLogo();
  const buffer = await renderToBuffer(
    DocumentPdf({ ...props, logo: logo ?? undefined })
  );
  return buffer;
}
