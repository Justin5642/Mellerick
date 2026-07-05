import { renderToBuffer } from "@react-pdf/renderer";
import fs from "fs";
import path from "path";
import { DocumentPdf, DocumentPdfProps } from "./document-template";

let cachedLogo: { data: Buffer; format: "png" } | null | undefined;

function loadLogo() {
  if (cachedLogo !== undefined) return cachedLogo;
  try {
    const logoPath = path.join(process.cwd(), "public", "logo.png");
    cachedLogo = { data: fs.readFileSync(logoPath), format: "png" };
  } catch {
    cachedLogo = null;
  }
  return cachedLogo;
}

export async function renderDocumentPdf(props: Omit<DocumentPdfProps, "logo">) {
  const logo = loadLogo();
  const buffer = await renderToBuffer(
    DocumentPdf({ ...props, logo: logo ?? undefined })
  );
  return buffer;
}
