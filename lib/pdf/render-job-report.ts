import { renderToBuffer } from "@react-pdf/renderer";
import { JobReportPdf, type JobReportPdfProps } from "./job-report-template";
import { loadLogo } from "./logo";

export async function renderJobReportPdf(props: Omit<JobReportPdfProps, "logo">) {
  const logo = loadLogo();
  return renderToBuffer(JobReportPdf({ ...props, logo: logo ?? undefined }));
}
