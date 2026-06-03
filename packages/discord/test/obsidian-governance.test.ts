import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObsidianTools } from "../src/personal-agent-tools.js";

// The obsidian tool resolves its vault from os.homedir()/Documents/main, which
// honors $HOME on POSIX — so we point HOME at a temp dir to exercise the real
// tool handler end-to-end against a throwaway vault.
let homeBackup: string | undefined;
let tempHome: string;
let vault: string;

beforeEach(() => {
  homeBackup = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-gov-home-"));
  process.env.HOME = tempHome;
  vault = path.join(tempHome, "Documents", "main");
  fs.mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.HOME;
  else process.env.HOME = homeBackup;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

async function run(command: string, content?: string): Promise<string> {
  const [obsidian] = createObsidianTools();
  const res = await obsidian!.handler(content === undefined ? { command } : { command, content });
  return (res as { result: string }).result;
}

function writeNote(rel: string, body: string): void {
  const target = path.join(vault, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf8");
}

function readNote(rel: string): string {
  return fs.readFileSync(path.join(vault, rel), "utf8");
}

describe("obsidian governance (source protection + versioning)", () => {
  it("leaves plain notes (no governance frontmatter) fully editable", async () => {
    expect(await run("create 'Notes/Plain' --vault main", "hello")).toContain("Created");
    expect(await run("create 'Notes/Plain' --vault main --overwrite", "hello v2")).toContain("Overwrote");
    expect(readNote("Notes/Plain.md")).toBe("hello v2");
    expect(await run("versions 'Notes/Plain' --vault main")).toContain("(no prior versions)");
  });

  it("refuses to mutate read-only source material without --force", async () => {
    writeNote("Legal/Filing.md", "---\nsource_kind: source\n---\nOfficial filing text.\n");
    expect(await run("create 'Legal/Filing' --vault main --overwrite", "tampered")).toContain("read-only source material");
    expect(await run("create 'Legal/Filing' --vault main --append", "extra")).toContain("read-only source material");
    expect(await run("delete 'Legal/Filing' --vault main")).toContain("read-only source material");
    expect(await run("move 'Legal/Filing' 'Legal/Moved' --vault main")).toContain("read-only source material");
    // The source document is untouched on disk.
    expect(readNote("Legal/Filing.md")).toContain("Official filing text.");
  });

  it("allows source edits when --force is given", async () => {
    writeNote("Legal/Filing.md", "---\nsource_kind: source\n---\nOfficial.\n");
    expect(await run("create 'Legal/Filing' --vault main --overwrite --force", "corrected")).toContain("Overwrote");
    expect(readNote("Legal/Filing.md")).toBe("corrected");
  });

  it("snapshots versioned drafts before mutation and can restore a prior version", async () => {
    writeNote("Legal/Draft.md", "---\nversioned: true\n---\nv1 body\n");
    expect(await run("create 'Legal/Draft' --vault main --overwrite", "---\nversioned: true\n---\nv2 body\n")).toContain("Overwrote");

    const listing = await run("versions 'Legal/Draft' --vault main");
    const stamps = listing.split("\n").filter((line) => line && line !== "(no prior versions)");
    expect(stamps.length).toBe(1);

    expect(await run(`versions 'Legal/Draft' --vault main --restore ${stamps[0]}`)).toContain("Restored");
    expect(readNote("Legal/Draft.md")).toContain("v1 body");
  });

  it("does not allow a non-canonical reference doc to be deleted without --force", async () => {
    writeNote("References/Statute.md", "---\nsource_kind: reference\n---\nRCW text.\n");
    expect(await run("delete 'References/Statute' --vault main")).toContain("read-only source material");
    expect(await run("delete 'References/Statute' --vault main --force")).toContain("Deleted");
  });

  it("enforces required frontmatter on governed notes only", async () => {
    // A state-managed note missing types/areas is refused with an actionable error.
    const bad = await run(
      "create 'Projects/Trip' --vault main --overwrite",
      "---\nstate_managed: true\ndate: 2026-06-02\n---\n## Quick Read\nx\n",
    );
    expect(bad).toContain("missing required frontmatter");
    expect(bad).toContain("types");
    expect(bad).toContain("areas");

    // The same note with all required fields is written.
    const good = await run(
      "create 'Projects/Trip' --vault main --overwrite",
      "---\nstate_managed: true\ndate: 2026-06-02\ntypes:\n  - \"[[Project Plan]]\"\nareas:\n  - \"[[Personal]]\"\n---\n## Quick Read\nx\n",
    );
    expect(good).toContain("Created");

    // A plain note (not governed) is unaffected by schema enforcement.
    expect(await run("create 'Notes/Loose' --vault main", "just text")).toContain("Created");
  });
});
