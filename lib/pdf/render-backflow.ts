import { renderToBuffer } from "@react-pdf/renderer";
import { BackflowPdf, BackflowPdfProps } from "./backflow-template";
import { loadLogo } from "./logo";


export async function renderBackflowPdf(props: Omit<BackflowPdfProps, "logo">) {
  const logo = loadLogo();
  const buffer = await renderToBuffer(BackflowPdf({ ...props, logo: logo ?? undefined }));
  return buffer;
}
