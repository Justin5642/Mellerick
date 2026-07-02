import { NextResponse } from "next/server";
import { getXeroClient } from "@/lib/xero";

export async function GET() {
  const xero = getXeroClient();
  const url = await xero.buildConsentUrl();
  return NextResponse.redirect(url);
}
