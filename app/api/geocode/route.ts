import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json({ error: "No address provided" }, { status: 400 });

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=au`,
    { headers: { "User-Agent": "MellerickApp/1.0 (plumbing-management)" } }
  );

  const data = await res.json();
  if (!data[0]) return NextResponse.json({ error: "Address not found" }, { status: 404 });

  return NextResponse.json({
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    display: data[0].display_name,
  });
}
