import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { GovernanceChecker } from "../src/governance.js";
import { TangoStorage } from "../src/storage.js";
import { assembleV2SystemPrompt } from "../src/system-prompt.js";
import { loadV2AgentConfig } from "../src/v2-config-loader.js";

interface BulletinAttachmentFixture {
  id: string;
  filename: string;
  mimeType: string;
}

interface BulletinMessageFixture {
  id: string;
  internalDate: string;
  subject: string;
  attachments: BulletinAttachmentFixture[];
  pdfText: string;
}

interface WardBulletinFixture {
  mailbox: BulletinMessageFixture[];
  expected: {
    selectedMessageId: string;
    selectedAttachmentId: string;
    requiredReadOnlyCommands: string[];
    forbiddenMutationPattern: string;
    program: Record<string, string>;
  };
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readFixture(): WardBulletinFixture {
  return JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "packages", "core", "test", "fixtures", "porter-ward-bulletin-gmail.json"),
      "utf8",
    ),
  ) as WardBulletinFixture;
}

function newestRelevantBulletin(messages: BulletinMessageFixture[]): BulletinMessageFixture {
  const relevant = messages
    .filter((message) => /church bullet(?:in|ing)|ward bulletin|sacrament meeting program/iu.test(message.subject))
    .filter((message) => message.attachments.some((attachment) => attachment.mimeType === "application/pdf"))
    .sort((left, right) => Date.parse(right.internalDate) - Date.parse(left.internalDate));

  const newest = relevant[0];
  if (!newest) {
    throw new Error("fixture did not contain a relevant PDF bulletin message");
  }
  return newest;
}

function extractProgramFields(pdfText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of pdfText.split(/\r?\n/u)) {
    const match = /^([^:]+):\s*(.*)$/u.exec(line);
    if (match) {
      fields[match[1]!] = match[2]!;
    }
  }
  return fields;
}

function isReadOnlyGmailCommand(command: string): boolean {
  const head = command.trim().toLowerCase().split(/\s+/u);
  if (head[0] !== "gmail") return false;

  return (
    (head[1] === "messages" && ["search", "list"].includes(head[2] ?? ""))
    || head[1] === "get"
    || head[1] === "attachment"
    || (head[1] === "thread" && head[2] !== "modify")
  );
}

describe("Porter ward bulletin workflow", () => {
  it("keeps Porter on governed read-only Gmail access", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "porter.yaml"));
    const googleServer = config.mcpServers.find((server) => server.name === "google");

    expect(googleServer).toMatchObject({
      command: "node",
      args: ["packages/core/dist/mcp-proxy.js", "google"],
      env: {
        ALLOWED_TOOL_IDS: "gog_email",
        WORKER_ID: "church-assistant",
      },
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-porter-bulletin-"));
    tempDirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
    storage.close();

    const db = new DatabaseSync(path.join(dir, "tango.sqlite"), { readonly: true });
    const checker = new GovernanceChecker(db);

    expect(checker.hasPermission("worker:church-assistant", "gog_email", "read")).toBe(true);
    expect(checker.hasPermission("worker:church-assistant", "gog_email", "write")).toBe(false);

    db.close();
  });

  it("documents the live prompt contract for typo-tolerant latest PDF bulletin retrieval", () => {
    const prompt = assembleV2SystemPrompt({
      systemPromptFile: "agents/assistants/porter/soul.md",
    }, { repoRoot });
    const compactPrompt = prompt.replace(/\s+/gu, " ");

    // The repo persona base carries the GENERIC contract; the congregation-
    // specific framing (tradition, exact subject typos, program field layout)
    // lives in the profile overlay (see docs/guides/profile-model.md).
    expect(prompt).toContain("Meeting Bulletin Workflow");
    expect(prompt).toContain("gmail messages search");
    expect(prompt).toContain("--account <bulletin-mailbox>");
    expect(compactPrompt).toContain("newest relevant bulletin by message date");
    expect(prompt).toContain("gmail get <messageId> --format full");
    expect(prompt).toContain("gmail attachment <messageId> <attachmentId>");
    expect(prompt).toContain("Preserve exact program fields");
    expect(compactPrompt).toContain("verbatim substring from the PDF text");
    expect(compactPrompt).toContain("overwrite or update it from the current PDF");
    expect(prompt).toContain("attachment_search");
    expect(prompt).toContain("Email is read-only");
    // Repo base must NOT carry the installation's congregation-specific terms.
    expect(prompt).not.toContain("Church Bulleting");
  });

  it("fixtures the latest typo-subject PDF bulletin and exact program field preservation", () => {
    const fixture = readFixture();
    const newest = newestRelevantBulletin(fixture.mailbox);
    const latestAttachment = newest.attachments.find((attachment) => attachment.id === fixture.expected.selectedAttachmentId);

    expect(newest.id).toBe(fixture.expected.selectedMessageId);
    expect(newest.subject).toContain("Church Bulleting");
    expect(latestAttachment).toMatchObject({
      filename: "ward-sacrament-meeting-2026-06-07.pdf",
      mimeType: "application/pdf",
    });

    expect(extractProgramFields(newest.pdfText)).toEqual(fixture.expected.program);
  });

  it("keeps the fixture workflow read-only and mutation-negative", () => {
    const fixture = readFixture();
    const forbidden = new RegExp(fixture.expected.forbiddenMutationPattern, "iu");

    expect(fixture.expected.requiredReadOnlyCommands).toEqual([
      expect.stringMatching(/^gmail messages search\b/iu),
      expect.stringMatching(/^gmail get\b/iu),
      expect.stringMatching(/^gmail attachment\b/iu),
    ]);

    for (const command of fixture.expected.requiredReadOnlyCommands) {
      expect(isReadOnlyGmailCommand(command)).toBe(true);
      expect(command).not.toMatch(forbidden);
    }

    expect(fixture.expected.requiredReadOnlyCommands.join("\n")).toContain("Church Bulleting");
    expect(fixture.expected.requiredReadOnlyCommands.every((command) => command.includes("--account member.ward@example.test"))).toBe(true);
    expect(fixture.expected.requiredReadOnlyCommands.join("\n")).toContain(".pdf");
  });
});
