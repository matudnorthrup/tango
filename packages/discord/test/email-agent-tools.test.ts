import { describe, expect, it } from "vitest";
import {
  buildThreadBrief,
  buildTimelineOneLiner,
  extractDriveLinks,
  parseGogSearchJson,
  parseGogThreadJson,
  resolveEmailAccount,
} from "../src/email-agent-tools.js";

describe("resolveEmailAccount", () => {
  it("allows [redacted]", () => {
    expect(resolveEmailAccount("[redacted]")).toBe("[redacted]");
  });

  it("firewalls [redacted]", () => {
    expect(() => resolveEmailAccount("[redacted]")).toThrow(/firewalled/i);
  });

  it("rejects other accounts", () => {
    expect(() => resolveEmailAccount("other@example.com")).toThrow(/only support/i);
  });
});

describe("extractDriveLinks", () => {
  it("extracts docs and drive links from email bodies", () => {
    const links = extractDriveLinks(
      "See https://docs.google.com/document/d/abc123/edit and https://drive.google.com/file/d/xyz789/view",
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.kind).toBe("document");
    expect(links[1]?.kind).toBe("drive_file");
  });
});

describe("parseGogThreadJson", () => {
  it("parses messages array and builds timeline one-liners", () => {
    const raw = JSON.stringify({
      threadId: "t1",
      messages: [
        {
          id: "m1",
          from: "Kerri <kerri@example.com>",
          to: "[redacted] <[redacted]>",
          subject: "Budget review",
          date: "2026-05-28T10:00:00Z",
          body: "First message in thread.",
        },
        {
          id: "m2",
          from: "[redacted] <[redacted]>",
          to: "Kerri <kerri@example.com>",
          subject: "Re: Budget review",
          date: "2026-05-28T11:00:00Z",
          body: "<p>Latest reply with <a href=\"https://docs.google.com/spreadsheets/d/sheet42/edit\">sheet</a>.</p>",
          attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 1200, id: "att1" }],
        },
      ],
    });

    const messages = parseGogThreadJson(raw);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.attachments[0]?.needs_extraction).toBe(true);

    const brief = buildThreadBrief({
      threadId: "t1",
      account: "[redacted]",
      messages,
      sessionId: "test-session",
      writeBody: () => {},
    });

    expect(brief.subject).toBe("Re: Budget review");
    expect(brief.latest.message_id).toBe("m2");
    expect(brief.timeline).toHaveLength(2);
    expect(brief.drive_links[0]?.kind).toBe("spreadsheet");
    expect(brief.latest_body_path).toContain("/tmp/tango-attachments/test-session/thread-t1-latest.txt");
  });

  it("parses live gog Gmail API thread JSON with payload headers and multipart bodies", () => {
    const plainBody = "Hi [redacted],\n\nHappy Friday!";
    const plainBodyData = Buffer.from(plainBody, "utf8").toString("base64");
    const raw = JSON.stringify({
      thread: {
        id: "t-simple",
        messages: [
          {
            id: "m-simple",
            internalDate: "1780085178000",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "Stephanie Bridges <steph@eventhive.biz>" },
                { name: "To", value: "[redacted] [redacted] <[redacted]>" },
                { name: "Subject", value: "Happy Friday!" },
                { name: "Date", value: "Fri, 29 May 2026 15:26:18 -0500" },
              ],
              body: { data: plainBodyData },
            },
          },
        ],
      },
    });

    const messages = parseGogThreadJson(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toContain("Stephanie Bridges");
    expect(messages[0]?.subject).toBe("Happy Friday!");
    expect(messages[0]?.date).toBe("Fri, 29 May 2026 15:26:18 -0500");
    expect(messages[0]?.body).toContain("Happy Friday!");

    const brief = buildThreadBrief({
      threadId: "t-simple",
      account: "[redacted]",
      messages,
      sessionId: "test-gmail-api",
      writeBody: () => {},
    });

    expect(brief.subject).toBe("Happy Friday!");
    expect(brief.latest.from).toContain("Stephanie Bridges");
    expect(brief.participants).toContain("Stephanie Bridges <steph@eventhive.biz>");
  });
});

describe("buildTimelineOneLiner", () => {
  it("strips html and truncates long bodies", () => {
    const long = "word ".repeat(40);
    const oneLiner = buildTimelineOneLiner(`<p>${long}</p>`, "html");
    expect(oneLiner.endsWith("…")).toBe(true);
    expect(oneLiner.length).toBeLessThanOrEqual(140);
  });
});

describe("parseGogSearchJson", () => {
  it("normalizes search results into thread cards", () => {
    const raw = JSON.stringify({
      messages: [
        {
          threadId: "t9",
          id: "m9",
          from: "Jeremy <jeremy@example.com>",
          subject: "Werqwise update",
          date: "2026-05-20",
          snippet: "Quick update on Werqwise.",
        },
      ],
    });
    const cards = parseGogSearchJson(raw);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.thread_id).toBe("t9");
    expect(cards[0]?.subject).toBe("Werqwise update");
  });
});
