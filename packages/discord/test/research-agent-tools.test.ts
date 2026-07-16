import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileOpsTools, createPaperPrintingTools, createPrintingTools, createTravelTools } from "../src/research-agent-tools.js";

function writeExecutableScript(dir: string, name: string, body: string): string {
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(scriptPath, body, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("find-diesel script", () => {
  it("loads and prints help without missing runtime dependencies", () => {
    const scriptPath = fileURLToPath(
      new URL("../../../scripts/find-diesel.js", import.meta.url),
    );

    const output = execFileSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
    });

    expect(output).toContain("find-diesel");
    expect(output).toContain("Find best-value fuel stations along your route or nearby");
  });
});

describe("printing tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports dry-run previews for mutating printer actions without fetching secrets or hitting PrusaLink", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tools = createPrintingTools({
      prusaPrinterIp: "printer.local",
      prusaApiKey: "test-key",
    });
    const printerCommand = tools.find((tool) => tool.name === "printer_command");
    expect(printerCommand).toBeDefined();

    const result = await printerCommand!.handler({
      action: "upload",
      file_path: "/tmp/example.gcode",
      dry_run: true,
    });

    expect(result).toEqual({
      dry_run: true,
      action: "upload",
      preview: "Would upload /tmp/example.gcode to printer printer.local",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("paper printing tools", () => {
  it("creates a preview PDF from content without touching the print queue", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-print-test-"));
    const cupsfilter = writeExecutableScript(tempDir, "cupsfilter", `#!/bin/sh
cat <<'PDF'
%PDF-1.3
1 0 obj
<<>>
endobj
trailer
<<>>
%%EOF
PDF
`);
    const pdfinfo = writeExecutableScript(tempDir, "pdfinfo", `#!/bin/sh
echo 'Pages: 1'
`);

    try {
      const tools = createPaperPrintingTools({
        paperPrintDir: tempDir,
        cupsfilterCommand: cupsfilter,
        pdfinfoCommand: pdfinfo,
      });
      const paperPrint = tools.find((tool) => tool.name === "paper_print");
      expect(paperPrint).toBeDefined();

      const result = await paperPrint!.handler({
        action: "preview",
        title: "Travel Backup",
        content: "Flight confirmation summary",
      });

      expect(result).toMatchObject({
        success: true,
        action: "preview",
        page_count: 1,
        source_type: "content",
      });
      const pdfPath = (result as { pdf_path: string }).pdf_path;
      expect(pdfPath.startsWith(tempDir)).toBe(true);
      expect(fs.readFileSync(pdfPath, "utf8")).toContain("%PDF-1.3");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("dry-runs print jobs by default and returns the lp command preview", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-print-test-"));
    const lpMarker = path.join(tempDir, "lp-called");
    const cupsfilter = writeExecutableScript(tempDir, "cupsfilter", `#!/bin/sh
cat <<'PDF'
%PDF-1.3
%%EOF
PDF
`);
    const pdfinfo = writeExecutableScript(tempDir, "pdfinfo", `#!/bin/sh
echo 'Pages: 1'
`);
    const lpstat = writeExecutableScript(tempDir, "lpstat", `#!/bin/sh
if [ "$1" = "-d" ]; then
  echo 'system default destination: Home_Printer'
  exit 0
fi
if [ "$1" = "-p" ]; then
  echo 'printer Home_Printer is idle. enabled since Thu Jun 18 12:00:00 2026'
  exit 0
fi
exit 1
`);
    const lp = writeExecutableScript(tempDir, "lp", `#!/bin/sh
echo called > '${lpMarker}'
exit 9
`);

    try {
      const tools = createPaperPrintingTools({
        paperPrintDir: tempDir,
        cupsfilterCommand: cupsfilter,
        pdfinfoCommand: pdfinfo,
        lpstatCommand: lpstat,
        lpCommand: lp,
      });
      const paperPrint = tools.find((tool) => tool.name === "paper_print");
      expect(paperPrint).toBeDefined();

      const result = await paperPrint!.handler({
        action: "print",
        title: "Travel Backup",
        content: "Reservation summary",
        sides: "one-sided",
      });

      expect(result).toMatchObject({
        dry_run: true,
        action: "print",
        printer: "Home_Printer",
        copies: 1,
      });
      expect((result as { lp_command_preview: string[] }).lp_command_preview).toContain("Home_Printer");
      expect(fs.existsSync(lpMarker)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("travel tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches local businesses through HERE Discover and preserves contact evidence", async () => {
    const previousKey = process.env.HERE_API_KEY;
    process.env.HERE_API_KEY = "test-here-key";
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "discover.search.hereapi.com") {
          expect(url.searchParams.get("q")).toBe("restaurants");
          expect(url.searchParams.get("limit")).toBe("20");
          expect(url.searchParams.get("in")).toBe("circle:15.87,-97.077;r=12000");
          expect(url.searchParams.get("apiKey")).toBe("test-here-key");
          return new Response(JSON.stringify({
            items: [{
              id: "here:pds:place:4849abcd",
              resultType: "place",
              title: "Almoraduz Cocina de Autor",
              address: { label: "Benito Juarez, Puerto Escondido, Oaxaca, Mexico" },
              position: { lat: 15.861, lng: -97.071 },
              distance: 950,
              categories: [{ name: "Restaurant", primary: true }],
              foodTypes: [{ name: "Mexican", primary: true }],
              contacts: [{
                phone: [{ value: "+52 954 100 0000" }],
                www: [{ value: "almoraduz.mx" }],
                email: [{ value: "hola@almoraduz.mx" }],
              }],
              openingHours: [{ text: ["Tue-Sat: 2:00 PM-10:00 PM"], isOpen: true }],
            }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url.toString()}`);
      });

      const tools = createTravelTools();
      const localBusinessSearch = tools.find((tool) => tool.name === "local_business_search");
      expect(localBusinessSearch).toBeDefined();

      const result = await localBusinessSearch!.handler({
        query: "restaurants",
        near: "15.8700,-97.0770",
        limit: 20,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        source: "here-discover",
        query: "restaurants",
        near: { source: "coordinate", lat: 15.87, lon: -97.077 },
        radiusMeters: 12000,
        resultCount: 1,
        results: [{
          name: "Almoraduz Cocina de Autor",
          resultType: "place",
          address: "Benito Juarez, Puerto Escondido, Oaxaca, Mexico",
          position: { lat: 15.861, lon: -97.071 },
          distanceMiles: 0.59,
          categories: ["Restaurant"],
          foodTypes: ["Mexican"],
          phoneNumbers: ["+52 954 100 0000"],
          websites: ["https://almoraduz.mx"],
          emails: ["hola@almoraduz.mx"],
          openingHours: ["Tue-Sat: 2:00 PM-10:00 PM"],
          isOpen: true,
          hereId: "here:pds:place:4849abcd",
          googleMapsSearchUrl: expect.stringContaining("google.com/maps/search"),
        }],
        warnings: [],
      });
    } finally {
      if (previousKey === undefined) delete process.env.HERE_API_KEY;
      else process.env.HERE_API_KEY = previousKey;
    }
  });

  it("routes through HERE Router v8 with traffic-aware ETA, via roads, and passes-through towns", async () => {
    const previousKey = process.env.HERE_API_KEY;
    process.env.HERE_API_KEY = "test-here-key";
    try {
      // Reference flexible polyline from HERE docs: 4 points near 50.102,8.698.
      const FLEX_POLYLINE = "BFoz5xJ67i1B1B7PzIhaxL7Y";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        const host = new URL(url).hostname;
        if (host === "router.hereapi.com") {
          return new Response(JSON.stringify({
            routes: [{
              sections: [{
                summary: { length: 160934, duration: 7200, baseDuration: 6800 },
                polyline: FLEX_POLYLINE,
                spans: [{ routeNumbers: [{ value: "A5" }], length: 160934 }],
              }],
            }],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (host === "revgeocode.search.hereapi.com") {
          return new Response(JSON.stringify({
            items: [{ address: { city: "Frankfurt am Main", stateCode: "HE" } }],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const tools = createTravelTools();
      const osrmRoute = tools.find((tool) => tool.name === "driving_route");
      expect(osrmRoute).toBeDefined();

      const result = await osrmRoute!.handler({
        origin: "44.311,-124.104",
        destination: "37.563,-122.325",
      });

      const routerUrl = fetchSpy.mock.calls.map((call) => String(call[0]))
        .find((url) => new URL(url).hostname === "router.hereapi.com");
      expect(routerUrl).toContain("origin=44.311,-124.104;radius=10000");
      expect(routerUrl).toContain("destination=37.563,-122.325;radius=10000");
      expect(routerUrl).toContain("spans=routeNumbers,length");
      expect(result).toMatchObject({
        routes: [{
          source: "here",
          distanceMiles: 100,
          durationHours: 2,
          durationText: "2h 0m",
          baseDurationHours: 1.89,
          via: [{ road: "A5", miles: 100 }],
          passesThrough: ["Frankfurt am Main, HE"],
        }],
        fastest: {
          label: "route 1",
          distanceMiles: 100,
          durationHours: 2,
          durationText: "2h 0m",
        },
      });
    } finally {
      if (previousKey === undefined) delete process.env.HERE_API_KEY;
      else process.env.HERE_API_KEY = previousKey;
    }
  });

  it("falls back to OSRM with an overestimate warning when no HERE key is configured", async () => {
    const previousKey = process.env.HERE_API_KEY;
    delete process.env.HERE_API_KEY;
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          code: "Ok",
          routes: [{ distance: 160934, duration: 7200 }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const tools = createTravelTools();
      const osrmRoute = tools.find((tool) => tool.name === "driving_route");
      expect(osrmRoute).toBeDefined();

      const result = await osrmRoute!.handler({
        origin: "44.311,-124.104",
        destination: "37.563,-122.325",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
        "https://router.project-osrm.org/route/v1/driving/-124.104,44.311;-122.325,37.563?overview=false",
      );
      expect(result).toMatchObject({
        routes: [{
          source: "osrm",
          distanceMiles: 100,
          durationHours: 2,
          durationText: "2h 0m",
        }],
        fastest: {
          label: "route 1",
          distanceMiles: 100,
          durationHours: 2,
          durationText: "2h 0m",
        },
      });
      const route = (result as { routes: Array<{ warning?: string }> }).routes[0];
      expect(route?.warning).toContain("OSRM fallback");
    } finally {
      if (previousKey === undefined) delete process.env.HERE_API_KEY;
      else process.env.HERE_API_KEY = previousKey;
    }
  });

  it("uses HERE pedestrian routing for walking_route", async () => {
    const previousKey = process.env.HERE_API_KEY;
    process.env.HERE_API_KEY = "test-here-key";
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        const host = new URL(url).hostname;
        if (host === "router.hereapi.com") {
          return new Response(JSON.stringify({
            routes: [{
              sections: [{
                summary: { length: 3219, duration: 2400, baseDuration: 2400 },
                spans: [],
              }],
            }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const tools = createTravelTools();
      const walkingRoute = tools.find((tool) => tool.name === "walking_route");
      expect(walkingRoute).toBeDefined();

      const result = await walkingRoute!.handler({
        origin: "17.062084,-96.7207289",
        destination: "17.0614,-96.6974",
      });

      const routerUrl = fetchSpy.mock.calls.map((call) => String(call[0]))
        .find((url) => new URL(url).hostname === "router.hereapi.com");
      expect(routerUrl).toContain("transportMode=pedestrian");
      expect(routerUrl).not.toContain("transportMode=car");
      expect(result).toMatchObject({
        routeMode: "walking",
        routes: [{
          mode: "walking",
          source: "here",
          distanceMiles: 2,
          durationHours: 0.67,
          durationText: "0h 40m",
          durationBasis: "HERE pedestrian route duration",
          googleMapsUrl: expect.stringContaining("travelmode=walking"),
        }],
        fastest: {
          mode: "walking",
          distanceMiles: 2,
          durationText: "0h 40m",
        },
      });
    } finally {
      if (previousKey === undefined) delete process.env.HERE_API_KEY;
      else process.env.HERE_API_KEY = previousKey;
    }
  });

  it("falls back to OSRM foot distance and estimates walking time instead of trusting OSRM duration", async () => {
    const previousKey = process.env.HERE_API_KEY;
    delete process.env.HERE_API_KEY;
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          code: "Ok",
          routes: [{ distance: 1609.34, duration: 60 }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const tools = createTravelTools();
      const walkingRoute = tools.find((tool) => tool.name === "walking_route");
      expect(walkingRoute).toBeDefined();

      const result = await walkingRoute!.handler({
        origin: "17.062084,-96.7207289",
        destination: "17.0614,-96.6974",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
        "https://router.project-osrm.org/route/v1/foot/-96.7207289,17.062084;-96.6974,17.0614?overview=false",
      );
      expect(result).toMatchObject({
        routeMode: "walking",
        routes: [{
          mode: "walking",
          source: "osrm",
          distanceMiles: 1,
          durationHours: 0.33,
          durationText: "0h 20m",
          durationBasis: "OSRM foot routed distance with walking time estimated at 3 mph",
          googleMapsUrl: expect.stringContaining("travelmode=walking"),
          warning: expect.stringContaining("sidewalk/safety conditions are not verified"),
        }],
        fastest: {
          mode: "walking",
          distanceMiles: 1,
          durationText: "0h 20m",
        },
      });
    } finally {
      if (previousKey === undefined) delete process.env.HERE_API_KEY;
      else process.env.HERE_API_KEY = previousKey;
    }
  });

  it("falls back to HERE Discover when Nominatim cannot geocode a POI", async () => {
    const previousKey = process.env.HERE_API_KEY;
    process.env.HERE_API_KEY = "test-here-key";
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        const host = new URL(url).hostname;
        if (host === "nominatim.openstreetmap.org") {
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (host === "discover.search.hereapi.com") {
          return new Response(JSON.stringify({
            items: [{
              title: "Costco",
              address: { label: "Costco, 3075 Hamrick Rd, Central Point, OR 97502, United States" },
              position: { lat: 42.37395, lng: -122.88789 },
            }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (host === "router.hereapi.com") {
          return new Response(JSON.stringify({
            routes: [{
              sections: [{
                summary: { length: 160934, duration: 7200, baseDuration: 7000 },
                polyline: "BFoz5xJ67i1B1B7PzIhaxL7Y",
                spans: [],
              }],
            }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (host === "revgeocode.search.hereapi.com") {
          return new Response(JSON.stringify({
            items: [{ address: { city: "Central Point", stateCode: "OR" } }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const tools = createTravelTools();
      const osrmRoute = tools.find((tool) => tool.name === "driving_route");
      expect(osrmRoute).toBeDefined();

      const result = await osrmRoute!.handler({
        origin: "42.3265,-122.8756",
        destination: "Costco, Medford, OR",
      });

      const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => new URL(url).hostname === "discover.search.hereapi.com" && new URL(url).searchParams.get("apiKey") === "test-here-key")).toBe(true);
      expect(result).toMatchObject({
        routes: [{
          resolvedPoints: [
            { source: "coordinate" },
            { source: "here-discover", lat: 42.37395, lon: -122.88789 },
          ],
        }],
      });
    } finally {
      if (previousKey === undefined) delete process.env.HERE_API_KEY;
      else process.env.HERE_API_KEY = previousKey;
    }
  });
});

describe("file ops tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports append writes inside allowed directories", async () => {
    const documentsDir = path.join(os.homedir(), "Documents");
    fs.mkdirSync(documentsDir, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(documentsDir, "codex-file-ops-"));
    const targetPath = path.join(tempDir, "smoke.txt");
    fs.writeFileSync(targetPath, "hello", "utf8");

    try {
      const tools = createFileOpsTools();
      const fileOps = tools.find((tool) => tool.name === "file_ops");
      expect(fileOps).toBeDefined();

      const result = await fileOps!.handler({
        action: "append",
        path: targetPath,
        content: "world",
      });

      expect(result).toEqual({
        success: true,
        action: "append",
        path: targetPath,
        appended: 5,
      });
      expect(fs.readFileSync(targetPath, "utf8")).toBe("hello\nworld");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
