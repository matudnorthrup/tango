import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileOpsTools, createPrintingTools } from "../src/research-agent-tools.js";

describe("find-diesel script", () => {
  it("loads and prints help without missing runtime dependencies", () => {
    const scriptPath = fileURLToPath(
      new URL("../../../scripts/find-diesel.js", import.meta.url),
    );

    const output = execFileSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
    });

    expect(output).toContain("find-diesel");
    expect(output).toContain("Find best-value diesel stations along your route");
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
