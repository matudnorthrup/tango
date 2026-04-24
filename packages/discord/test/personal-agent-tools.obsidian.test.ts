import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObsidianTools } from "../src/personal-agent-tools.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function setupObsidianTool() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-obsidian-home-"));
  tempDirs.push(homeDir);
  const vaultDir = path.join(homeDir, "Documents", "main");
  fs.mkdirSync(vaultDir, { recursive: true });
  process.env.HOME = homeDir;

  const [tool] = createObsidianTools();
  if (!tool) {
    throw new Error("Missing obsidian tool");
  }

  return { tool, vaultDir };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("personal-agent-tools obsidian", () => {
  it("creates, prints, appends, and overwrites notes through direct filesystem I/O", async () => {
    const { tool, vaultDir } = setupObsidianTool();
    const noteName = "Planning/Daily/2026-03-13";
    const largeContent = `# Daily Note\n\n${"large-content ".repeat(900)}`;

    await expect(tool.handler({
      command: `create '${noteName}' --vault main`,
      content: largeContent,
    })).resolves.toEqual({
      result: "Created Planning/Daily/2026-03-13.md",
    });

    const notePath = path.join(vaultDir, "Planning", "Daily", "2026-03-13.md");
    expect(fs.readFileSync(notePath, "utf8")).toBe(largeContent);
    await expect(tool.handler({
      command: `print '${noteName}' --vault main`,
    })).resolves.toEqual({
      result: largeContent,
    });

    await expect(tool.handler({
      command: `create '${noteName}' --vault main`,
      content: "duplicate",
    })).resolves.toEqual({
      result: "Error: Note already exists: Planning/Daily/2026-03-13.md",
    });

    await expect(tool.handler({
      command: `create '${noteName}' --vault main --append`,
      content: "\n- appended",
    })).resolves.toEqual({
      result: "Appended Planning/Daily/2026-03-13.md",
    });
    expect(fs.readFileSync(notePath, "utf8")).toBe(`${largeContent}\n- appended`);

    await expect(tool.handler({
      command: `create '${noteName}' --vault main --overwrite`,
      content: "replacement",
    })).resolves.toEqual({
      result: "Overwrote Planning/Daily/2026-03-13.md",
    });
    expect(fs.readFileSync(notePath, "utf8")).toBe("replacement");
  });

  it("searches vault content recursively, case-insensitively, and skips hidden directories", async () => {
    const { tool, vaultDir } = setupObsidianTool();

    fs.mkdirSync(path.join(vaultDir, "Planning"), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, ".hidden", "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, "Planning", "Focus.md"),
      "First line\nSearch target appears here\nLast line\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(vaultDir, "Planning", "Secondary.md"),
      "search TARGET also appears here\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(vaultDir, ".obsidian", "Ignored.md"),
      "search target should not appear\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(vaultDir, ".hidden", "nested", "Ignored.md"),
      "search target should also not appear\n",
      "utf8",
    );

    await expect(tool.handler({
      command: "search-content 'search target' --vault main",
    })).resolves.toEqual({
      result: [
        "Planning/Focus.md:2: Search target appears here",
        "Planning/Secondary.md:1: search TARGET also appears here",
      ].join("\n"),
    });
  });

  it("prints, edits, and deletes YAML frontmatter keys", async () => {
    const { tool, vaultDir } = setupObsidianTool();
    const notePath = path.join(vaultDir, "Records", "Health.md");
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(
      notePath,
      [
        "---",
        "date: 2026-04-24",
        "areas:",
        "  - Health",
        "---",
        "# Health",
        "",
        "Body",
      ].join("\n"),
      "utf8",
    );

    await expect(tool.handler({
      command: "frontmatter 'Records/Health' --vault main --print",
    })).resolves.toEqual({
      result: "date: 2026-04-24\nareas:\n  - Health",
    });

    await expect(tool.handler({
      command: "frontmatter 'Records/Health' --vault main --edit --key 'status' --value 'active'",
    })).resolves.toEqual({
      result: "Updated frontmatter key 'status'",
    });
    expect(fs.readFileSync(notePath, "utf8")).toContain("status: active");

    await expect(tool.handler({
      command: "frontmatter 'Records/Health' --vault main --delete --key 'date'",
    })).resolves.toEqual({
      result: "Deleted frontmatter key 'date'",
    });
    const updated = fs.readFileSync(notePath, "utf8");
    expect(updated).not.toContain("date:");
    expect(updated).toContain("areas:");
    expect(updated).toContain("status: active");
  });

  it("moves, lists, and deletes notes on disk", async () => {
    const { tool, vaultDir } = setupObsidianTool();
    const sourcePath = path.join(vaultDir, "Inbox", "Start.md");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "hello", "utf8");

    await expect(tool.handler({
      command: "move 'Inbox/Start' 'Planning/Archive/Done' --vault main",
    })).resolves.toEqual({
      result: "Moved Inbox/Start.md -> Planning/Archive/Done.md",
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(path.join(vaultDir, "Planning", "Archive", "Done.md"), "utf8")).toBe("hello");

    await expect(tool.handler({
      command: "list 'Planning' --vault main",
    })).resolves.toEqual({
      result: "Archive/",
    });
    await expect(tool.handler({
      command: "list 'Planning/Archive' --vault main",
    })).resolves.toEqual({
      result: "Done.md",
    });

    await expect(tool.handler({
      command: "delete 'Planning/Archive/Done' --vault main",
    })).resolves.toEqual({
      result: "Deleted Planning/Archive/Done.md",
    });
    expect(fs.existsSync(path.join(vaultDir, "Planning", "Archive", "Done.md"))).toBe(false);
  });
});
