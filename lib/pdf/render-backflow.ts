import { renderToBuffer } from "@react-pdf/renderer";
import fs from "fs";
import path from "path";
import { BackflowPdf, BackflowPdfProps } from "./backflow-template";

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

export async function renderBackflowPdf(props: Omit<BackflowPdfProps, "logo">) {
  const logo = loadLogo();
  const buffer = await renderToBuffer(BackflowPdf({ ...props, logo: logo ?? undefined }));
  return buffer;
}
