import { NextResponse } from "next/server";
import { getGoogleConsentUrl } from "@/lib/google";

export async function GET() {
  return NextResponse.redirect(getGoogleConsentUrl());
}
