import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  DISTANCE_ERRORS,
  clearDistanceCaches,
  distanceAnswer,
  isPreciseForDistance,
  parseCoordinates,
  placeLabel,
  roundUpKm,
  shapeOsrmRoute,
} from "@/lib/distance";

// Road distance for floats and truck loads: OSRM (route) + Nominatim (places).

const requireRole = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireRole: (...a: unknown[]) => requireRole(...a) }));
let allowed = true;
vi.mock("@/lib/api/rate-limit", () => ({
  DISTANCE_LIMIT: { bucket: "distance", max: 30, windowSeconds: 600 },
  consumeRateLimit: vi.fn(async () => allowed),
  rateLimitedResponse: () => new Response(JSON.stringify({ error: "Too many requests — wait a few minutes and try again." }), { status: 429 }),
}));
let jobRow: Record<string, unknown> | null = null;
let jobError: { code: string; message: string } | null = null;
const callerFrom = vi.fn();
vi.mock("@/lib/api/caller-client", () => ({
  callerClient: async () => ({
    from: (table: string) => {
      callerFrom(table);
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: jobRow, error: jobError }) };
      return q;
    },
  }),
}));

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("helpers", () => {
  it("parseCoordinates takes lat,lng in range only", () => {
    expect(parseCoordinates("-37.6, 144.9")).toEqual({ lat: -37.6, lng: 144.9 });
    expect(parseCoordinates("-37.6,144.9")).toEqual({ lat: -37.6, lng: 144.9 });
    expect(parseCoordinates("Boral Wollert")).toBeNull();
    expect(parseCoordinates("91, 10")).toBeNull();
    expect(parseCoordinates("10, 181")).toBeNull();
    expect(parseCoordinates("12 Smith St, 3076")).toBeNull();
  });

  it("roundUpKm rounds up to 0.1 km and never below 0", () => {
    expect(roundUpKm(23_401)).toBe(23.5);
    expect(roundUpKm(23_400)).toBe(23.4);
    expect(roundUpKm(2_300)).toBe(2.3);
    expect(roundUpKm(1)).toBe(0.1);
    expect(roundUpKm(0)).toBe(0);
    expect(roundUpKm(-5)).toBe(0);
    expect(roundUpKm(Number.NaN)).toBe(0);
  });

  it("shapeOsrmRoute reads the first route's metres", () => {
    expect(shapeOsrmRoute({ code: "Ok", routes: [{ distance: 23_401.2, duration: 1200 }] })).toBe(23_401.2);
    expect(shapeOsrmRoute({ code: "NoRoute", routes: [] })).toBeNull();
    expect(shapeOsrmRoute({ code: "Ok", routes: [] })).toBeNull();
    expect(shapeOsrmRoute(null)).toBeNull();
    expect(shapeOsrmRoute({ code: "Ok", routes: [{ distance: "x" }] })).toBeNull();
  });

  it("isPreciseForDistance: a house or named place is precise; streets and suburbs are not", () => {
    expect(isPreciseForDistance({ class: "place", type: "house", addresstype: "place" })).toBe(true);
    expect(isPreciseForDistance({ class: "landuse", type: "quarry", addresstype: "landuse" })).toBe(true);
    expect(isPreciseForDistance({ class: "amenity", type: "recycling", addresstype: "amenity" })).toBe(true);
    expect(isPreciseForDistance({ class: "highway", type: "residential", addresstype: "road" })).toBe(false);
    expect(isPreciseForDistance({ class: "boundary", type: "administrative", addresstype: "suburb" })).toBe(false);
    expect(isPreciseForDistance({ class: "place", type: "suburb", addresstype: "suburb" })).toBe(false);
  });

  it("placeLabel shortens Nominatim's name", () => {
    expect(placeLabel({ display_name: "Boral Wollert Quarry, Summerhill Road, Wollert, Victoria, Australia" })).toBe("Boral Wollert Quarry, Summerhill Road");
    expect(placeLabel({ display_name: "12, Smith Street, Epping, Victoria" })).toBe("12 Smith Street, Epping");
  });

  it("distanceAnswer is approximate when either end is", () => {
    const a = { lat: 1, lng: 1, label: "A", precise: true };
    const b = { lat: 2, lng: 2, label: "B", precise: false };
    expect(distanceAnswer(a, b, 10_050)).toEqual({ km: 10.1, from: { label: "A", precise: true }, to: { label: "B", precise: false }, approximate: true });
    expect(distanceAnswer(a, a, 10_000).approximate).toBe(false);
  });
});

// ── The route ───────────────────────────────────────────────────────────────

type Reply = { status?: number; body: unknown } | Error;
let replies: { match: RegExp; reply: Reply }[] = [];
const fetchCalls: string[] = [];

function fakeFetch(input: string | URL | Request) {
  const url = String(input);
  fetchCalls.push(url);
  const hit = replies.find((r) => r.match.test(url));
  if (!hit) return Promise.reject(new Error(`unexpected fetch ${url}`));
  if (hit.reply instanceof Error) return Promise.reject(hit.reply);
  const { status = 200, body } = hit.reply;
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const QUARRY_ROW = { lat: "-37.59", lon: "145.03", display_name: "Boral Wollert Quarry, Summerhill Road, Wollert, Victoria", class: "landuse", type: "quarry", addresstype: "landuse" };
const SUBURB_ROW = { lat: "-37.60", lon: "145.02", display_name: "Wollert, City of Whittlesea, Victoria", class: "boundary", type: "administrative", addresstype: "suburb" };

async function call(params: Record<string, string>, method: "GET" | "POST" = "GET") {
  const { GET, POST } = await import("@/app/api/distance/route");
  if (method === "POST") {
    return POST(new NextRequest("http://x/api/distance", { method: "POST", body: JSON.stringify(params), headers: { "content-type": "application/json" } }));
  }
  const qs = new URLSearchParams(params).toString();
  return GET(new NextRequest(`http://x/api/distance?${qs}`));
}

describe("GET/POST /api/distance", () => {
  beforeEach(() => {
    clearDistanceCaches();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    vi.spyOn(console, "error").mockImplementation(() => {});
    requireRole.mockResolvedValue({ ok: true, userId: "tech-1", role: "technician" });
    allowed = true;
    jobRow = null;
    jobError = null;
    replies = [];
    fetchCalls.length = 0;
    callerFrom.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Nominatim calls are spaced 1.1 s apart; run timers while awaiting.
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const out = p.finally(() => {
      done = true;
    });
    for (let i = 0; i < 20 && !done; i++) await vi.advanceTimersByTimeAsync(1_200);
    return out;
  }

  it("lets any staff role in and refuses everyone else with the guard's answer", async () => {
    requireRole.mockResolvedValueOnce({ ok: false, response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) });
    const res = await call({ from: "-37.6,144.9", to: "-37.7,145.0" });
    expect(res.status).toBe(403);
    expect(requireRole.mock.calls[0][1]).toEqual(["admin", "office", "technician"]);
    expect(fetchCalls).toHaveLength(0);
  });

  it("refuses missing ends, a site without a job, and over-long text with fixed sentences", async () => {
    expect(await (await call({ from: "-37.6,144.9", to: "" })).json()).toEqual({ error: DISTANCE_ERRORS.missing });
    expect(await (await call({ from: "site", to: "Wollert tip" })).json()).toEqual({ error: DISTANCE_ERRORS.noJob });
    const long = await call({ from: "x".repeat(201), to: "y" });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: DISTANCE_ERRORS.tooLong });
    expect(fetchCalls).toHaveLength(0);
  });

  it("is rate limited per user", async () => {
    allowed = false;
    const res = await call({ from: "-37.6,144.9", to: "-37.7,145.0" });
    expect(res.status).toBe(429);
    expect(fetchCalls).toHaveLength(0);
  });

  it("measures two coordinates with ONE OSRM request, rounded up, and caches the pair", async () => {
    replies = [{ match: /router\.project-osrm\.org/, reply: { body: { code: "Ok", routes: [{ distance: 23_401 }] } } }];
    const res = await call({ from: "-37.6,144.9", to: "-37.7,145.0" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ km: 23.5, approximate: false });
    expect(fetchCalls).toEqual(["https://router.project-osrm.org/route/v1/driving/144.90000,-37.60000;145.00000,-37.70000?overview=false"]);
    await call({ from: "-37.6,144.9", to: "-37.7,145.0" }, "POST");
    expect(fetchCalls).toHaveLength(1);
  });

  it("job site (pin) → quarry by name: reads the job as the caller, reports the labels", async () => {
    jobRow = { id: JOB, sites: { name: "Lot 4", address_line1: "12 Smith St", suburb: "Craigieburn", state: "VIC", postcode: "3064", site_lat: -37.6, site_lng: 144.9 } };
    replies = [
      { match: /nominatim/, reply: { body: [QUARRY_ROW] } },
      { match: /project-osrm/, reply: { body: { code: "Ok", routes: [{ distance: 18_020 }] } } },
    ];
    const res = await settle(call({ from: "Boral Wollert", to: "site", jobId: JOB }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      km: 18.1,
      from: { label: "Boral Wollert Quarry, Summerhill Road", precise: true },
      to: { label: "12 Smith St, Craigieburn", precise: true },
      approximate: false,
    });
    expect(callerFrom).toHaveBeenCalledWith("jobs");
    expect(fetchCalls.filter((u) => u.includes("nominatim"))).toHaveLength(1);
    expect(fetchCalls[0]).toContain("countrycodes=au");
  });

  it("job site without a pin is geocoded from its address; a suburb-only match is flagged approximate", async () => {
    jobRow = { id: JOB, sites: { name: "Lot 9", address_line1: "3 Jones Rd", suburb: "Mickleham", state: "VIC", postcode: "3064", site_lat: null, site_lng: null } };
    replies = [
      { match: /Jones/, reply: { body: [{ lat: "-37.5", lon: "144.9", display_name: "3, Jones Road, Mickleham", class: "place", type: "house", addresstype: "place" }] } },
      { match: /nominatim.*Wollert/, reply: { body: [SUBURB_ROW] } },
      { match: /project-osrm/, reply: { body: { code: "Ok", routes: [{ distance: 9_999 }] } } },
    ];
    const res = await settle(call({ from: "site", to: "Wollert", jobId: JOB }));
    const body = await res.json();
    expect(body).toMatchObject({ km: 10, approximate: true, to: { precise: false }, from: { label: "3 Jones Rd, Mickleham", precise: true } });
  });

  it("an unreadable job, a site with no address, an unknown place and no route each get their own fixed sentence", async () => {
    jobRow = null;
    let res = await call({ from: "site", to: "-37.7,145.0", jobId: JOB });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: DISTANCE_ERRORS.jobNotFound });

    jobRow = { id: JOB, sites: null };
    res = await call({ from: "site", to: "-37.7,145.0", jobId: JOB });
    expect(await res.json()).toEqual({ error: DISTANCE_ERRORS.noSite });

    replies = [{ match: /nominatim/, reply: { body: [] } }];
    res = await settle(call({ from: "Nowhere Quarry", to: "-37.7,145.0" }));
    expect(await res.json()).toEqual({ error: DISTANCE_ERRORS.fromNotFound });
    res = await settle(call({ from: "-37.7,145.0", to: "Nowhere Tip" }));
    expect(await res.json()).toEqual({ error: DISTANCE_ERRORS.toNotFound });

    replies = [{ match: /project-osrm/, reply: { status: 400, body: { code: "NoRoute", message: "Impossible route between points" } } }];
    res = await call({ from: "-37.6,144.9", to: "-42.8,147.3" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: DISTANCE_ERRORS.noRoute });
  });

  it("a failing service answers 502 with a fixed sentence — never the third party's text", async () => {
    replies = [{ match: /project-osrm/, reply: { status: 503, body: { message: "secret upstream detail" } } }];
    let res = await call({ from: "-37.6,144.9", to: "-37.7,145.0" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: DISTANCE_ERRORS.unavailable });

    replies = [{ match: /nominatim/, reply: new Error("socket hang up") }];
    res = await settle(call({ from: "Boral Wollert", to: "-37.7,145.0" }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("socket");

    jobError = { code: "XX000", message: "db down" };
    res = await call({ from: "site", to: "-37.7,145.0", jobId: JOB });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: DISTANCE_ERRORS.unavailable });
  });

  it("answers carry no money-named key", async () => {
    replies = [{ match: /project-osrm/, reply: { body: { code: "Ok", routes: [{ distance: 1000 }] } } }];
    const body = await (await call({ from: "-37.6,144.9", to: "-37.7,145.0" })).json();
    expect(JSON.stringify(Object.keys(body))).not.toMatch(/rate|amount|price|cost|value/i);
  });
});
