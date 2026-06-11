import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileOpsTools, createPrintingTools, createTravelTools } from "../src/research-agent-tools.js";

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

describe("travel tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes coordinate inputs through OSRM with lon-lat order", async () => {
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
    const osrmRoute = tools.find((tool) => tool.name === "osrm_route");
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
        if (host === "router.project-osrm.org") {
          return new Response(JSON.stringify({
            code: "Ok",
            routes: [{ distance: 160934, duration: 7200 }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      const tools = createTravelTools();
      const osrmRoute = tools.find((tool) => tool.name === "osrm_route");
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
