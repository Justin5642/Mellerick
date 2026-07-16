import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { DEVICE_TYPES } from "@/lib/backflow";

// Reads a photographed backflow device data plate with Claude vision and
// drags out as much structured data as the plate actually has printed on
// it — make, model, serial number, nominal size, device type — plus a
// free-text dump of anything else legible (working/test pressure,
// manufacture date, standard/certification numbers, flow direction) so
// techs aren't stuck re-typing a worn brass plate by hand. Every device is
// different and some plates are clean/complete while others are half worn
// off, so fields Claude can't confidently read come back null rather than
// guessed.
//
// Structured output is done via forced tool-calling (Anthropic doesn't have
// an OpenAI-style `response_format: json_schema` mode) - we hand Claude one
// tool and force tool_choice to it, then read the extracted fields out of
// the tool_use block's input.
//
// Same dual-auth pattern as the other backflow routes (Bearer token for
// mobile, cookies for the web dashboard) since this is called from both the
// web "Register Device" form and the mobile equivalent.
async function getAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (token) {
    const anonClient = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anonClient.auth.getUser(token);
    if (!error && data.user) return data.user.id;
  }
  const cookieClient = await createServerClient();
  const { data } = await cookieClient.auth.getUser();
  return data.user?.id ?? null;
}

const DEVICE_TYPE_VALUES = DEVICE_TYPES.map((d) => d.value);

interface ScanResult {
  make: string | null;
  model: string | null;
  serial_number: string | null;
  size_mm: number | null;
  device_type: string | null;
  additional_details: string | null;
  raw_text: string | null;
}

const ANTHROPIC_MODEL = "claude-sonnet-4-5";

export async function POST(request: NextRequest) {
  const callerId = await getAuthenticatedUserId(request);
  if (!callerId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured on the server" }, { status: 500 });
  }

  let body: { imageBase64?: string; mimeType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { imageBase64, mimeType } = body;
  if (!imageBase64) {
    return NextResponse.json({ error: "imageBase64 is required" }, { status: 400 });
  }

  const deviceTypeList = DEVICE_TYPES.map((d) => `- ${d.value}: ${d.label}`).join("\n");

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system:
          "You read manufacturer data plates (nameplates) riveted, stamped, or printed onto backflow prevention devices (RPZDs, double check valves, pressure vacuum breakers, etc.) for an Australian plumbing compliance app. Extract every field you can confidently read from the photo using the record_data_plate tool. Omit a field entirely if it is genuinely not legible or not present on the plate - never guess or invent a value. Sizes are usually printed as DN codes (DN15, DN20, DN25...) or inches (1/2\", 3/4\", 1\", 1 1/4\", 1 1/2\", 2\", 2 1/2\", 3\", 4\", 6\", 8\") - convert to the nearest standard metric size in millimetres (15, 20, 25, 32, 40, 50, 65, 80, 100, 150, 200). For device_type, return the single closest matching value slug from this list, or omit it if the plate doesn't make it clear:\n" +
          deviceTypeList,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 },
              },
              {
                type: "text",
                text: "Read this backflow device data plate and extract as much as you can with the record_data_plate tool. Put any other legible plate data (working pressure, test pressure, date of manufacture, applicable standard/certification numbers, flow direction, part number, country of origin, etc.) into additional_details as short readable lines separated by newlines. Put a full transcription of every word/number visible on the plate into raw_text as a fallback, even where you've also structured some of it above. If the photo doesn't actually show a data plate, call the tool with no fields set.",
              },
            ],
          },
        ],
        tools: [
          {
            name: "record_data_plate",
            description: "Record the fields extracted from a backflow device data plate photo.",
            input_schema: {
              type: "object",
              properties: {
                make: { type: "string", description: "Manufacturer / brand name" },
                model: { type: "string", description: "Model number or name" },
                serial_number: { type: "string" },
                size_mm: { type: "number", description: "Nominal size in millimetres" },
                device_type: { type: "string", description: "Best-guess value slug from the supplied device type list" },
                additional_details: {
                  type: "string",
                  description: "Other legible plate data not captured in the fields above, as short readable lines",
                },
                raw_text: { type: "string", description: "Full transcription of all visible text on the plate" },
              },
            },
          },
        ],
        tool_choice: { type: "tool", name: "record_data_plate" },
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => "");
      console.error("Anthropic data plate scan error:", anthropicRes.status, errText);
      return NextResponse.json({ error: "Failed to read data plate" }, { status: 502 });
    }

    const completion = await anthropicRes.json();
    const toolUse = (completion.content ?? []).find((block: any) => block.type === "tool_use");
    if (!toolUse) {
      return NextResponse.json({ error: "No response from model" }, { status: 502 });
    }

    const raw = toolUse.input as Partial<ScanResult>;
    const parsed: ScanResult = {
      make: raw.make ?? null,
      model: raw.model ?? null,
      serial_number: raw.serial_number ?? null,
      size_mm: typeof raw.size_mm === "number" ? raw.size_mm : null,
      device_type: raw.device_type ?? null,
      additional_details: raw.additional_details ?? null,
      raw_text: raw.raw_text ?? null,
    };

    // Belt-and-braces: never trust the model to have stuck to the list,
    // even though it was given the exact values — null it out rather than
    // pass an invalid device_type value through to the form/DB.
    if (parsed.device_type && !DEVICE_TYPE_VALUES.includes(parsed.device_type)) {
      parsed.device_type = null;
    }

    return NextResponse.json({ result: parsed });
  } catch (err: any) {
    console.error("Data plate scan error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to read data plate" }, { status: 500 });
  }
}
